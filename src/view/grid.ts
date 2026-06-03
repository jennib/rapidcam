/**
 * Adaptive grid spacing.
 *
 * Picks "nice" major/minor step sizes (in the current display unit) so that grid
 * lines stay roughly a target number of pixels apart at any zoom level, then
 * reports the steps in mm for the renderer to lay out. Labels always land on
 * round values of the display unit (10mm, 20mm… or 0.5in, 1in…).
 */

import { Unit, toMM } from "../core/units";
import { niceStepUp } from "../core/geom";

export interface GridSpec {
  /** Minor line spacing in mm. */
  minorMM: number;
  /** Major (labelled) line spacing in mm. */
  majorMM: number;
  /** Decimal places to use when labelling major lines in the display unit. */
  labelDecimals: number;
}

const TARGET_MAJOR_PX = 80;
const MINORS_PER_MAJOR = 5;

export function computeGrid(scale: number, unit: Unit): GridSpec {
  const mmPerUnit = toMM(1, unit); // 1 for mm, 25.4 for in
  const pxPerUnit = scale * mmPerUnit;

  // Major step chosen in display units, snapped to a nice 1/2/5×10ⁿ value.
  const rawMajorUnit = TARGET_MAJOR_PX / pxPerUnit;
  const majorUnit = niceStepUp(rawMajorUnit);
  const minorUnit = majorUnit / MINORS_PER_MAJOR;

  // Enough decimals to render the major step without rounding it away.
  const labelDecimals = Math.max(0, Math.ceil(-Math.log10(majorUnit)) + (unit === "in" ? 1 : 0));

  return {
    minorMM: toMM(minorUnit, unit),
    majorMM: toMM(majorUnit, unit),
    labelDecimals: Math.min(labelDecimals, 4),
  };
}
