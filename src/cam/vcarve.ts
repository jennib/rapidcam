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
 * A flat-tip (engraving) bit shifts this: its tip flat of radius `tipDiameter/2`
 * rides the surface, so a point `r` from the wall only drops below the surface
 * once `r` exceeds the flat radius — `depth(r) = max(0, r − tipR) / tan(½·vAngle)`.
 * So the peel *starts* at the flat radius: insets shallower than that would only
 * score the surface.
 *
 * `maxDepth` clamps the cut: once `depth(r)` reaches it, deeper insets are all
 * cut at `maxDepth`, leaving a flat floor cleared by the (now concentric) inset
 * contours — i.e. wide areas bottom out instead of running the bit ever deeper.
 *
 * ## Why the peel step is not simply `stepMM`
 *
 * Peeling on a *fixed* pitch is blind to anything thinner than `2·step`: such a
 * feature is already gone from the very first inset, so no contour ever runs
 * along it and the bit never visits it — it is not cut shallow, it is not cut at
 * all. At the 0.4 mm default that silently swallowed whole letters of ~9 mm text
 * (Roboto "A" bottoms out at r = 0.38 mm) and the crossbars of letters whose
 * stems survived, while the survivors got a single ring — one constant depth,
 * i.e. a routed groove rather than a carve.
 *
 * So the pitch is capped per region: we first find `rMax`, the largest inset
 * radius the region survives (its deepest point / medial ridge), and peel with
 * `min(stepMM, rMax / MIN_PEEL_RINGS)`. `stepMM` stays the ceiling — big regions
 * peel exactly as before — but a region only 0.4 mm deep is sampled across its
 * own flank instead of being skipped over. The last ring sits exactly on `rMax`,
 * so the spine is cut to true depth instead of stopping a whole step short.
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
          !solids.some((s2) => s2 !== s && s2.area < s.area && pointInPolygon(h.ring[0], s2.ring)),
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
  /**
   * Flat-tip diameter of the V-bit, mm (0 = perfectly sharp). An engraving bit
   * with a flat tip doesn't reach the surface at the wall: the flat (radius
   * `tipDiameter/2`) carries the cut, so a point `r` from the wall only goes
   * below the surface once `r` exceeds the flat radius. Default 0.
   */
  tipDiameter?: number;
  /** Miter limit passed to Clipper when insetting (keeps sharp corners sharp). */
  miterLimit?: number;
  /**
   * Sink the whole V profile this far below the surface, mm (positive, default 0).
   *
   * This is the INLAY GLUE GAP, and it is the one number that makes a plug fit.
   * With a start depth `g`, reaching depth `d` needs only
   * `r = (d − g)·tan(½·vAngle)` instead of `d·tan(½·vAngle)`, so the standing
   * material is **narrower by exactly `g·tan(½·vAngle)` at every depth**. A male
   * plug cut this way seats on its FLANKS with a void at the apex — which is
   * where the glue goes, and why the plug can bottom out at all.
   *
   * It lives here rather than in `inlay.ts` because `depth(r)` is stated once,
   * below; a second copy of the V law is exactly the drift this codebase keeps
   * paying for.
   */
  startDepth?: number;
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
    tipDiameter: op.tipDiameter,
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

/**
 * Rings the peel puts across a region's deepest flank when `stepMM` is coarser
 * than the region can afford. Eight is enough to keep a stroke's walls sloping
 * (rather than one constant-depth groove) and to guarantee that a feature down
 * to ~1/4 of the region's deepest point still collects rings of its own.
 */
const MIN_PEEL_RINGS = 8;

/** Hard floor on the peel pitch, so a hairline region can't run away in Clipper calls. */
const MIN_STEP_MM = 0.01;

/**
 * The largest radius in `(lo, hi]` whose inset still survives — the region's
 * deepest point. `lo` is known to survive (0 = the un-inset region), `hi` is
 * known to vanish; bisection pins the collapse to ~1/16000 of the bracket.
 */
function deepestInset(
  outer: Vec2[],
  holes: Vec2[][],
  lo: number,
  hi: number,
  miterLimit: number,
): number {
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (insetRegion(outer, holes, mid, miterLimit).length > 0) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Bounding-box diagonal of a polygon — used to bound the peel iteration count. */
function diag(pts: Vec2[]): number {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
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
export function vcarveRegion(
  outer: Vec2[],
  holes: Vec2[][] | Vec2[],
  params: VCarveParams,
): VCarvePass[] {
  // Normalize the `holes` overload: accept either Vec2[][] (rings) or a single ring.
  const holeRings: Vec2[][] =
    Array.isArray(holes) && holes.length > 0 && "x" in (holes[0] as Vec2)
      ? [holes as Vec2[]]
      : (holes as Vec2[][]);

  const { vAngle, maxDepth, stepMM } = params;
  const miterLimit = params.miterLimit ?? 4;
  if (outer.length < 3 || stepMM <= 0) return [];

  const tanHalf = Math.tan((vAngle / 2) * (Math.PI / 180));
  if (tanHalf <= 1e-6) return []; // 0° (or 180°) — not a usable V-bit

  // Flat-tip bit: the tip flat (radius tipR) rides the surface, so only the part
  // of the radial distance beyond the flat goes below the surface.
  const tipR = Math.max(0, (params.tipDiameter ?? 0) / 2);
  const startDepth = Math.max(0, params.startDepth ?? 0);

  // Peel on the requested pitch first. This is the answer for any region deep
  // enough to afford it, and it brackets the collapse for everything else.
  // Inward offset of a bounded region must vanish within ~half the diagonal; cap
  // the loop generously so a degenerate offset can never spin forever.
  const maxIters = Math.ceil(diag(outer) / stepMM) + 4;
  const coarse = new Map<number, Vec2[][]>();
  let rLast = 0; // deepest radius known to survive
  let rGone = tipR + stepMM; // shallowest radius known (or assumed) to vanish
  for (let i = 1; i <= maxIters; i++) {
    const r = tipR + i * stepMM;
    const loops = insetRegion(outer, holeRings, r, miterLimit);
    if (loops.length === 0) {
      rGone = r; // the region is consumed somewhere in (rLast, r]
      break;
    }
    coarse.set(r, loops);
    rLast = r;
    rGone = r + stepMM;
  }

  // Where the peel actually bottoms out — the medial ridge, which lies *inside*
  // the last whole step (and inside the first one for a region thinner than the
  // pitch, where the loop above never got a single ring).
  const rMax = deepestInset(outer, holeRings, rLast, rGone, miterLimit);
  // Only the radius beyond the tip flat cuts below the surface; a region that
  // bottoms out inside the flat can only be scored, not carved.
  const flank = rMax - tipR;
  if (flank <= 1e-9) return [];

  const step = Math.max(MIN_STEP_MM, Math.min(stepMM, flank / MIN_PEEL_RINGS));
  // Whole rings on the pitch, then one final ring pinned to the ridge itself.
  // The 1/4-step deadband keeps that last ring from landing on top of its
  // predecessor when the collapse happens to sit just past a whole step.
  const wholeRings = Math.max(0, Math.floor((flank - step / 4) / step));

  const passes: VCarvePass[] = [];
  // Below the floor the rings are clearing a flat bottom, not sampling the V
  // flank, so they keep the *requested* stepover: a fine flank pitch must not
  // turn a bottomed-out area into a needlessly dense spiral.
  let lastFloorR = -Infinity;
  for (let i = 1; i <= wholeRings + 1; i++) {
    const ridge = i > wholeRings;
    const r = ridge ? rMax : tipR + i * step;
    let depth = startDepth + (r - tipR) / tanHalf;
    const clamped = maxDepth > 0 && depth > maxDepth;
    if (clamped) depth = maxDepth;
    if (clamped && !ridge && r - lastFloorR < stepMM - 1e-9) continue;
    const loops = coarse.get(r) ?? insetRegion(outer, holeRings, r, miterLimit);
    if (loops.length === 0) continue;
    if (clamped) lastFloorR = r;
    passes.push({ depth: -depth, loops });
  }
  return passes;
}
