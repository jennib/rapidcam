/**
 * Raster (greyscale) laser engraving — the pure path generator.
 *
 * A photo/greyscale engrave is fundamentally different from the vector laser
 * paths: instead of tracing outlines, the head sweeps the image in horizontal
 * scan rows and modulates the beam power per pixel — darker pixel ⇒ more power ⇒
 * deeper/darker burn. This module is the algorithmic core: it turns a greyscale
 * pixel grid plus physical/engraving parameters into a list of {@link RasterScanRow}s,
 * each a set of beam-on power runs along that row. It is deliberately free of any
 * entity, document, or G-code concern so it can be unit-tested in isolation and
 * shared by the G-code emitter and the on-canvas preview.
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
  /** Beam power (%) for a fully black pixel. */
  maxPower: number;
  /** Beam power (%) for the lightest engraved pixel (often 0). */
  minPower: number;
  /**
   * Greyscale value at/above which a pixel is left blank (beam off) — keeps
   * near-white background from being scorched and saves travel. 0..1, default 0.96.
   */
  whiteThreshold?: number;
  /** Engrave the light areas instead of the dark ones (photo negative). Default false. */
  invert?: boolean;
  /**
   * Quantise power to this step (%) so neighbouring pixels of nearly equal tone
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

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

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

  const whiteThreshold = params.whiteThreshold ?? 0.96;
  const invert = params.invert ?? false;
  const powerStep = params.powerStep && params.powerStep > 0 ? params.powerStep : 1;

  // Whole rows that fit; each row is centred in its band so the engrave is
  // vertically symmetric within the image height.
  const rowCount = Math.max(1, Math.round(heightMM / lineIntervalMM));
  const rowPitch = heightMM / rowCount;
  const colPitch = widthMM / pxW;

  // Map a raw greyscale sample (0=black) to a quantised beam power (%), or null
  // to leave the pixel blank. `invert` flips tone first so "engrave the light
  // parts" reads white as dark.
  const powerFor = (gray: number): number | null => {
    const g = clamp01(invert ? 1 - gray : gray);
    if (g >= whiteThreshold) return null; // background — beam off
    // black (g=0) → maxPower, white (g→1) → minPower.
    const p = maxPower + (minPower - maxPower) * g;
    const q = Math.round(p / powerStep) * powerStep;
    return q > 0 ? q : null; // a 0% run is just travel — drop it
  };

  const rows: RasterScanRow[] = [];
  for (let r = 0; r < rowCount; r++) {
    const y = (r + 0.5) * rowPitch; // mm, bottom→top
    // World +Y is up but image row 0 is the TOP, so taller y ⇒ smaller pixel row.
    let pxRow = Math.floor((1 - y / heightMM) * pxH);
    if (pxRow < 0) pxRow = 0;
    if (pxRow >= pxH) pxRow = pxH - 1;
    const base = pxRow * pxW;

    const runs: RasterRun[] = [];
    let runStart = -1; // first pixel column of the open run
    let runPower = 0;
    const closeRun = (endCol: number) => {
      if (runStart >= 0) runs.push({ x0: runStart * colPitch, x1: endCol * colPitch, power: runPower });
      runStart = -1;
    };
    for (let c = 0; c < pxW; c++) {
      const p = powerFor(clamp01(data[base + c]));
      if (p === null) {
        closeRun(c);
      } else if (runStart < 0) {
        runStart = c; runPower = p;
      } else if (p !== runPower) {
        closeRun(c);
        runStart = c; runPower = p;
      }
    }
    closeRun(pxW);

    if (runs.length > 0) rows.push({ y, runs });
  }
  return rows;
}
