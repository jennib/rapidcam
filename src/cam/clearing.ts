/**
 * Contour-parallel (offset) pocket clearing.
 *
 * Instead of zig-zag raster rows — which slot at full width on direction
 * reversals and must lift/rapid every time a row crosses an island — this
 * generates concentric offset loops of the cuttable region. Because the loops
 * are produced by repeatedly shrinking the region (outer wall inward, island
 * walls outward) with Clipper2, they naturally wrap around islands with NO
 * lifting, and the region splitting/merging topology is handled for free.
 *
 * Loops are then ordered innermost-first (so the final pass is the outer wall,
 * for a clean finish) and linked with short feed moves wherever the gap is
 * already cleared by the previous loop's cut swath; otherwise the tool lifts.
 */
import type { Vec2 } from "../core/vec2";
import { inflatePathsD, differenceD, JoinType, EndType, FillRule } from "clipper2-ts";
import { signedArea } from "./offset";

/** One closed loop to cut at the current depth, plus how to get to it. */
export interface ClearingMove {
  /** Closed-loop vertices, rotated so [0] is the entry point (nearest to the previous move). */
  loop: Vec2[];
  /**
   * true  → feed straight from the previous loop's end into this loop (the gap
   *         is already cleared by the previous swath, so it's safe at depth).
   * false → lift to safe Z, rapid over, and ramp/plunge back down.
   */
  link: boolean;
}

const toV = (path: { x: number; y: number }[]): Vec2[] => path.map((p) => ({ x: p.x, y: p.y }));
const ccwize = (pts: Vec2[]): Vec2[] => (signedArea(pts) >= 0 ? pts : [...pts].reverse());
const dist2 = (a: Vec2, b: Vec2): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/** Offset a set of region paths (with holes) by `delta` mm. */
function inflate(paths: Vec2[][], delta: number): Vec2[][] {
  if (paths.length === 0) return [];
  return inflatePathsD(paths, delta, JoinType.Miter, EndType.Polygon, 4).map(toV);
}

/** Nearest point ON the loop's edges (not just a vertex) to p. */
function nearestPointOnLoop(loop: Vec2[], p: Vec2): { point: Vec2; seg: number; d2: number } {
  let best = { point: loop[0], seg: 0, d2: Infinity };
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const point = { x: a.x + t * dx, y: a.y + t * dy };
    const d = dist2(point, p);
    if (d < best.d2) best = { point, seg: i, d2: d };
  }
  return best;
}

/** Rotate a closed loop so it starts at `point`, which lies on edge `seg`. */
function rotateLoopAtPoint(loop: Vec2[], seg: number, point: Vec2): Vec2[] {
  const rotated = [point, ...loop.slice(seg + 1), ...loop.slice(0, seg + 1)];
  // Drop a duplicate if the entry point coincides with the next vertex.
  return rotated;
}

/** Segment a→b intersects edge c→d (proper or touching). */
function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
}

function segmentCrossesAnyPolygon(a: Vec2, b: Vec2, polys: Vec2[][]): boolean {
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      if (segmentsIntersect(a, b, poly[j], poly[i])) return true;
    }
  }
  return false;
}

/**
 * Decide whether feeding straight from `a` (on the just-cut loop) to `b` (on the
 * next loop) is safe at depth. Because `a` lies on the previous loop, every point
 * of the segment is within |a−b| of `a`; so if |a−b| ≤ toolR the whole segment
 * lies inside that loop's cut swath (already cleared). The only extra risks are
 * the straight hop clipping an un-cut island wall or poking outside the pocket
 * wall, so we also reject segments that cross a keep-out or the outer boundary.
 * When unsure, the caller lifts — lifting is always safe.
 */
function linkIsSafe(
  a: Vec2, b: Vec2, toolR: number, boundaries: Vec2[][], keepouts: Vec2[][],
): boolean {
  if (dist2(a, b) > toolR * toolR) return false;
  if (segmentCrossesAnyPolygon(a, b, keepouts)) return false;
  if (segmentCrossesAnyPolygon(a, b, boundaries)) return false;
  return true;
}

/**
 * Generate ordered contour-parallel clearing moves for a pocket.
 *
 * @param outer    Raw pocket boundary polygon (any winding).
 * @param holes    Raw island polygons (any winding); the tool stays clear of these.
 * @param toolR    Tool radius (mm).
 * @param stepover Radial step between concentric loops (mm), 0 < stepover.
 * @returns Ordered loops with link flags, or [] if the pocket is too small.
 */
export function contourParallelClear(
  outer: Vec2[], holes: Vec2[][], toolR: number, stepover: number,
): ClearingMove[] {
  if (outer.length < 3 || toolR <= 0 || stepover <= 0) return [];

  // Cuttable region = (wall inset by toolR) minus (islands grown by toolR).
  const boundaries = inflate([ccwize(outer)], -toolR);
  if (boundaries.length === 0) return []; // smaller than the tool

  const keepouts = holes.flatMap((h) => (h.length >= 3 ? inflate([ccwize(h)], toolR) : []));
  const areaPaths = keepouts.length > 0
    ? differenceD(boundaries, keepouts, FillRule.NonZero).map(toV)
    : boundaries;
  if (areaPaths.length === 0) return [];

  // Concentric rings: shrink the whole region by k·stepover until nothing remains.
  // Re-offset from the original each step to avoid cumulative rounding drift.
  const rings: { k: number; loop: Vec2[] }[] = [];
  // Safety cap from the bounding-box diagonal so we always terminate.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of areaPaths.flat()) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const cap = Math.ceil(Math.hypot(maxX - minX, maxY - minY) / stepover) + 2;
  for (let k = 0; k <= cap; k++) {
    const off = k === 0 ? areaPaths : inflate(areaPaths, -k * stepover);
    if (off.length === 0) break;
    for (const loop of off) if (loop.length >= 3) rings.push({ k, loop });
  }
  if (rings.length === 0) return [];

  // Order innermost-first (largest k) via greedy nearest-neighbour, so the very
  // last loop cut is the outer wall (ring 0) — best surface finish. We link to
  // the nearest POINT on the next loop (≈ one stepover away, radially), which is
  // inside the previous loop's cut swath and therefore safe to feed across.
  const remaining = rings.slice().sort((a, b) => b.k - a.k);
  const moves: ClearingMove[] = [];
  let cur: Vec2 | null = null;

  while (remaining.length > 0) {
    let pick = 0;
    let pickNearest = nearestPointOnLoop(remaining[0].loop, cur ?? remaining[0].loop[0]);
    if (cur) {
      let bestD = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const np = nearestPointOnLoop(remaining[i].loop, cur);
        if (np.d2 < bestD) { bestD = np.d2; pick = i; pickNearest = np; }
      }
    }
    const chosen = remaining.splice(pick, 1)[0];
    const loop: Vec2[] = cur ? rotateLoopAtPoint(chosen.loop, pickNearest.seg, pickNearest.point) : chosen.loop.slice();
    const link = cur !== null && linkIsSafe(cur, loop[0], toolR, boundaries, keepouts);
    moves.push({ loop, link });
    cur = loop[0]; // a closed loop returns to its start
  }

  return moves;
}
