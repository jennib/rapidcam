/**
 * The tool's own SHAPE, and what a sampled depth field means once you account
 * for it.
 *
 * A relief op point-samples its image and commands the tip to `−level·depth` at
 * each dot. That is the height of the surface *directly under the tip*, and it
 * is the whole story only for a needle. A real bit has flanks: a ball-nose's
 * body sits `R − √(R²−d²)` above its tip at lateral offset `d`, a V-bit's sits
 * `d/tan(θ/2)` above it. Drive the tip to the sampled depth beside a wall and
 * the flank ploughs straight through the wall — silently, posting clean G-code.
 *
 * Measured on a 16×16 field with one vertical wall (any logo, or text rasterised
 * to an image), 3 mm deep, ⌀3 ball-nose: **2.905 mm of overcut, 97% of the part
 * depth.** Smooth photo reliefs barely trip it, which is why it went unnoticed —
 * the feature's usual input is what hides it.
 *
 * ## The correction
 *
 * The tip height is a MAX OVER THE TOOL FOOTPRINT, not a point sample:
 *
 *     z(xc,yc) = max over {(x,y) : d ≤ reach} of ( Z(x,y) − height(d) )
 *
 * i.e. a greyscale dilation of the height field by the inverted tool profile.
 * That is opencamlib's drop-cutter evaluated in image space, so it is the same
 * algorithm on pre-sampled input rather than an approximation of it — the split
 * Blender CAM documents as exact vs. non-exact mode.
 *
 * Everything here works in LEVEL units (0 = surface, 1 = full depth), because
 * that is what {@link RasterField} carries and what all four consumers read:
 * `reliefImage`/`reliefRoughImage` (G-code) and `rasRelief`/`rasReliefRough`
 * (the 3-D preview). One resolver, four callers — the shape `reliefSpacing`
 * established, so the preview cannot disagree with the program it previews.
 * In level units the max becomes a min:
 *
 *     level'(c,r) = min over footprint of ( level + height(d)/maxDepth )
 *
 * ## Two decisions worth stating
 *
 * **A sample stands for its whole cell.** The field is a box-average of the
 * source, so the distance that matters between the tip and a neighbouring
 * sample is to the NEAR EDGE of that cell, not to its centre. Centre-to-centre
 * leaves a wall lying between two samples unprotected: on the measurement
 * above it still gouged 0.30 mm, where near-edge lands on the by-hand answer
 * (0.086 mm) exactly. Both are conservative in the right direction — near-edge
 * is simply the tighter reading of what the samples say.
 *
 * **The field's border is replicated, not walled.** Outside the image there is
 * no model, so the edge sample extends outward. Treating "outside" as uncut
 * stock would lift every relief ever cut by a band of `R` all the way round —
 * inventing a wall the model never described. Replicating is the heightfield
 * convention (Vectric, Carveco, Blender CAM) and leaves the border behaviour
 * exactly as it has always been.
 *
 * ## Not applied to a halftone
 *
 * A V-carve halftone has no surface to protect: the groove width IS the tone,
 * and neighbouring dots overlapping each other is the printing mechanism, not a
 * defect. Dilating it would flatten the screen it exists to cut. {@link isHalftone}
 * is the same predicate `reliefSpacing` screens on.
 */

import { halfAngleRad, isHalftone, type VBitGeometry } from "./halftone";
import type { RasterField, RasterLevelRow } from "./rasterEngrave";
import { DEFAULTS, type CAMOperation, type ToolType } from "./types";

/** The geometry a tool's profile depends on. A resolved op satisfies it. */
export interface ToolShape extends VBitGeometry {
  toolType?: ToolType;
  /** Drill point angle, degrees (included, like `vAngle`). */
  tipAngle?: number;
}

/**
 * A tool's cutting envelope, as seen from its tip.
 *
 * `height(d)` is how far the tool body sits ABOVE the tip at lateral offset `d`
 * mm — `Infinity` past the tool, meaning "no constraint out here". This is the
 * same law {@link ../cam/stockRasterizer} stamps the 3-D preview with; both read
 * it from here so a third copy cannot drift into existence.
 */
export interface ToolProfile {
  height(d: number): number;
  /**
   * The widest offset that can still bind for a cut `maxDepth` deep, mm.
   *
   * Past it either the tool has ended, or its flank has climbed further than the
   * deepest the field goes — and a constraint of `S − height` with `height >
   * maxDepth` can never beat the tip's own sample, which is ≥ −maxDepth. Bounds
   * the footprint, so a shallow relief doesn't pay for a big bit's full radius.
   */
  reach(maxDepth: number): number;
}

/**
 * Ball-nose flank height above the tip at lateral offset `d`.
 * Below the equator the hemisphere is the lowest part of the body; past `R` the
 * shank has ended and nothing constrains.
 */
export function ballHeight(d: number, R: number): number {
  if (d >= R) return d > R ? Infinity : R;
  return R - Math.sqrt(R * R - d * d);
}

/**
 * V-cone flank height above the tip at lateral offset `d`. A flat tip (radius
 * `tipR`) cuts flat-bottomed out to its own edge before the cone starts, which
 * is why an engraving bit cannot render the lightest tones (see `halftonePlan`).
 */
export function coneHeight(d: number, tanHalf: number, tipR = 0): number {
  return d <= tipR ? 0 : (d - tipR) / tanHalf;
}

/** The cutting envelope of the tool an operation is running. */
export function toolProfile(t: ToolShape): ToolProfile {
  const R = Math.max(0, t.diameter / 2);
  switch (t.toolType) {
    case "ball-nose":
      return {
        height: (d) => ballHeight(d, R),
        // Solve R − √(R²−d²) = maxDepth for d; a cut deeper than the ball is
        // radius-bound instead.
        reach: (maxDepth) =>
          maxDepth >= R ? R : Math.sqrt(Math.max(0, R * R - (R - maxDepth) ** 2)),
      };
    case "v-bit": {
      const tanHalf = Math.tan(halfAngleRad(t));
      const tipR = Math.min(R, Math.max(0, t.tipDiameter ?? 0) / 2);
      return {
        height: (d) => (d > R ? Infinity : coneHeight(d, tanHalf, tipR)),
        reach: (maxDepth) => Math.min(R, tipR + maxDepth * tanHalf),
      };
    }
    case "drill": {
      // A drill's point is conical only out to its own radius — past that the
      // flutes run a straight shank (the same clamp `stampVCone` takes).
      const tanHalf = Math.tan(
        halfAngleRad({ vAngle: t.tipAngle ?? DEFAULTS.tipAngle, diameter: t.diameter }),
      );
      return {
        height: (d) => (d > R ? Infinity : coneHeight(d, tanHalf)),
        reach: (maxDepth) => Math.min(R, maxDepth * tanHalf),
      };
    }
    default:
      // end-mill, and anything unrecognised: a flat disc. No flank to climb, so
      // the dilation is a plain max over the disc — which is the whole of what
      // relief ROUGHING needs.
      return { height: (d) => (d > R ? Infinity : 0), reach: () => R };
  }
}

/**
 * The level field a relief op's TOOL TIP must actually follow.
 *
 * `finishAllowance` (roughing only) is backed off the target FIRST, then the
 * dilation runs on the backed-off surface — not the other way round. The order
 * matters once the tool has a flank: clamping the target at the stock top and
 * then dilating are not interchangeable operations, and dilating first quietly
 * lets the tool plunge where the allowance said it must not.
 *
 * Returns `field` itself (not a copy) when there is nothing to correct.
 */
export function toolContactField(
  field: RasterField,
  op: CAMOperation,
  maxDepth: number,
  finishAllowance = 0,
): RasterField {
  if (isHalftone(op)) return field; // the groove width IS the tone — see the header
  return toolTipField(field, op, maxDepth, finishAllowance);
}

/**
 * {@link toolContactField} without the operation — the tip field for a tool
 * considered purely as a shape. Rest machining asks this about a tool no
 * operation is running any more ("the ⌀6 that roughed this"), which has no op to
 * screen for halftoning.
 */
export function toolTipField(
  field: RasterField,
  tool: ToolShape,
  maxDepth: number,
  finishAllowance = 0,
): RasterField {
  if (field.cols <= 0 || field.rows.length === 0 || !(maxDepth > 0)) return field;
  const backoff = Math.min(1, Math.max(0, finishAllowance) / maxDepth);
  return dilate(field, toolProfile(tool), maxDepth, backoff);
}

/**
 * The floor a tool actually LEAVES BEHIND — where its flank swept, not where its
 * tip went.
 *
 * {@link toolContactField} answers "how deep may the tip go at this cell", and it
 * is tempting to read that as the finished floor. It is not, and the gap between
 * the two is a tool radius wide. Beside a 5 mm step a ⌀6 end mill's tip cannot
 * descend within 3 mm of the wall — its contact level there is the top of the
 * step — yet the cut floor at those cells is the bottom, because the cutter
 * reached them sideways from a tip position 3 mm away. Read the contact field as
 * the floor and every wall in the model grows a 3 mm band of imaginary standing
 * stock.
 *
 * The floor is therefore the greyscale **opening** of the field by the tool: where
 * the tip may go, then what the body swept from there.
 *
 *     floor = (Z ⊖ tool) ⊕ tool
 *
 * which is the identity {@link ../cam/rest} states for polygons —
 * `reached = (region ⊖ R) ⊕ R` — on a grid instead of a boundary. The two
 * halves are the same sweep run in opposite directions, so this shares
 * {@link sweep} with the erosion rather than restating the footprint arithmetic.
 *
 * Takes a {@link ToolShape} rather than an operation because the caller's tool is
 * usually a HYPOTHETICAL one — "the ⌀6 that roughed this" — that no operation in
 * the job need still be running.
 */
export function toolSweptFloor(
  field: RasterField,
  tool: ToolShape,
  maxDepth: number,
  finishAllowance = 0,
): RasterField {
  if (field.cols <= 0 || field.rows.length === 0 || !(maxDepth > 0)) return field;
  const tip = toolTipField(field, tool, maxDepth, finishAllowance);
  return expand(tip, toolProfile(tool), maxDepth);
}

/**
 * Greyscale erosion of the level field by the tool profile (a dilation of the
 * depth field — levels run the other way).
 *
 * Cost. The footprint is `O(R²)` cells and a plain sweep of it per cell is what
 * makes this the obvious performance trap. Two things keep it off that path:
 *
 * 1. `profile.height` is evaluated ONCE PER FOOTPRINT OFFSET into a table, never
 *    per cell. No trigonometry — no arithmetic at all beyond an add and a
 *    compare — runs inside the per-cell loop.
 * 2. A box-min computed in `O(n)` (sliding-window minima, two passes) bounds
 *    every candidate the footprint could still offer, so the sweep stops the
 *    moment no remaining offset can improve on what it already has. Anywhere the
 *    field is locally flattest — which is most of a photo relief, and all of an
 *    untouched background — that is one comparison and out.
 *
 * The bound is an upper bound on what the footprint can yield, so cutting the
 * sweep short can only ever leave the tip HIGHER than the exact answer, never
 * lower. A wrong bound would cost time, not material.
 */
function dilate(
  field: RasterField,
  profile: ToolProfile,
  maxDepth: number,
  backoff: number,
): RasterField {
  const { cols, colPitch, rowPitch, levelStep, rows } = field;
  const nRows = rows.length;

  // Back the allowance off first (roughing): the level roughing must reach, with
  // 0 meaning "leave this at the surface".
  const src: Float32Array[] = rows.map((row) => {
    if (backoff <= 0) return row.levels;
    const out = new Float32Array(cols);
    for (let c = 0; c < cols; c++) out[c] = row.levels[c] > backoff ? row.levels[c] - backoff : 0;
    return out;
  });

  const out = sweep(src, cols, nRows, colPitch, rowPitch, profile, maxDepth, levelStep);
  if (!out) return backoff > 0 ? withLevels(field, rows, src) : field;
  return { ...field, rows: rows.map((row, r) => ({ y: row.y, levels: out[r] })) };
}

/**
 * Greyscale DILATION of the level field — the other half of the opening, and the
 * same sweep by duality: `max(L − pen) = −min(−L + pen)`. Negating the field and
 * running the erosion is not a trick to save typing; it is the only way the two
 * directions cannot drift apart, which is this project's standing defect class.
 *
 * No quantisation here. A swept floor is only ever COMPARED — to another tool's
 * floor, to decide what is left standing — and never commanded as a Z, so it has
 * no run-merging to protect and rounding it would only lose resolution in the
 * comparison.
 */
function expand(field: RasterField, profile: ToolProfile, maxDepth: number): RasterField {
  const { cols, colPitch, rowPitch, rows } = field;
  const neg = rows.map((row) => {
    const out = new Float32Array(cols);
    for (let c = 0; c < cols; c++) out[c] = -row.levels[c];
    return out;
  });
  const out = sweep(neg, cols, rows.length, colPitch, rowPitch, profile, maxDepth, 0);
  if (!out) return field;
  for (const levels of out) for (let c = 0; c < cols; c++) levels[c] = -levels[c];
  return { ...field, rows: rows.map((row, r) => ({ y: row.y, levels: out[r] })) };
}

/**
 * The footprint sweep itself: `out[c] = min over the footprint of (src + pen)`.
 *
 * Sign-agnostic on purpose — every bound below is stated in terms of `src` as
 * given, so feeding it a negated field yields the dilation (see {@link expand}).
 * Returns `null` when the tool is finer than one cell, i.e. nothing to correct.
 *
 * `levelStep > 0` lands each corrected cell back on the ladder the field was
 * quantised to, or the equal-Z run merging downstream stops merging and the
 * program grows by orders of magnitude. Round DOWN — shallower is the safe side
 * — and leave a cell no neighbour reached bit-identical, so a relief the tool
 * can already cut posts exactly the G-code it posted before.
 *
 * **It has to happen HERE, inside the loop, against the float64 `best`.** Doing
 * it as a second pass over the output looks equivalent and is not: `best` is
 * `src + pen` with a float64 penalty, so storing it first rounds it to float32,
 * and a `best` that was strictly below `own` can round back onto it. The second
 * pass then reads them as equal, skips the quantisation, and leaves the cell one
 * whole level step DEEPER than this code has ever cut it — 11.8 µm on a 3 mm
 * relief, in the un-conservative direction, on 3 cells out of 38.5 million.
 * Measured, not reasoned about; `scripts/relief-dilation-cost.ts` is the sibling
 * probe and the guard is in `test/toolProfile.test.ts`.
 *
 * `levelStep = 0` means no quantisation, which is what a swept floor wants: it is
 * only ever compared, never commanded, so it has no run merging to protect.
 */
function sweep(
  src: Float32Array[],
  cols: number,
  nRows: number,
  colPitch: number,
  rowPitch: number,
  profile: ToolProfile,
  maxDepth: number,
  levelStep: number,
): Float32Array[] | null {
  const reach = profile.reach(maxDepth);
  // A sample stands for its whole cell, so a cell is in reach when its NEAR EDGE
  // is (see the header). Half a pitch of slack, in both axes.
  const L = colPitch > 0 ? Math.floor(reach / colPitch + 0.5) : 0;
  const K = rowPitch > 0 ? Math.floor(reach / rowPitch + 0.5) : 0;
  if (L <= 0 && K <= 0) return null; // tool finer than one cell

  // --- the footprint, priced once ------------------------------------------
  // pen[j][i] = what the tool's flank costs (in level units) at the offset j
  // rows up/down, i columns left/right. Non-decreasing along both axes, which is
  // what lets the sweeps below break instead of continuing.
  const stride = L + 1;
  const pen = new Float64Array((K + 1) * stride);
  const bandLen = new Int32Array(K + 1);
  let maxBand = -1;
  for (let j = 0; j <= K; j++) {
    const vy = Math.max(0, j * rowPitch - rowPitch / 2);
    let len = 0;
    for (let i = 0; i <= L; i++) {
      const vx = Math.max(0, i * colPitch - colPitch / 2);
      const d = Math.hypot(vx, vy);
      if (d > reach) break;
      const h = profile.height(d);
      if (!Number.isFinite(h)) break;
      pen[j * stride + i] = h / maxDepth;
      len = i + 1;
    }
    bandLen[j] = len;
    if (len === 0) break; // vy only grows — no later band is in reach either
    maxBand = j;
  }
  if (maxBand < 0 || (maxBand === 0 && bandLen[0] <= 1)) return null;

  // --- the early-out bound --------------------------------------------------
  const boxMin = boxMinimum(src, cols, nRows, L, K);

  // --- the sweep ------------------------------------------------------------
  const outRows: Float32Array[] = new Array(nRows);
  for (let r = 0; r < nRows; r++) {
    const levels = new Float32Array(cols);
    const centre = src[r];
    const bmBase = r * cols;
    for (let c = 0; c < cols; c++) {
      const own = centre[c];
      let best = own;
      const bm = boxMin[bmBase + c];
      for (let j = 0; j <= maxBand; j++) {
        const base = j * stride;
        if (best <= bm + pen[base]) break; // no band from here on can improve
        const hi = src[r + j >= nRows ? nRows - 1 : r + j];
        const lo = src[r - j < 0 ? 0 : r - j];
        const bl = bandLen[j];
        for (let i = 0; i < bl; i++) {
          const p = pen[base + i];
          if (best <= bm + p) break; // nor can any wider offset in this band
          const cl = c - i < 0 ? 0 : c - i;
          const cr = c + i >= cols ? cols - 1 : c + i;
          let v = hi[cl] + p;
          if (v < best) best = v;
          v = hi[cr] + p;
          if (v < best) best = v;
          v = lo[cl] + p;
          if (v < best) best = v;
          v = lo[cr] + p;
          if (v < best) best = v;
        }
      }
      levels[c] =
        levelStep > 0 && best !== own ? Math.floor(best / levelStep + 1e-9) * levelStep : best;
    }
    outRows[r] = levels;
  }
  return outRows;
}

/** Same field, different level arrays (used when only the allowance moved). */
function withLevels(field: RasterField, rows: RasterLevelRow[], src: Float32Array[]): RasterField {
  return { ...field, rows: rows.map((row, r) => ({ y: row.y, levels: src[r] })) };
}

/**
 * Minimum level over the `(2L+1) × (2K+1)` box around every cell, clipped at the
 * edges — which is the same thing as replicating them, since a clamped index
 * lands on a cell the box already contains.
 *
 * Two sliding-window passes with a monotonic deque: `O(n)`, independent of the
 * window size. This is only the sweep's stopping bound, so it is allowed to be
 * loose; it is not allowed to be too LOW, and a true minimum never is.
 */
function boxMinimum(
  src: Float32Array[],
  cols: number,
  nRows: number,
  L: number,
  K: number,
): Float32Array {
  const acrossRows = new Float32Array(cols * nRows);
  const dq = new Int32Array(Math.max(cols, nRows));

  for (let r = 0; r < nRows; r++) {
    const row = src[r];
    let head = 0,
      tail = 0;
    for (let i = 0; i < cols + L; i++) {
      if (i < cols) {
        while (tail > head && row[dq[tail - 1]] >= row[i]) tail--;
        dq[tail++] = i;
      }
      if (i >= L) {
        const c = i - L;
        while (dq[head] < c - L) head++;
        acrossRows[r * cols + c] = row[dq[head]];
      }
    }
  }

  const out = new Float32Array(cols * nRows);
  for (let c = 0; c < cols; c++) {
    let head = 0,
      tail = 0;
    for (let i = 0; i < nRows + K; i++) {
      if (i < nRows) {
        const v = acrossRows[i * cols + c];
        while (tail > head && acrossRows[dq[tail - 1] * cols + c] >= v) tail--;
        dq[tail++] = i;
      }
      if (i >= K) {
        const r = i - K;
        while (dq[head] < r - K) head++;
        out[r * cols + c] = acrossRows[dq[head] * cols + c];
      }
    }
  }
  return out;
}
