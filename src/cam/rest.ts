/**
 * Rest machining: clear only what a bigger tool left behind.
 *
 * Rough a pocket with a ⌀6 cutter and its corners keep a 3mm radius of standing
 * stock, because that is the shape of the cutter. The usual answer is a second
 * pass with a smaller tool — but running the whole pocket again wastes most of
 * the time cutting air that is already cleared. Rest machining cuts the leftover
 * and nothing else.
 *
 * The leftover is exactly a **morphological opening**. What a tool of radius R
 * can reach is the region eroded by R (where its centre may sit) and then
 * dilated by R (what its edge sweeps); everything else is untouched:
 *
 *     reached = (region ⊖ R) ⊕ R          rest = region − reached
 *
 * That is exact polygon arithmetic, not an approximation, and it is worth
 * insisting on: the app's other model of leftover material is the 3D preview's
 * height map, whose cell size adapts to a memory budget, so contours taken from
 * it would carry a resolution error that changes with the size of the job.
 *
 * For a 90° corner the answer is checkable by hand — the sliver a round tool
 * leaves has area R²(1 − π/4) — which is what the tests assert against.
 */

import type { Vec2 } from "../core/vec2";
import { inflatePathsD, differenceD, intersectD, JoinType, EndType, FillRule } from "clipper2-ts";
import { signedArea } from "./offset";

const toV = (path: { x: number; y: number }[]): Vec2[] => path.map((p) => ({ x: p.x, y: p.y }));
const ccwize = (pts: Vec2[]): Vec2[] => (signedArea(pts) >= 0 ? pts : [...pts].reverse());

function inflate(paths: Vec2[][], delta: number): Vec2[][] {
  const valid = paths.filter((p) => p.length >= 3);
  if (valid.length === 0) return [];
  // Round joins, not miter: this is modelling the sweep of a round cutter, and a
  // mitered corner would claim the tool reached into a sharp point it cannot.
  return inflatePathsD(valid, delta, JoinType.Round, EndType.Polygon, 4).map(toV);
}

/** One leftover area to clear, as a boundary with its own islands. */
export interface RestRegion {
  outer: Vec2[];
  holes: Vec2[][];
}

/**
 * Areas of `outer` (minus `holes`) that a cutter of radius `prevToolR` could not
 * reach. Returns [] when that tool could clear the lot — which is the common
 * answer for a round pocket, and means there is nothing to rest-machine.
 *
 * `extraAllowance` accounts for stock the earlier operation deliberately left on
 * the walls (its finishing allowance): the earlier cut stopped that much short,
 * so that much more is still standing.
 */
export function restRegions(
  outer: Vec2[],
  holes: Vec2[][],
  prevToolR: number,
  extraAllowance = 0,
): RestRegion[] {
  if (outer.length < 3 || prevToolR <= 0) return [];

  const islands = holes.filter((h) => h.length >= 3).map(ccwize);
  const area = islands.length
    ? differenceD([ccwize(outer)], islands, FillRule.NonZero).map(toV)
    : [ccwize(outer)];
  if (area.length === 0) return [];

  // Where the previous cutter's centre could go, then what its edge swept.
  const effectiveR = prevToolR + extraAllowance;
  const centres = inflate(area, -effectiveR);
  if (centres.length === 0) {
    // The earlier tool never fit at all, so nothing was cleared and the whole
    // pocket is still standing.
    return regionsFromPaths(area);
  }
  const reached = inflate(centres, prevToolR);
  if (reached.length === 0) return regionsFromPaths(area);

  const rest = differenceD(area, reached, FillRule.NonZero).map(toV);
  return regionsFromPaths(rest).filter(isWorthCutting);
}

/**
 * Minimum half-thickness of standing stock worth a second pass, mm.
 *
 * Curves reach this code as polylines, and every chord of that polyline leaves a
 * hair of stock the round tool didn't quite touch — a 64-sided ⌀30 circle sheds
 * 0.38mm² of slivers about 0.018mm thick. Those are an artefact of how the
 * circle was written down, not material, and cutting them means driving the
 * machine round a pocket that was already finished. Below a twentieth of a
 * millimetre is under any sane machining tolerance and well over the
 * discretisation noise.
 */
const MIN_REST_HALF_THICKNESS = 0.05;

/** Whether a leftover region is anywhere thicker than the noise floor. */
function isWorthCutting(r: RestRegion): boolean {
  const paths = [ccwize(r.outer), ...r.holes.map(ccwize)];
  return inflate(paths, -MIN_REST_HALF_THICKNESS).length > 0;
}

/**
 * Group a flat Clipper result into outer boundaries with their holes. Clipper
 * returns outers counter-clockwise and holes clockwise once the fill rule has
 * been applied, so orientation is what separates them; a hole is assigned to the
 * smallest outer that contains it.
 */
function regionsFromPaths(paths: Vec2[][]): RestRegion[] {
  const usable = paths.filter((p) => p.length >= 3);
  const outers = usable.filter((p) => signedArea(p) >= 0);
  const holes = usable.filter((p) => signedArea(p) < 0);
  const regions: RestRegion[] = outers.map((o) => ({ outer: o, holes: [] }));

  for (const h of holes) {
    const pt = h[0];
    let best = -1;
    let bestArea = Infinity;
    for (let i = 0; i < regions.length; i++) {
      const a = Math.abs(signedArea(regions[i].outer));
      if (a < bestArea && pointInPolygon(pt, regions[i].outer)) {
        best = i;
        bestArea = a;
      }
    }
    if (best >= 0) regions[best].holes.push(h);
  }
  return regions;
}

function pointInPolygon(pt: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Where the cutter's CENTRE may go to take the leftover: every position within a
 * tool radius of standing stock, less the positions that would put the cutter
 * through a wall.
 *
 * A rest region is not a pocket. Its inner edge is the air the roughing pass
 * made, and the centre is free to sit out there — only the cutting edge has to
 * reach the stock. That's why the sliver itself can't be handed to the ordinary
 * clearing code, which insets whatever it is given by a tool radius to find the
 * centres: a 3.5mm² corner sliver inset by 1.5mm is nothing at all, so a ⌀3
 * cutter "didn't fit" in a corner it plainly fits.
 *
 * Returning centres rather than a padded boundary is also what keeps the pass
 * short. Growing each sliver by a tool diameter and clearing THAT as if it were
 * a pocket covers the stock, but sweeps a ring of already-empty air around every
 * corner: it posted 268 moves where re-cutting the entire pocket took 238, which
 * is a rest pass that has stopped being worth running.
 */
export function restCentreRegions(
  outer: Vec2[],
  holes: Vec2[][],
  prevToolR: number,
  toolR: number,
  extraAllowance = 0,
): RestRegion[] {
  const rest = restRegions(outer, holes, prevToolR, extraAllowance);
  if (rest.length === 0 || toolR <= 0) return [];

  const islands = holes.filter((h) => h.length >= 3).map(ccwize);
  const pocket = islands.length
    ? differenceD([ccwize(outer)], islands, FillRule.NonZero).map(toV)
    : [ccwize(outer)];
  // Where the cutter may legally be at all, for this pocket and this tool.
  const legal = inflate(pocket, -toolR);
  if (legal.length === 0) return [];

  const out: RestRegion[] = [];
  for (const r of rest) {
    const paths = [ccwize(r.outer), ...r.holes.map(ccwize)];
    const reach = inflate(paths, toolR);
    if (reach.length === 0) continue;
    const centres = intersect(reach, legal);
    if (centres.length === 0) continue;
    out.push(...regionsFromPaths(centres));
  }
  return out;
}

function intersect(a: Vec2[][], b: Vec2[][]): Vec2[][] {
  const va = a.filter((p) => p.length >= 3);
  const vb = b.filter((p) => p.length >= 3);
  if (va.length === 0 || vb.length === 0) return [];
  // Clipper's own intersection. Expressing it as A − (A − B) instead looked
  // tidy and cost 0.16mm: the two differences each round to Clipper's decimal
  // precision, and the error landed OUTSIDE the pocket wall — a gouge, on the
  // one boundary this clip exists to protect.
  return intersectD(va, vb, FillRule.NonZero).map(toV);
}

/** Total area of a set of rest regions, mm² — used to decide if it's worth cutting. */
export function restArea(regions: RestRegion[]): number {
  let a = 0;
  for (const r of regions) {
    a += Math.abs(signedArea(r.outer));
    for (const h of r.holes) a -= Math.abs(signedArea(h));
  }
  return a;
}
