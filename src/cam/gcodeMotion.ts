/**
 * Stitch phase 2a — a parser/emitter for RapidCAM's *own* mill G-code.
 *
 * Tiling clips a finished toolpath into machine-bed-sized pieces. Since the
 * generator emits G-code text with no intermediate motion representation, we
 * recover one here: parse the program back into position-resolved move events
 * (plus verbatim pass-through for everything else), so the clip can reason about
 * absolute XY, translate each tile to machine-local coordinates, and re-emit.
 *
 * Scope: the subset our mill post-processors produce — `G0/G1/G2/G3` moves with
 * `X/Y/Z/I/J/F` words (absolute G90; `I/J` incremental arc centres), and any
 * other line (comments, `G21/G90/G17`, `M`-codes, tool changes, custom blocks)
 * passed through untouched. Lines that carry a trailing comment are treated as
 * pass-through so their text is preserved. `G5` splines (LinuxCNC bezier engrave)
 * are not moves here — {@link unsupportedMotions} reports them so the export can
 * warn rather than mis-clip.
 */

import { n } from "./postprocessors/base";
import { lexWords } from "./gcodeWords";

export interface GMoveEvent {
  kind: "move";
  motion: 0 | 1 | 2 | 3;
  /** Absolute position after this move (unchanged axes inherit the previous value). */
  x: number;
  y: number;
  z: number;
  /** Which axis words were present on the source line (so emission can match). */
  hasX: boolean;
  hasY: boolean;
  hasZ: boolean;
  /** Incremental arc-centre offset (present for G2/G3); unaffected by translation. */
  i?: number;
  j?: number;
  f?: number;
}

export interface GRawEvent {
  kind: "raw";
  text: string;
}

export type GEvent = GMoveEvent | GRawEvent;

export interface GProgram {
  events: GEvent[];
}

const MOVE_WORDS = new Set(["G0", "G1", "G2", "G3", "G00", "G01", "G02", "G03"]);

/** Parse RapidCAM mill G-code into position-resolved events. */
export function parseProgram(gcode: string): GProgram {
  const events: GEvent[] = [];
  let x = 0,
    y = 0,
    z = 0;

  for (const line of gcode.split(/\r?\n/)) {
    // Only translate bare moves; anything with a comment stays verbatim so its
    // text (e.g. a "park for tool change" note) survives.
    //
    // The leading motion word is found by LEXING rather than by reading the first
    // whitespace-separated token: `G0X10Y20` is legal, and as one token it matched
    // no MOVE_WORD, so the whole line fell through to verbatim pass-through — a
    // move that tiling then never translated, with `unsupportedMotions` not
    // reporting it either. Only hand-typed text reaches this (our posts always
    // space their words), which is exactly what a custom program block injects.
    // A leading non-motion word still falls through, so `G53 G0 X0 Y0` keeps its
    // existing verbatim treatment — machine coordinates must not be tile-shifted.
    const words = lexWords(line);
    const lead = words[0];
    const leadCode = lead?.letter === "G" ? `G${lead.value}` : "";
    if (leadCode && MOVE_WORDS.has(leadCode) && !line.includes(";")) {
      const motion = (lead.value % 4) as 0 | 1 | 2 | 3;
      let hasX = false,
        hasY = false,
        hasZ = false;
      let i: number | undefined, j: number | undefined, f: number | undefined;
      for (let k = 1; k < words.length; k++) {
        const v = words[k].value;
        switch (words[k].letter) {
          case "X":
            x = v;
            hasX = true;
            break;
          case "Y":
            y = v;
            hasY = true;
            break;
          case "Z":
            z = v;
            hasZ = true;
            break;
          case "I":
            i = v;
            break;
          case "J":
            j = v;
            break;
          case "F":
            f = v;
            break;
        }
      }
      events.push({ kind: "move", motion, x, y, z, hasX, hasY, hasZ, i, j, f });
    } else {
      events.push({ kind: "raw", text: line });
    }
  }

  return { events };
}

/** Format one move, translated so the tile origin (dx,dy,dz in program coords) maps to 0. */
function formatMove(m: GMoveEvent, dx: number, dy: number, dz: number): string {
  const parts = [`G${m.motion}`];
  if (m.hasX) parts.push(`X${n(m.x - dx)}`);
  if (m.hasY) parts.push(`Y${n(m.y - dy)}`);
  if (m.hasZ) parts.push(`Z${n(m.z - dz)}`);
  if (m.motion === 2 || m.motion === 3) {
    if (m.i !== undefined) parts.push(`I${n(m.i)}`); // incremental — no translation
    if (m.j !== undefined) parts.push(`J${n(m.j)}`);
  }
  if (m.f !== undefined) parts.push(`F${n(m.f)}`);
  return parts.join(" ");
}

export interface EmitOptions {
  /** Translate every move so this program-coordinate point becomes the origin. */
  dx?: number;
  dy?: number;
  dz?: number;
}

/** Re-emit a program to G-code text, optionally translating all moves. */
export function emitProgram(program: GProgram, opts: EmitOptions = {}): string {
  const { dx = 0, dy = 0, dz = 0 } = opts;
  return program.events
    .map((ev) => (ev.kind === "raw" ? ev.text : formatMove(ev, dx, dy, dz)))
    .join("\n");
}

/** True for a material-cutting move (feed, at or below the surface) vs a rapid. */
export function isCutMove(m: GMoveEvent): boolean {
  return m.motion !== 0 && m.z < 0;
}

/**
 * Distinct leading G-codes on move-like lines that this module does NOT model
 * (e.g. `G5` LinuxCNC bezier splines). Empty means the program is fully clippable.
 */
export function unsupportedMotions(gcode: string): string[] {
  const seen = new Set<string>();
  for (const line of gcode.split(/\r?\n/)) {
    const words = lexWords(line);
    const lead = words[0];
    if (lead?.letter !== "G") continue;
    const head = `G${lead.value}`;
    if (MOVE_WORDS.has(head)) continue;
    // A motion word we don't handle: G-code carrying coordinates but not G0-G3.
    // Coordinates are detected from the LEXED words rather than a `\b[XYZ]` regex:
    // that boundary never matches inside `G0X120Y10`, because a digit and a letter
    // are both word characters, so run-together lines slipped past this check
    // silently — the one case where a warning mattered most.
    if (!words.some((w) => w.letter === "X" || w.letter === "Y" || w.letter === "Z")) continue;
    if (/^G(17|20|21|90|91|93|94)$/.test(head)) continue;
    seen.add(head);
  }
  return [...seen];
}
