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
export function resampleGrid(grid: RasterGrid, outW: number, outH: number): Float32Array {
  const { width: sw, height: sh, data } = grid;
  const out = new Float32Array(outW * outH);
  const sum = new Float64Array(outW * outH);
  const cnt = new Uint32Array(outW * outH);
  for (let py = 0; py < sh; py++) {
    const oy = Math.min(outH - 1, Math.floor((py * outH) / sh));
    for (let px = 0; px < sw; px++) {
      const ox = Math.min(outW - 1, Math.floor((px * outW) / sw));
      const i = oy * outW + ox;
      sum[i] += clamp01(data[py * sw + px]);
      cnt[i]++;
    }
  }
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
  return out;
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
  if (pxW <= 0 || pxH <= 0 || widthMM <= 0 || heightMM <= 0 || lineIntervalMM <= 0) return { cols: 0, colPitch: 0, rows: [] };
  if (data.length < pxW * pxH) return { cols: 0, colPitch: 0, rows: [] };

  const dotPitch = params.dotPitchMM && params.dotPitchMM > 0 ? params.dotPitchMM : lineIntervalMM;
  const whiteThreshold = params.whiteThreshold ?? 0.96;
  const invert = params.invert ?? false;
  const levelStep = params.levelStep && params.levelStep > 0 ? params.levelStep : 1 / 255;
  const gamma = params.gamma && params.gamma > 0 ? params.gamma : 1;

  const rowCount = Math.max(1, Math.round(heightMM / lineIntervalMM));
  const colCount = Math.max(1, Math.round(widthMM / dotPitch));
  const rowPitch = heightMM / rowCount;
  const colPitch = widthMM / colCount;
  const dots = resampleGrid(grid, colCount, rowCount); // row 0 = top

  // darkness, quantised; blank (0) where the dot is at/above the white threshold.
  const levelFor = (gray: number): number => {
    const g = clamp01(invert ? 1 - gray : gray);
    if (g >= whiteThreshold) return 0;
    const curved = gamma === 1 ? 1 - g : Math.pow(1 - g, gamma);
    const q = Math.round(curved / levelStep) * levelStep;
    return q > 0 ? q : 0;
  };

  const rows: RasterLevelRow[] = [];
  for (let r = 0; r < rowCount; r++) {
    const y = (r + 0.5) * rowPitch;   // mm, bottom→top
    const gridRow = rowCount - 1 - r; // dot grid row 0 = top
    const base = gridRow * colCount;
    const levels = new Float32Array(colCount);
    for (let c = 0; c < colCount; c++) levels[c] = levelFor(dots[base + c]);
    rows.push({ y, levels });
  }
  return { cols: colCount, colPitch, rows };
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
  const dots = resampleGrid(grid, colCount, rowCount); // row 0 = top

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
    const y = (r + 0.5) * rowPitch;        // mm, bottom→top
    const gridRow = rowCount - 1 - r;      // dot grid row 0 = top
    const base = gridRow * colCount;

    const runs: RasterRun[] = [];
    let runStart = -1; // first dot column of the open run
    let runPower = 0;
    const closeRun = (endCol: number) => {
      if (runStart >= 0) runs.push({ x0: runStart * colPitch, x1: endCol * colPitch, power: runPower });
      runStart = -1;
    };
    for (let c = 0; c < colCount; c++) {
      const p = powerFor(dots[base + c]);
      if (p === null) {
        closeRun(c);
      } else if (runStart < 0) {
        runStart = c; runPower = p;
      } else if (p !== runPower) {
        closeRun(c);
        runStart = c; runPower = p;
      }
    }
    closeRun(colCount);

    if (runs.length > 0) rows.push({ y, runs });
  }
  return rows;
}
