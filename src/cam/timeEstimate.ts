/**
 * G-code run-time estimator.
 *
 * Parses a generated program and sums the motion time: linear/arc feed moves at
 * their modal feed rate, rapids at a fixed rapid rate. It reads the *output* of
 * {@link ./gcode} and {@link ./lasergcode} rather than the toolpaths, so a single
 * estimator covers mill, laser, and rotary jobs and always agrees with what was
 * actually posted.
 *
 * Scope / assumptions (this estimates OUR G-code, not arbitrary G-code):
 *  - Absolute distance mode (G90) — the app never emits G91.
 *  - Arc centres are incremental I/J (GRBL default), the only form emitted.
 *  - G94 units/min feed by default; G93 inverse-time (rotary) is honoured — an
 *    inverse-time move takes 1/F minutes regardless of length.
 *  - It is a *ballpark*: acceleration/deceleration is not modelled, so a program
 *    with many tiny moves (dense rasters, fine curves) runs slower on real
 *    hardware than the constant-feed estimate. Dwell (G4) and tool-change /
 *    spindle spin-up pauses are not counted.
 */

/** Default rapid (G0) traverse rate, mm/min, when the caller doesn't supply one. */
export const DEFAULT_RAPID_RATE = 3000;

export interface TimeEstimateOptions {
  /** Rapid (G0) rate in mm/min. Default {@link DEFAULT_RAPID_RATE}. */
  rapidRate?: number;
}

export interface TimeEstimate {
  /** Total run time, seconds. */
  seconds: number;
  /** Time in cutting moves (G1/G2/G3), seconds. */
  cutSeconds: number;
  /** Time in rapid moves (G0), seconds. */
  rapidSeconds: number;
}

const wordRe = /([A-Za-z])\s*(-?\d*\.?\d+)/g;

/** Parse one line's letter→number words (comments stripped). */
function parseWords(line: string): Map<string, number> {
  const clean = line.replace(/\(.*?\)/g, " ").split(";")[0];
  const words = new Map<string, number>();
  wordRe.lastIndex = 0;
  let m = wordRe.exec(clean);
  while (m !== null) {
    const v = parseFloat(m[2]);
    if (Number.isFinite(v)) words.set(m[1].toUpperCase(), v);
    m = wordRe.exec(clean);
  }
  return words;
}

/** Swept angle (0, 2π] from `a0` to `a1` in the given direction (+1 = CCW/G3). */
function sweptAngle(a0: number, a1: number, ccw: boolean): number {
  let d = ccw ? a1 - a0 : a0 - a1;
  const TWO_PI = 2 * Math.PI;
  while (d <= 1e-9) d += TWO_PI; // a full-circle arc (start==end) reads as 2π
  return d;
}

/**
 * Estimate the run time of a G-code program. Unknown/non-motion lines (comments,
 * G21/G90, M-codes, S/T words) are skipped. Returns all-zero for empty input.
 */
export function estimateGCodeTime(gcode: string, opts: TimeEstimateOptions = {}): TimeEstimate {
  const rapidRate = opts.rapidRate && opts.rapidRate > 0 ? opts.rapidRate : DEFAULT_RAPID_RATE;

  let x = 0;
  let y = 0;
  let z = 0;
  let feed = 0; // mm/min (G94) or inverse-time 1/min (G93)
  let motion: 0 | 1 | 2 | 3 | null = null;
  let inverseTime = false; // G93

  let cutMin = 0;
  let rapidMin = 0;

  for (const raw of gcode.split("\n")) {
    const w = parseWords(raw);
    if (w.size === 0) continue;

    // Modal G-words: motion mode + feed mode. A line may restate G90/G17/etc. too.
    if (w.has("G")) {
      const g = w.get("G")!;
      if (g === 0 || g === 1 || g === 2 || g === 3) motion = g;
      else if (g === 93) inverseTime = true;
      else if (g === 94) inverseTime = false;
    }
    if (w.has("F")) feed = w.get("F")!;

    const hasMove = w.has("X") || w.has("Y") || w.has("Z") || w.has("I") || w.has("J");
    if (motion === null || !hasMove) continue;

    const nx = w.has("X") ? w.get("X")! : x;
    const ny = w.has("Y") ? w.get("Y")! : y;
    const nz = w.has("Z") ? w.get("Z")! : z;

    let dist: number;
    if (motion === 2 || motion === 3) {
      // Arc: centre is incremental (I,J) from the current point.
      const cx = x + (w.get("I") ?? 0);
      const cy = y + (w.get("J") ?? 0);
      const r = Math.hypot(x - cx, y - cy);
      const closed = Math.hypot(nx - x, ny - y) < 1e-6;
      const sweep = closed
        ? 2 * Math.PI
        : sweptAngle(Math.atan2(y - cy, x - cx), Math.atan2(ny - cy, nx - cx), motion === 3);
      const arcXY = r * sweep;
      dist = Math.hypot(arcXY, nz - z); // include any helical Z component
    } else {
      dist = Math.hypot(nx - x, ny - y, nz - z);
    }

    if (motion === 0) {
      rapidMin += dist / rapidRate;
    } else if (inverseTime) {
      // G93: the move takes 1/F minutes, independent of length.
      if (feed > 0) cutMin += 1 / feed;
    } else if (feed > 0) {
      cutMin += dist / feed;
    }

    x = nx;
    y = ny;
    z = nz;
  }

  const cutSeconds = cutMin * 60;
  const rapidSeconds = rapidMin * 60;
  return { seconds: cutSeconds + rapidSeconds, cutSeconds, rapidSeconds };
}

/**
 * Compute the estimate for a program held as header+body `lines` and splice an
 * "; Estimated run time" comment into the header (just before the `G21` setup
 * line, else at the top). Mutates `lines` in place. The comment is inert, so a
 * later re-estimate of the same program is unaffected.
 */
export function insertTimeEstimateComment(lines: string[], opts?: TimeEstimateOptions): void {
  const e = estimateGCodeTime(lines.join("\n"), opts);
  if (!(e.seconds > 0)) return; // nothing moved (e.g. "; No toolpaths")
  const comment = `; Estimated run time: ${formatDuration(e.seconds)} (cut ${formatDuration(
    e.cutSeconds,
  )}, rapid ${formatDuration(e.rapidSeconds)})`;
  const at = lines.findIndex((l) => /^\s*G21\b/.test(l));
  if (at >= 0) lines.splice(at, 0, comment);
  else lines.unshift(comment);
}

/**
 * Human-readable duration: "45 s", "12 min", "1 h 23 min". Rounds to whole
 * seconds under a minute, whole minutes under an hour, and h + min above.
 */
export function formatDuration(seconds: number): string {
  if (!(seconds > 0)) return "0 s";
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const totalMin = Math.round(seconds / 60);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min ? `${h} h ${min} min` : `${h} h`;
}
