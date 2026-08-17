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
import { rasterField, levelDepthEps, type RasterField, type RasterGrid } from "./rasterEngrave";
import { toolSweptFloor } from "./toolProfile";
import type { ReliefEncoding } from "./reliefEncoding";
import { DEFAULTS, type CAMOperation } from "./types";

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

// ---------------------------------------------------------------------------
// The same question on a GRID: rest machining a relief.
//
// A relief has no boundary to offset. It is a depth field, and every operation
// on it — the gouge correction, the roughing staircase, the 3-D preview — is a
// sweep over cells. So the polygon machinery above cannot serve it, and the STL
// plan's "rest pass via restRegions()" would need a grid-to-polygon contour step
// that does not exist anywhere in this codebase.
//
// It does not need one. The identity at the top of this file,
//
//     reached = (region ⊖ R) ⊕ R
//
// is the morphological OPENING, and an opening is defined on a greyscale field
// exactly as it is on a set. `toolSweptFloor` is that opening on the depth
// field: erode by the tool's profile (where the tip may go — which is the gouge
// correction the relief path already runs), then dilate by it again (what the
// body swept from there). Two tools, two floors, and what one left for the other
// is the difference.
// ---------------------------------------------------------------------------

/**
 * Why the leftover must be a difference of OPENINGS and not of tip fields.
 *
 * The tempting version subtracts the two tool-contact fields, which are already
 * computed and sitting right there. It is wrong in both directions, and the
 * error is large enough to see on any real model:
 *
 * - **It invents stock.** A ⌀6 end mill's TIP cannot come within 3 mm of a wall,
 *   so a tip-field difference reports standing stock in a 3 mm band along every
 *   wall in the model — stock the cutter's flank removed on its way past. On a
 *   smooth dome on a slab, a shape with nothing whatever for a second tool to do,
 *   it claims **48.6% of the model**.
 * - **It also MISSES stock.** Beside a narrow slot only the small tool enters,
 *   that tool's own tip cannot descend at the shoulders either — but its flank
 *   clears them. Measured on a printed spring, the tip difference finds 11.1%
 *   where the opening difference finds 55.6%.
 *
 * Over 220 real objects the tip difference covers a median of 2.6x the area
 * while being smaller than the truth on the models with the narrowest features.
 * `REST=1 npx tsx scripts/stl-relief-probe.ts <dir>` reproduces both columns, and
 * `RESTSHOW=1` draws the two masks on a shape carrying both cases at once.
 */
export type ReliefRest =
  | { kind: "off" }
  /** `restToolDiameter` is set but is not larger than this operation's own tool. */
  | { kind: "not-larger"; prevDiameter: number }
  /** The previous tool reached everything this one could take. */
  | { kind: "clear"; prevDiameter: number }
  | {
      kind: "mask";
      prevDiameter: number;
      /** Whether cell (row, col) holds stock the previous tool could not reach. */
      keep(row: number, col: number): boolean;
      cells: number;
      total: number;
      /** Deepest leftover found, mm — the bite the finish pass would otherwise take. */
      maxLeftoverMM: number;
    };

/**
 * The previous roughing tool is taken to be a FLAT end mill.
 *
 * Only its diameter is recorded (see `restToolDiameter`), matching the pocket
 * rest pass, and a flat mill is what roughs. The assumption is also the safe one
 * if it is wrong: a ball-nose of the same diameter reaches further down into a
 * valley than a flat one, so assuming flat under-states what the previous pass
 * cleared, and the cost of that is cutting a little air rather than driving into
 * stock this operation was told had gone.
 */
const PREV_TOOL_TYPE = "end-mill" as const;

/**
 * What a smaller tool should still cut after a bigger one has roughed a relief.
 *
 * ## The threshold is derived, not tuned
 *
 * Roughing steps down in flat planes, so at every cell it DID reach it already
 * leaves the finish pass up to one `stepdown` of material. A cell holding less
 * than that is no worse than the model's ordinary worst case, and a second
 * roughing pass there buys nothing the finish pass is not already doing
 * everywhere else. More than one stepdown means the previous tool did not reach
 * the cell at all — that is geometry, not staircase.
 *
 * So the threshold is `stepdown` itself, and there is no new constant to
 * calibrate. Measured over 220 real objects it fires on 174 of them, at a median
 * of 3.0% of cells. That is an operating point on a smooth curve, not a
 * boundary: a quarter of a stepdown fires on 200 objects and 6.8% of cells, four
 * stepdowns on 96 objects and 0.2%, with no gap anywhere between. Nothing in the
 * distribution picks the number — the roughing staircase does.
 */
export function reliefRest(
  field: RasterField,
  op: CAMOperation,
  maxDepth: number,
  stepdown: number,
  finishAllowance = 0,
): ReliefRest {
  const prevDiameter = op.restToolDiameter ?? 0;
  if (!(prevDiameter > 0)) return { kind: "off" };
  if (prevDiameter <= op.diameter) return { kind: "not-larger", prevDiameter };
  if (field.cols <= 0 || field.rows.length === 0 || !(maxDepth > 0)) return { kind: "off" };

  // Both floors on THIS operation's grid — which is the rest tool's own stepover,
  // finer than the pass being rested. Sizing it off the ROUGHING tool instead
  // hides every feature narrower than that tool's stepover, which is exactly the
  // range a rest pass exists for; the probe made that mistake first, and the
  // corpus numbers moved by a third when it was corrected.
  const mine = toolSweptFloor(field, op, maxDepth, finishAllowance);
  const prev = toolSweptFloor(
    field,
    { toolType: PREV_TOOL_TYPE, diameter: prevDiameter },
    maxDepth,
    finishAllowance,
  );

  const { cols, rows } = field;
  const nRows = rows.length;
  const raw = new Uint8Array(cols * nRows);
  let maxLeftoverMM = 0;
  for (let r = 0; r < nRows; r++) {
    const a = mine.rows[r].levels;
    const b = prev.rows[r].levels;
    for (let c = 0; c < cols; c++) {
      const left = (a[c] - b[c]) * maxDepth;
      if (left > maxLeftoverMM) maxLeftoverMM = left;
      if (left > stepdown) raw[r * cols + c] = 1;
    }
  }

  // Grow by one cell, 8-connected. Two reasons, and the first is load-bearing:
  // the sweep treats a sample as standing for its whole cell and measures to the
  // cell's NEAR edge, which is the conservative reading for the erosion (it
  // protects walls) but the optimistic one for the dilation — it credits the
  // previous tool with sweeping half a cell further than centre-to-centre would.
  // A cell of slack in the mask hands that back. Second, it puts this pass's edge
  // inside material the previous one really did cut rather than exactly on the
  // seam, so no witness ridge is left standing along the join.
  const mask = new Uint8Array(cols * nRows);
  let cells = 0;
  for (let r = 0; r < nRows; r++)
    for (let c = 0; c < cols; c++) {
      let hit = 0;
      for (let dr = -1; dr <= 1 && !hit; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= nRows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          if (cc < 0 || cc >= cols) continue;
          if (raw[rr * cols + cc]) {
            hit = 1;
            break;
          }
        }
      }
      if (hit) {
        mask[r * cols + c] = 1;
        cells++;
      }
    }

  if (cells === 0) return { kind: "clear", prevDiameter };
  return {
    kind: "mask",
    prevDiameter,
    keep: (row, col) => mask[row * cols + col] === 1,
    cells,
    total: cols * nRows,
    maxLeftoverMM,
  };
}

/**
 * The surface the relief-rough operations ahead of a finish op have already left
 * on an image, at the finish field's own resolution — the in-process stock floor
 * the finish pass should not re-cut.
 *
 * This is {@link reliefRest} generalised from "one named prior tool" to "every
 * relief-rough op ahead of me in the job that cut this image". Each rough op
 * leaves a STAIRCASE, not its swept surface: it clears flat planes at
 * `−p·stepdown` clamped to `−(maxDepth − allowance)`, so a cell's floor is the
 * deepest such plane still at or above what the rough tool's body swept there.
 * The swept surface is the greyscale OPENING (`toolSweptFloor`), never the tip
 * field — see the {@link reliefRest} header for why the tip field is wrong in
 * both directions.
 *
 * Cost is why the opening runs on the ROUGH op's own coarse grid (pitch =
 * stepover × diameter) and is then upsampled, never computed on the finish grid:
 * a 300 mm relief at 0.1 mm pitch is 9M cells and a ⌀12 footprint is a 60-cell
 * radius (measured ~4 min); the coarse grid is a handful of cells wide. The
 * floor is staircase-quantised and opening-smoothed, so it is piecewise-constant
 * at the coarse scale; upsampling takes the least-removed (lowest-level, i.e.
 * highest-surface) neighbour, so any sub-pitch error lands on the safe side — the
 * finish may cut a little air along a staircase edge, never leave a bump.
 *
 * With no prior rough op the stock is the uncut blank (all levels 0), returned on
 * `finishField`'s grid. That is what keeps a single-op relief byte-identical to
 * the G-code this code posted before the stock model existed.
 *
 * Scope: every prior `relief-rough` op is modelled as FULL coverage. A
 * rest-machined rough (one with `restToolDiameter`, which cuts only its rest
 * mask) would be over-credited here — its opening is stamped everywhere it
 * reaches, not just where the mask said to cut — which makes the finish believe
 * up to a stepdown more stock is gone than is, and can under-cut. Threading the
 * rest mask through is deferred (see the plan's open question on the three-op
 * chain); until then a rest rough ahead of a finish is mis-modelled in the
 * UNSAFE direction (it can under-cut), so treat it as unsupported rather than
 * silently wrong.
 */
export function reliefStockFloor(
  finishField: RasterField,
  grid: RasterGrid,
  enc: ReliefEncoding,
  priorOps: CAMOperation[],
  maxDepth: number,
): RasterField {
  const blank = (): RasterField => ({
    cols: finishField.cols,
    colPitch: finishField.colPitch,
    rowPitch: finishField.rowPitch,
    levelStep: finishField.levelStep,
    rows: finishField.rows.map((row) => ({ y: row.y, levels: new Float32Array(finishField.cols) })),
  });

  if (priorOps.length === 0 || !(maxDepth > 0) || finishField.rows.length === 0) return blank();

  const floor = blank();
  for (const op of priorOps) {
    if (op.type !== "relief-rough") continue;
    const allowance = Math.max(0, op.finishAllowance ?? 0);
    const stepdown = op.stepdown > 0 ? op.stepdown : maxDepth;
    // The coarse pitch the rough op itself resamples to (reliefRoughImage).
    const pitch = Math.max(0.05, (op.stepover > 0 ? op.stepover : DEFAULTS.stepover) * op.diameter);
    const coarse = rasterField(grid, enc.field(pitch, pitch));
    if (coarse.rows.length === 0) continue;
    const swept = toolSweptFloor(coarse, { toolType: op.toolType, diameter: op.diameter }, maxDepth, allowance);
    stampStaircase(floor, swept, stepdown, maxDepth, allowance);
  }
  return floor;
}

/**
 * Quantise a rough op's swept surface to its staircase planes and stamp it into
 * `floor`, upsampling from the coarse grid onto the finish grid. Each finish cell
 * reads the least-removed (lowest-level) coarse neighbour it overlaps, so a cell
 * is only ever credited with LESS removal than really happened — the finish may
 * cut a little air along a staircase edge, never leave stock standing.
 */
function stampStaircase(
  floor: RasterField,
  swept: RasterField,
  stepdown: number,
  maxDepth: number,
  allowance: number,
): void {
  const { cols, colPitch, rowPitch, rows } = floor;
  const maxCut = maxDepth - allowance; // deepest plane −(maxDepth − allowance)
  const eps = levelDepthEps(maxDepth); // levels are float32 — same tolerance the emitter uses
  const cCols = swept.cols;
  const cRows = swept.rows.length;
  const cColPitch = swept.colPitch;
  const cRowPitch = swept.rowPitch;
  for (let r = 0; r < rows.length; r++) {
    const y = rows[r].y;
    const cr0 = clampIdx(Math.floor((y - rowPitch / 2) / cRowPitch), cRows);
    const cr1 = clampIdx(Math.floor((y + rowPitch / 2 - 1e-9) / cRowPitch), cRows);
    for (let c = 0; c < cols; c++) {
      const x0 = c * colPitch;
      const x1 = (c + 1) * colPitch;
      const cc0 = clampIdx(Math.floor(x0 / cColPitch), cCols);
      const cc1 = clampIdx(Math.floor((x1 - 1e-9) / cColPitch), cCols);
      let s = Infinity;
      for (let cr = cr0; cr <= cr1; cr++)
        for (let cc = cc0; cc <= cc1; cc++) {
          const v = swept.rows[cr].levels[cc];
          if (v < s) s = v;
        }
      // Deepest staircase plane still at-or-above the swept surface. A cell whose
      // swept surface reaches the roughing's floor takes the clamped final plane
      // `−maxCut`, not a `stepdown` multiple.
      const depthMM = s * maxDepth;
      const planeMM = depthMM >= maxCut - eps ? maxCut : Math.floor(depthMM / stepdown) * stepdown;
      const plane = planeMM / maxDepth;
      if (plane > rows[r].levels[c]) rows[r].levels[c] = plane;
    }
  }
}

function clampIdx(i: number, n: number): number {
  return i < 0 ? 0 : i >= n ? n - 1 : i;
}
