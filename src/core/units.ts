/**
 * Units system.
 *
 * The document stores ALL lengths internally in millimetres (mm). This module is
 * the single place that converts between the internal mm value and whatever unit
 * the user is currently working in, and it parses free-text length input such as
 * "10", "10mm", "0.5in", or '1/2"'.
 */

export type Unit = "mm" | "in";

export const MM_PER_INCH = 25.4;

/** Convert a value expressed in `unit` to internal millimetres. */
export function toMM(value: number, unit: Unit): number {
  return unit === "in" ? value * MM_PER_INCH : value;
}

/** Convert an internal millimetre value to `unit`. */
export function fromMM(mm: number, unit: Unit): number {
  return unit === "in" ? mm / MM_PER_INCH : mm;
}

const UNIT_ALIASES: Record<string, Unit> = {
  mm: "mm",
  millimeter: "mm",
  millimetre: "mm",
  millimeters: "mm",
  millimetres: "mm",
  in: "in",
  inch: "in",
  inches: "in",
  '"': "in",
  "''": "in",
  '″': "in", // ″ double prime
};

/**
 * Parse a length string into internal millimetres.
 *
 * - A bare number ("12.5") is interpreted in `displayUnit`.
 * - A trailing unit suffix overrides it ("10mm", "0.5 in", '2"').
 * - Inch fractions are supported ("1/2in", '3 1/4"').
 *
 * Returns `null` when the input cannot be parsed.
 */
export function parseLength(input: string, displayUnit: Unit): number | null {
  if (input == null) return null;
  let s = input.trim().toLowerCase();
  if (s === "") return null;

  // Pull off a trailing unit suffix if present.
  let unit: Unit = displayUnit;
  for (const alias of Object.keys(UNIT_ALIASES).sort((a, b) => b.length - a.length)) {
    if (s.endsWith(alias)) {
      unit = UNIT_ALIASES[alias];
      s = s.slice(0, s.length - alias.length).trim();
      break;
    }
  }
  if (s === "") return null;

  const value = parseNumberOrFraction(s);
  if (value === null) return null;
  return toMM(value, unit);
}

/** Parse "3", "3.5", "1/2", or "3 1/4" into a number. */
function parseNumberOrFraction(s: string): number | null {
  // mixed fraction: "3 1/4"
  const mixed = s.match(/^(-?\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) {
    const whole = parseInt(mixed[1], 10);
    const num = parseInt(mixed[2], 10);
    const den = parseInt(mixed[3], 10);
    if (den === 0) return null;
    const sign = whole < 0 ? -1 : 1;
    return whole + sign * (num / den);
  }
  // simple fraction: "1/2"
  const frac = s.match(/^(-?\d+)\/(\d+)$/);
  if (frac) {
    const den = parseInt(frac[2], 10);
    if (den === 0) return null;
    return parseInt(frac[1], 10) / den;
  }
  // plain number
  if (/^-?(\d+\.?\d*|\.\d+)$/.test(s)) {
    return parseFloat(s);
  }
  return null;
}

const DEFAULT_PRECISION: Record<Unit, number> = { mm: 2, in: 3 };

/** Format an internal mm value for display in `unit`. */
export function formatLength(mm: number, unit: Unit, precision?: number): string {
  const p = precision ?? DEFAULT_PRECISION[unit];
  return fromMM(mm, unit).toFixed(p);
}

/** Format with the unit suffix, e.g. "10.00 mm". */
export function formatLengthWithUnit(mm: number, unit: Unit, precision?: number): string {
  return `${formatLength(mm, unit, precision)} ${unit}`;
}
