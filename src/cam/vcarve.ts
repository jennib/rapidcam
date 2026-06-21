/**
 * V-carving by offset peeling.
 *
 * True V-carving cuts a closed region to a *depth that varies with how far each
 * point is from the region wall*: a V-bit sitting `r` mm (radially) in from the
 * boundary reaches depth `r / tan(½·vAngle)` (sharp tip). At the region's medial
 * axis — the locus equidistant from the walls — the two flanks meet and the cut
 * comes to a crisp ridge/point. That is what makes carved text and signs read
 * sharply instead of looking routed with a constant-width groove.
 *
 * Rather than compute the medial axis explicitly (Voronoi of the boundary
 * segments — robust but heavy), we approximate it by *peeling inward*: inset the
 * filled region by r = step, 2·step, 3·step, … Each inset contour is the set of
 * points exactly `r` from the wall, so we cut it at `depth(r) = r / tan(½·vAngle)`.
 * As `r` grows the insets shrink and finally vanish — and where they collapse to
 * a line or a point, that *is* the medial axis, so the sharp ridge falls out for
 * free with no Voronoi code. Holes (letter counters) are handled because the
 * inset is computed on the whole polygon-with-holes via Clipper.
 *
 *        wall                         wall
 *   ──────┐                           ┌──────   Z=0 (surface)
 *          \   r=step  (shallow)     /
 *           \  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  /     ← inset @ depth(step)
 *            \   r=2·step          /
 *             \ ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  /        ← inset @ depth(2·step)
 *              \                  /
 *               \________________/         ← medial axis: insets vanish (deepest)
 *
 * `maxDepth` clamps the cut: once `depth(r)` reaches it, deeper insets are all
 * cut at `maxDepth`, leaving a flat floor cleared by the (now concentric) inset
 * contours — i.e. wide areas bottom out instead of running the bit ever deeper.
 *
 * The result is a list of {@link VCarvePass}es, each a depth + the contours to
 * follow at that depth. The G-code generator and the preview rasterizer both
 * consume this, so they agree on the cut.
 */

import type { Vec2 } from "../core/vec2";
import { inflatePathsD, JoinType, EndType } from "clipper2-ts";
import { signedArea } from "./offset";
import { pointInPolygon } from "./loops";
import type { CAMOperation } from "./types";

/** A closed region to carve: a solid outer ring with zero or more hole rings. */
export interface CarveRegion {
  outer: Vec2[];
  holes: Vec2[][];
}

/**
 * Group a flat list of closed contours (e.g. a glyph's outlines, where letter
 * counters like the hole in "O" or "e" arrive as separate contours) into solid
 * regions with holes, using even–odd nesting: a contour nested inside an odd
 * number of others is a hole; even (0, 2, …) is solid. Each hole is attached to
 * the smallest solid ring that encloses it. Robust to fonts' inconsistent
 * winding because nesting is decided by containment, not orientation.
 */
export function groupContoursIntoRegions(contours: Vec2[][]): CarveRegion[] {
  const rings = contours.filter((c) => c.length >= 3);
  const containedBy = (ring: Vec2[]): Vec2[][] =>
    rings.filter((other) => other !== ring && pointInPolygon(ring[0], other));
  const meta = rings.map((ring) => ({
    ring,
    depth: containedBy(ring).length,
    area: Math.abs(signedArea(ring)),
  }));
  const solids = meta.filter((m) => m.depth % 2 === 0);
  const holes = meta.filter((m) => m.depth % 2 === 1);
  return solids.map((s) => ({
    outer: s.ring,
    holes: holes
      .filter(
        (h) =>
          pointInPolygon(h.ring[0], s.ring) &&
          // Attach to the *smallest* enclosing solid, so a dot inside a counter
          // inside a letter lands on the right ring.
          !solids.some(
            (s2) => s2 !== s && s2.area < s.area && pointInPolygon(h.ring[0], s2.ring),
          ),
      )
      .map((h) => h.ring),
  }));
}

export interface VCarvePass {
  /** Cut depth for every contour in this pass — negative mm (Z below surface). */
  depth: number;
  /** Closed contours to follow at `depth`; may include several disjoint rings. */
  loops: Vec2[][];
}

export interface VCarveParams {
  /** V-bit included angle (total, not half), degrees. */
  vAngle: number;
  /** Max cut depth magnitude, mm (positive). 0 or less = unlimited (carve to the spine). */
  maxDepth: number;
  /** Radial inset between successive passes, mm. Smaller = smoother floor, more passes. */
  stepMM: number;
  /** Miter limit passed to Clipper when insetting (keeps sharp corners sharp). */
  miterLimit?: number;
}

/**
 * Derive the peel solver's params from a v-carve operation: the V-bit `vAngle`
 * sets the slope, `|depth|` is the floor (max) depth, and `vStep` (default 0.4)
 * is the radial pitch. Shared by the G-code generator and the preview rasterizer
 * so the two agree on the cut.
 */
export function vcarveParamsForOp(op: CAMOperation): VCarveParams {
  return {
    vAngle: op.vAngle ?? 60,
    maxDepth: Math.abs(op.depth),
    stepMM: op.vStep && op.vStep > 0 ? op.vStep : 0.4,
  };
}

/**
 * Inset a filled region (outer ring minus holes) inward by `d` mm. Orientation is
 * normalized so Clipper treats `holes` as holes regardless of how they arrived:
 * outer CCW (+area), holes CW (−area). Returns the inset rings (may be several,
 * or none once the region is fully consumed).
 */
function insetRegion(outer: Vec2[], holes: Vec2[][], d: number, miterLimit: number): Vec2[][] {
  const o = signedArea(outer) >= 0 ? outer : [...outer].reverse();
  const hs = holes.map((h) => (signedArea(h) <= 0 ? h : [...h].reverse()));
  const result = inflatePathsD([o, ...hs], -d, JoinType.Miter, EndType.Polygon, miterLimit);
  return result.map((path) => path.map((pt) => ({ x: pt.x, y: pt.y })));
}

/** Bounding-box diagonal of a polygon — used to bound the peel iteration count. */
function diag(pts: Vec2[]): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return Math.hypot(maxX - minX, maxY - minY);
}

/**
 * Build the V-carve passes for one closed region (outer ring + hole rings).
 * Passes run shallow → deep. Returns an empty array if the inputs can't carve
 * (degenerate region, non-positive step, or a flat/zero V-angle).
 */
export function vcarveRegion(outer: Vec2[], holes: Vec2[], params: VCarveParams): VCarvePass[];
export function vcarveRegion(outer: Vec2[], holes: Vec2[][], params: VCarveParams): VCarvePass[];
export function vcarveRegion(outer: Vec2[], holes: Vec2[][] | Vec2[], params: VCarveParams): VCarvePass[] {
  // Normalize the `holes` overload: accept either Vec2[][] (rings) or a single ring.
  const holeRings: Vec2[][] = Array.isArray(holes) && holes.length > 0 && "x" in (holes[0] as Vec2)
    ? [holes as Vec2[]]
    : (holes as Vec2[][]);

  const { vAngle, maxDepth, stepMM } = params;
  const miterLimit = params.miterLimit ?? 4;
  if (outer.length < 3 || stepMM <= 0) return [];

  const tanHalf = Math.tan((vAngle / 2) * (Math.PI / 180));
  if (tanHalf <= 1e-6) return []; // 0° (or 180°) — not a usable V-bit

  const passes: VCarvePass[] = [];
  // Inward offset of a bounded region must vanish within ~half the diagonal; cap
  // the loop generously so a degenerate offset can never spin forever.
  const maxIters = Math.ceil(diag(outer) / stepMM) + 4;

  for (let i = 1; i <= maxIters; i++) {
    const r = i * stepMM;
    const loops = insetRegion(outer, holeRings, r, miterLimit);
    if (loops.length === 0) break; // reached the medial axis — fully carved
    let depth = r / tanHalf;
    if (maxDepth > 0 && depth > maxDepth) depth = maxDepth;
    passes.push({ depth: -depth, loops });
  }
  return passes;
}
