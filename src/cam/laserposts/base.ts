/**
 * Laser / fixed-Z "cutting head" post-processors. Each controller family lives in
 * its own file in this folder and is a small, self-contained {@link LaserPost}
 * value — add or edit one without touching the generator (lasergcode.ts), which
 * drives heads only through this interface.
 *
 * What differs between heads, and nothing else:
 *   - the beam on/off commands (GRBL `M4` dynamic vs `M3` constant, etc.),
 *   - how a 0–100 % power maps to an `S` word (0–1000, 0–255, or a 0–1 fraction),
 *   - whether power is set once (modal) or rides on every cut move (`inlinePower`,
 *     e.g. Smoothieware),
 *   - the program-start setup/comment lines.
 *
 * The XY motion itself (G0 travels, G1/G2/G3 cuts) is identical across heads and
 * lives in the generator. `pierce()` is the hook a future waterjet/plasma head
 * would implement (a `G4` dwell before each cut); lasers pierce instantly and
 * leave it undefined.
 */
export interface LaserPost {
  /** Stable id stored in the document (as `postProcessor`) and used for lookup. */
  readonly id: string;
  /** Human label for the machine-settings dropdown. */
  readonly name: string;
  /** Whether closed profiles should be kerf-compensated (true for every beam/jet). */
  readonly kerfCompensated: boolean;
  /**
   * When true, power rides on each cutting move as an inline `S` word (Smoothie);
   * when false, {@link beamOn} sets it modally and cut moves carry no `S`.
   */
  readonly inlinePower: boolean;
  /** Setup/comment lines emitted once after the G21/G90/G17 block. */
  programStart(): string[];
  /**
   * Format an op's 0–100 % power as this controller's `S` value, e.g. `"800"`,
   * `"204"`, or `"0.8"`. `maxOverride` lets a machine's actual max (GRBL `$30`,
   * Marlin `LASER_POWER`) win for numeric scales; fractional heads ignore it.
   */
  formatPower(percent: number, maxOverride?: number): string;
  /** Beam-enable lines at the start of an operation (modal heads set M3/M4 S here). */
  beamOn(power: string): string[];
  /** Beam-disable lines (operation end / program end). */
  beamOff(): string[];
  /**
   * Air-assist on/off, emitted around operations that request it. Optional —
   * the generator falls back to {@link AIR_ON_DEFAULT}/{@link AIR_OFF_DEFAULT}
   * (`M8`/`M9`). Override in a controller's file if it drives air from a
   * different output.
   */
  airOn?(): string[];
  airOff?(): string[];
  /** Optional pierce step before a cut (waterjet/plasma); unused by lasers. */
  pierce?(): string[];
}

/** Default air-assist commands (a relay on the flood output) when a post doesn't override. */
export const AIR_ON_DEFAULT = ["M8 ; air assist on"];
export const AIR_OFF_DEFAULT = ["M9 ; air assist off"];

/** Clamp a percentage into 0–100. */
export function clampPercent(p: number): number {
  return Math.max(0, Math.min(100, p));
}

/** Scale a 0–100 % power to an integer `S` against a numeric max (e.g. 1000, 255). */
export function scaledPower(percent: number, max: number): string {
  return String(Math.round((clampPercent(percent) / 100) * max));
}

/** Scale a 0–100 % power to a 0–1 fraction with up to 3 dp, trailing zeros trimmed. */
export function fractionalPower(percent: number): string {
  const f = clampPercent(percent) / 100;
  return f.toFixed(3).replace(/\.?0+$/, "") || "0";
}
