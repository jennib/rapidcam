/**
 * Descriptive filenames for exported G-code.
 *
 * Everything used to save as `toolpaths.nc`, so a folder of exports was a wall of
 * identical names — you couldn't tell which project, which toolpath, or which
 * export a file held. This builds a self-describing name instead:
 *
 *     <project>_<scope>_<YYYY-MM-DD>_<HHMMSS>.<ext>
 *     bracket_all_2026-07-08_143207.nc
 *     bracket_pocket_2026-07-08_143512.nc
 *     bracket_two-sided_2026-07-08_144030.zip
 *
 * - project — the current .rcam name (or "untitled" if unsaved).
 * - scope   — what the file contains: "all", a single op's name, "selected-3",
 *             "sideA"/"sideB", "all-rotary", …
 * - date+time — when it was exported. This IS the version code: it orders
 *             chronologically (lexically), never collides, and — unlike a stored
 *             counter — is identical logic on every machine, so a shop with no
 *             login and several PCs still gets consistent, comparable names.
 *
 * Every part is reduced to the CNC-safe set `[A-Za-z0-9_-]` — controllers and
 * senders choke on spaces, slashes and punctuation.
 */

/** Reduce a name part to letters, digits, `_` and `-` (collapsing runs). */
export function sanitizePart(s: string): string {
  return s
    .replace(/[^a-z0-9_-]+/gi, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
}

/**
 * Local wall-clock stamp `YYYY-MM-DD_HHMMSS` — the date and time an export ran.
 * Local (not UTC) so it matches the clock the operator sees at the machine.
 */
export function timeStamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${date}_${time}`;
}

export interface ExportNameParts {
  /** Project name, e.g. the current .rcam file name. */
  project: string;
  /** What the file holds: "all", an op name, "selected-3", "sideA", … */
  scope: string;
  /**
   * Date+time component from {@link timeStamp}; defaults to now. Pass an explicit
   * stamp when one export writes several files (a two-sided job → sideA, sideB
   * and the zip) so they all carry the same instant.
   */
  stamp?: string;
  /** File extension without the dot; defaults to "nc". */
  ext?: string;
}

/** Assemble a descriptive export filename from its parts. */
export function formatExportName({ project, scope, stamp = timeStamp(), ext = "nc" }: ExportNameParts): string {
  const proj = sanitizePart(project) || "untitled";
  const sc = sanitizePart(scope) || "toolpath";
  return `${proj}_${sc}_${stamp}.${ext}`;
}
