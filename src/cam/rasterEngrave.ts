/**
 * Raster (greyscale) laser engraving — the pure path generator.
 *
 * A photo/greyscale engrave is fundamentally different from the vector laser
 * paths: instead of tracing outlines, the head sweeps the image in horizontal
 * scan rows and modulates the beam power per dot — darker dot ⇒ more power ⇒
 * deeper/darker burn. This module is the algorithmic core: it turns a greyscale
 * pixel grid plus physical/engraving parameters into a list of {@link RasterScanRow}s,
 * each a set of beam-on power runs along that row. It is deliberately free of any
 * entity, document, or G-code concern so it can be unit-tested in isolation and
 * shared by the G-code emitter and the on-canvas preview.
 *
 * The engrave is done at a *physical dot resolution*, not at the source image's
 * pixel resolution: rows are spaced `lineIntervalMM` apart and each row is divided
 * into dots `dotPitchMM` wide. The source image is **box-averaged** down to that
 * dot grid (so detail finer than the beam can resolve is averaged in, not aliased
 * or point-sampled) — and the output size is bounded by the physical size and the
 * dot pitch, independent of how many megapixels the source has.
 *
 * Coordinates are LOCAL to the image, in millimetres: the image occupies
 * `[0,widthMM] × [0,heightMM]` with (0,0) at the bottom-left and +Y up (the app's
 * world convention). The caller positions/rotates the image into world space.
 *
 * Rows are emitted bottom → top, and each row's runs left → right (canonical
 * order). Travel optimisation — boustrophedon scanning, overscan — is the
 * emitter's job, not the data's, so the preview and the G-code agree on *what*
 * burns regardless of the order it's traced in.
 */

import { dither, type DitherMode } from "./dither";
import { newBoxAccumulator, boxAccumulate } from "../core/resample";

/** A greyscale image as a row-major grid. `data[y*width + x]` ∈ [0,1], 0 = black. */
export interface RasterGrid {
  width: number;
  height: number;
  /** Row 0 is the TOP of the image (the usual image convention). */
  data: Float32Array | number[];
}

export interface RasterEngraveParams {
  /** Physical width the image is engraved at, mm. */
  widthMM: number;
  /** Physical height the image is engraved at, mm. */
  heightMM: number;
  /** Vertical pitch between scan rows, mm (e.g. 0.1mm ≈ 254 DPI). */
  lineIntervalMM: number;
  /**
   * Horizontal pitch between dots within a row, mm. Defaults to `lineIntervalMM`
   * (square dots), which is what most engravers want; set it independently for a
   * finer/coarser horizontal resolution than the line spacing.
   */
  dotPitchMM?: number;
  /** Beam power (%) for a fully black dot. */
  maxPower: number;
  /** Beam power (%) for the lightest engraved dot (often 0). */
  minPower: number;
  /**
   * Greyscale value at/above which a dot is left blank (beam off) — keeps
   * near-white background from being scorched and saves travel. 0..1, default 0.96.
   */
  whiteThreshold?: number;
  /** Engrave the light areas instead of the dark ones (photo negative). Default false. */
  invert?: boolean;
  /**
   * Quantise power to this step (%) so neighbouring dots of nearly equal tone
   * merge into one run — fewer, longer moves. Default 1 (whole-percent steps).
   */
  powerStep?: number;
  /** Mirror the sampled content left↔right. Default false. */
  flipX?: boolean;
  /** Mirror the sampled content top↔bottom. Default false. */
  flipY?: boolean;
  /**
   * Reproduce tone with a 1-bit dot pattern instead of per-dot power modulation.
   * When set (and not `"none"`), every fired dot burns at `maxPower` and tone comes
   * from dot density (see {@link ./dither}); `minPower`/`powerStep` no longer apply.
   * Default `"none"` (greyscale power).
   */
  dither?: DitherMode;
}

/** One beam-on run within a scan row: burn from `x0` to `x1` (mm) at `power` (%). */
export interface RasterRun {
  x0: number;
  x1: number;
  power: number;
}

/** A single horizontal scan row at height `y` (mm) with its left→right power runs. */
export interface RasterScanRow {
  y: number;
  runs: RasterRun[];
}

/**
 * Rigid transform lifting an image's local mm coordinates (origin at the entity
 * anchor, +X right, +Y up) into world mm. The scan pattern is always computed in
 * local space (rows horizontal); this rotates + translates each emitted point, so
 * a rotated image engraves along its own tilted rows without the row/boustrophedon
 * logic needing to know about the angle. `angle` 0 ⇒ `cos:1, sin:0` ⇒ a pure
 * translate, identical to the pre-rotation output.
 */
export interface RasterXf {
  ox: number;
  oy: number;
  cos: number;
  sin: number;
}

/** Build a {@link RasterXf} from an anchor position and rotation angle (rad). */
export function makeRasterXf(pos: { x: number; y: number }, angle: number): RasterXf {
  return { ox: pos.x, oy: pos.y, cos: Math.cos(angle), sin: Math.sin(angle) };
}

/** Map a local (mm) point through a {@link RasterXf} to world (mm). */
export function xfPoint(xf: RasterXf, lx: number, ly: number): { x: number; y: number } {
  return { x: xf.ox + lx * xf.cos - ly * xf.sin, y: xf.oy + lx * xf.sin + ly * xf.cos };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Box-average `grid` down (or sample up) to an `outW × outH` greyscale grid,
 * row 0 = top. Each source pixel contributes to exactly one output cell, so
 * downsampling is a true area average (anti-aliased); output cells that no source
 * pixel lands in (when upsampling) fall back to the nearest source pixel.
 */
export function resampleGrid(
  grid: RasterGrid,
  outW: number,
  outH: number,
  flipX = false,
  flipY = false,
): Float32Array {
  const { width: sw, height: sh, data } = grid;
  const out = new Float32Array(outW * outH);
  // Box-average via the shared core kernel, so this and the import-time decode
  // can never disagree about what "downscaled" means. Clamping to 0..1 per pixel
  // reproduces the local clamp01 this loop used to apply inline.
  const acc = newBoxAccumulator(sw, sh, outW, outH);
  boxAccumulate(acc, data, { x: 0, y: 0, w: sw, h: sh }, { min: 0, max: 1 });
  const { sum, cnt } = acc;
  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      const i = oy * outW + ox;
      if (cnt[i] > 0) {
        out[i] = sum[i] / cnt[i];
      } else {
        // Upsampling: nearest source pixel at this cell's centre.
        const px = Math.min(sw - 1, Math.floor(((ox + 0.5) * sw) / outW));
        const py = Math.min(sh - 1, Math.floor(((oy + 0.5) * sh) / outH));
        out[i] = clamp01(data[py * sw + px]);
      }
    }
  }
  if (!flipX && !flipY) return out;
  // Mirror the resampled grid in place: flipX reverses columns (left↔right),
  // flipY reverses rows (top↔bottom). One buffer feeds both the laser and the
  // mill, so a flip is honoured identically in engrave power and relief depth.
  const flipped = new Float32Array(outW * outH);
  for (let oy = 0; oy < outH; oy++) {
    const sy = flipY ? outH - 1 - oy : oy;
    for (let ox = 0; ox < outW; ox++) {
      const sx = flipX ? outW - 1 - ox : ox;
      flipped[oy * outW + ox] = out[sy * outW + sx];
    }
  }
  return flipped;
}

// ---------------------------------------------------------------------------
// Shared "level field" — the machine-agnostic core.
//
// A laser maps a dot's darkness to beam POWER; a mill maps it to Z DEPTH. Both
// want the same upstream work: box-average the source down to a physical dot
// grid and quantise each dot to a normalised "cut level" (0 = no cut/surface,
// 1 = darkest = full cut). This function produces that level field as rows
// (bottom→top, world-Y-up). Each backend then interprets the levels — the laser
// coalesces non-zero runs into beam-on segments (see {@link rasterEngrave}); the
// mill rides a continuous Z profile across the whole row. Crucially the level is
// quantised HERE (shared), so neighbouring equal-tone dots can be merged by each
// backend without the merge depending on backend-specific units.

/** One row of the dot field: quantised cut levels, left→right. 0 = surface, 1 = deepest/darkest. */
/**
 * Default level quantum: one 8-bit step, i.e. the finest a greyscale source can
 * express. Exported so anything re-deriving levels quantises on the same ladder.
 */
export const DEFAULT_LEVEL_STEP = 1 / 255;

/**
 * Tolerance for testing a depth DERIVED FROM A LEVEL against a plane.
 *
 * Levels live in a `Float32Array`, so `−level·maxDepth` carries ~1e-7·maxDepth
 * of representation error — a hundred times a bare `1e-9`. Compare a roughing
 * plane that tight and a cell whose target IS that plane can miss it by 60 nm
 * and go uncut, dropping a whole pass out of the program. Nothing in CAM
 * distinguishes a nanometre; the epsilon has to sit above the float32 noise and
 * far below any real geometry, and this does both.
 */
export function levelDepthEps(maxDepth: number): number {
  return Math.max(1e-9, Math.abs(maxDepth) * 1e-6);
}

export interface RasterLevelRow {
  /** Row centre height, mm (bottom→top — same convention as RasterScanRow.y). */
  y: number;
  levels: Float32Array;
}

export interface RasterField {
  /** Dots per row. */
  cols: number;
  /** Horizontal pitch between dots, mm. */
  colPitch: number;
  /** Vertical pitch between rows, mm. */
  rowPitch: number;
  /**
   * The level quantum this field was built on (see {@link RasterFieldParams.levelStep}).
   * Carried on the field rather than left to the caller to remember, because
   * anything that RE-derives levels from it — the tool-shape dilation in
   * {@link ../cam/toolProfile} — has to land back on the same ladder or the
   * equal-Z run merging downstream stops merging.
   */
  levelStep: number;
  /** Rows, bottom→top. */
  rows: RasterLevelRow[];
}

export interface RasterFieldParams {
  /** Physical width, mm. */
  widthMM: number;
  /** Physical height, mm. */
  heightMM: number;
  /** Vertical pitch between rows, mm (the laser line interval / the mill stepover). */
  lineIntervalMM: number;
  /** Horizontal dot pitch, mm. Default = `lineIntervalMM` (square dots). */
  dotPitchMM?: number;
  /** Greyscale at/above which a dot is blank (level 0). 0..1, default 0.96. */
  whiteThreshold?: number;
  /** Cut the light areas instead of the dark (negative). Default false. */
  invert?: boolean;
  /**
   * Quantise the level to this step (0..1) so equal-tone neighbours coalesce.
   * Default 1/255. Coarser = fewer distinct levels = fewer moves (the mill
   * collinear-merges equal-Z runs; the laser merges equal-power runs).
   */
  levelStep?: number;
  /**
   * Tone curve applied to the cut level: `level' = level ^ gamma`. 1 = linear
   * (default). For a mill relief, >1 lifts the mid-tones (shallower, flatter
   * background) and <1 deepens them — linear depth often makes a photo read flat,
   * so this is how the user dials in the look. Endpoints (black/white) are fixed.
   */
  gamma?: number;
  /**
   * How a pixel's stored value becomes a cut level.
   *
   * `"encoded"` (default, and what every caller did before this existed) treats
   * the byte as the quantity to invert: level = 1 − value. That is right when
   * the level drives something whose visual result is roughly proportional to
   * it — a laser's burn darkness, or a relief's carved DEPTH, where tone comes
   * from shading a shaped surface.
   *
   * `"linear"` first converts the byte out of sRGB into linear light, so
   * level = 1 − luminance. That is right when the level drives AREA COVERAGE,
   * because the surface's reflectance is what mixes: a halftone covering half
   * its row reflects half the light, and half the light reads as byte ~188, not
   * as the byte 128 that produced it. Middle grey (128) wants ~79% coverage,
   * not 50%. Without this a halftone comes out visibly washed out through the
   * mid-tones — and no single `gamma` reproduces the curve, so it cannot be
   * dialled in after the fact.
   */
  tone?: "encoded" | "linear";
  /** Mirror the sampled content left↔right. Default false. */
  flipX?: boolean;
  /** Mirror the sampled content top↔bottom. Default false. */
  flipY?: boolean;
}

/**
 * sRGB → linear light (IEC 61966-2-1). Used by the `"linear"` tone mapping;
 * `srgbToLinear(0.5) ≈ 0.214`, which is why middle grey needs most of a row
 * covered rather than half of it.
 */
export function srgbToLinear(v: number): number {
  const c = clamp01(v);
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * Build the 1-bit dither map for a physical dot grid: convert each resampled tone
 * to a darkness value (honouring `invert` and blanking background at/above the
 * white threshold), then run the chosen algorithm. Shared by the laser G-code path
 * ({@link rasterEngrave}) and the 3-D burn preview ({@link rasterField}) so both
 * agree on exactly which dots fire. Grid order matches `dots` (row 0 = top).
 */
function ditherDots(
  dots: Float32Array,
  cols: number,
  rows: number,
  invert: boolean,
  whiteThreshold: number,
  mode: DitherMode,
): Uint8Array {
  const dk = new Float32Array(cols * rows);
  for (let i = 0; i < dk.length; i++) {
    const g = clamp01(invert ? 1 - dots[i] : dots[i]); // lightness (1 = white)
    dk[i] = g >= whiteThreshold ? 0 : 1 - g; // darkness; blank the background
  }
  return dither(dk, cols, rows, mode);
}

/**
 * Resample + quantise `grid` to a physical level field at the given size. Returns
 * an empty field (`rows: []`) for degenerate inputs. Rows whose dots are all
 * blank are still included (a mill rides across them at the surface) — emptiness
 * is the consumer's call, unlike the laser which drops all-blank rows.
 */
export function rasterField(grid: RasterGrid, params: RasterFieldParams): RasterField {
  const { width: pxW, height: pxH, data } = grid;
  const { widthMM, heightMM, lineIntervalMM } = params;
  const empty = { cols: 0, colPitch: 0, rowPitch: 0, levelStep: DEFAULT_LEVEL_STEP, rows: [] };
  if (pxW <= 0 || pxH <= 0 || widthMM <= 0 || heightMM <= 0 || lineIntervalMM <= 0) return empty;
  if (data.length < pxW * pxH) return empty;

  const dotPitch = params.dotPitchMM && params.dotPitchMM > 0 ? params.dotPitchMM : lineIntervalMM;
  const whiteThreshold = params.whiteThreshold ?? 0.96;
  const invert = params.invert ?? false;
  const levelStep =
    params.levelStep && params.levelStep > 0 ? params.levelStep : DEFAULT_LEVEL_STEP;
  const gamma = params.gamma && params.gamma > 0 ? params.gamma : 1;

  const rowCount = Math.max(1, Math.round(heightMM / lineIntervalMM));
  const colCount = Math.max(1, Math.round(widthMM / dotPitch));
  const rowPitch = heightMM / rowCount;
  const colPitch = widthMM / colCount;
  const dots = resampleGrid(grid, colCount, rowCount, params.flipX, params.flipY); // row 0 = top

  // NOTE on dithering: the 3-D preview is a coarse height field (often coarser than
  // the dot pitch), and the density-average of a dither pattern is exactly the
  // source tone — so this field always renders continuous TONE, whether or not the
  // laser op dithers. (Binarising here just smears sub-cell dots into a solid burn.)
  // Dithering is shown where it's resolvable: the flat laser preview + the G-code.

  // darkness, quantised; blank (0) where the dot is at/above the white threshold.
  // The white test stays on the ENCODED value either way, so "what counts as
  // background" doesn't move when the tone mapping does.
  const linear = params.tone === "linear";
  const levelFor = (gray: number): number => {
    const g = clamp01(invert ? 1 - gray : gray);
    if (g >= whiteThreshold) return 0;
    const darkness = linear ? 1 - srgbToLinear(g) : 1 - g;
    const curved = gamma === 1 ? darkness : darkness ** gamma;
    const q = Math.round(curved / levelStep) * levelStep;
    return q > 0 ? q : 0;
  };

  const rows: RasterLevelRow[] = [];
  for (let r = 0; r < rowCount; r++) {
    const y = (r + 0.5) * rowPitch; // mm, bottom→top
    const gridRow = rowCount - 1 - r; // dot grid row 0 = top
    const base = gridRow * colCount;
    const levels = new Float32Array(colCount);
    for (let c = 0; c < colCount; c++) levels[c] = levelFor(dots[base + c]);
    rows.push({ y, levels });
  }
  return { cols: colCount, colPitch, rowPitch, levelStep, rows };
}

/**
 * Build the scan rows for engraving `grid` at the given physical size and
 * parameters. Returns an empty array for degenerate inputs (non-positive size,
 * interval, or pixel dimensions). Rows with no burn (all blank) are omitted.
 */
export function rasterEngrave(grid: RasterGrid, params: RasterEngraveParams): RasterScanRow[] {
  const { width: pxW, height: pxH, data } = grid;
  const { widthMM, heightMM, lineIntervalMM, maxPower, minPower } = params;
  if (pxW <= 0 || pxH <= 0 || widthMM <= 0 || heightMM <= 0 || lineIntervalMM <= 0) return [];
  if (data.length < pxW * pxH) return [];

  const dotPitch = params.dotPitchMM && params.dotPitchMM > 0 ? params.dotPitchMM : lineIntervalMM;
  const whiteThreshold = params.whiteThreshold ?? 0.96;
  const invert = params.invert ?? false;
  const powerStep = params.powerStep && params.powerStep > 0 ? params.powerStep : 1;

  // Physical dot grid: whole rows/cols that fit, each centred in its band so the
  // engrave is symmetric within the image. The source is averaged down to this.
  const rowCount = Math.max(1, Math.round(heightMM / lineIntervalMM));
  const colCount = Math.max(1, Math.round(widthMM / dotPitch));
  const rowPitch = heightMM / rowCount;
  const colPitch = widthMM / colCount;
  const dots = resampleGrid(grid, colCount, rowCount, params.flipX, params.flipY); // row 0 = top

  // Dithering: reproduce tone as a 1-bit dot pattern. A fired dot burns at maxPower,
  // an unfired one is blank — density carries the tone, so minPower/powerStep are
  // moot. Computed once over the whole dot grid (error diffusion needs the 2-D field).
  const ditherMap =
    params.dither && params.dither !== "none"
      ? ditherDots(dots, colCount, rowCount, invert, whiteThreshold, params.dither)
      : null;

  // Map a resampled tone (0=black) to a quantised beam power (%), or null to leave
  // the dot blank. `invert` flips tone first so "engrave the light parts" reads
  // white as dark.
  const powerFor = (gray: number): number | null => {
    const g = clamp01(invert ? 1 - gray : gray);
    if (g >= whiteThreshold) return null; // background — beam off
    const p = maxPower + (minPower - maxPower) * g; // black→maxPower, white→minPower
    const q = Math.round(p / powerStep) * powerStep;
    return q > 0 ? q : null; // a 0% run is just travel — drop it
  };

  const rows: RasterScanRow[] = [];
  for (let r = 0; r < rowCount; r++) {
    const y = (r + 0.5) * rowPitch; // mm, bottom→top
    const gridRow = rowCount - 1 - r; // dot grid row 0 = top
    const base = gridRow * colCount;

    const runs: RasterRun[] = [];
    let runStart = -1; // first dot column of the open run
    let runPower = 0;
    const closeRun = (endCol: number) => {
      if (runStart >= 0)
        runs.push({ x0: runStart * colPitch, x1: endCol * colPitch, power: runPower });
      runStart = -1;
    };
    for (let c = 0; c < colCount; c++) {
      const p = ditherMap ? (ditherMap[base + c] ? maxPower : null) : powerFor(dots[base + c]);
      if (p === null) {
        closeRun(c);
      } else if (runStart < 0) {
        runStart = c;
        runPower = p;
      } else if (p !== runPower) {
        closeRun(c);
        runStart = c;
        runPower = p;
      }
    }
    closeRun(colCount);

    if (runs.length > 0) rows.push({ y, runs });
  }
  return rows;
}
