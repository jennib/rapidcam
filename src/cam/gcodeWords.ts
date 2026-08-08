/**
 * The one definition of a G-code *word* — a letter and the number attached to it.
 *
 * This is deliberately the lexical layer ONLY: no modal state, no position, no
 * arc maths. Those live in the modules that need them, and they legitimately
 * differ — {@link ../cam/lint} tracks position through commented move lines,
 * {@link ../cam/gcodeMotion} treats commented lines as opaque to preserve their
 * bytes for tiling, {@link ../cam/gcodePath} and {@link ../cam/timeEstimate}
 * resolve motion for drawing and duration. What none of them should disagree
 * about is what counts as a word, so that fact lives here once.
 *
 * The tolerant grammar is the point. Controllers accept `G0X10Y20` with no
 * delimiters and `X 10` with a gap, and RapidCAM's own posts always write neither
 * — they emit exactly one space between words. So this leniency exists purely for
 * text a HUMAN typed, which reaches the program through the custom start/end
 * blocks in Machine Settings (core/prefs.ts, injected verbatim by gcode.ts
 * customLines). A parser that reads `G0X10Y20` as one opaque token silently drops
 * the coordinates, and the move then slips past every geometric pre-flight check.
 */

/**
 * One word: a letter, optional whitespace, then a signed decimal. Anchored on
 * nothing — words may butt directly against each other, which is what makes
 * `G0X10Y20` scan correctly as three words.
 */
export const WORD_RE = /([A-Za-z])\s*(-?\d*\.?\d+)/g;

/**
 * Strip both comment syntaxes: `(...)` inline, and `;` to end of line.
 *
 * Both must go before scanning. A parenthetical comment can legally contain text
 * that looks like a word — `(rapid to X120 first)` — and a scanner that does not
 * remove it reads a coordinate out of prose.
 */
export function stripComments(line: string): string {
  return line.replace(/\([^)]*\)/g, " ").split(";")[0];
}

export interface GWord {
  /** Upper-cased address letter. */
  letter: string;
  value: number;
  /** Offset within the comment-stripped line. */
  index: number;
}

/** Scan one line into its words, comments removed. */
export function lexWords(line: string): GWord[] {
  const code = stripComments(line);
  const out: GWord[] = [];
  for (const m of code.matchAll(WORD_RE)) {
    const value = Number.parseFloat(m[2]);
    if (!Number.isFinite(value)) continue;
    out.push({ letter: m[1].toUpperCase(), value, index: m.index });
  }
  return out;
}

/**
 * One line's words as a letter→value lookup, which is what the modal
 * interpreters ({@link ../cam/gcodePath}, {@link ../cam/timeEstimate}) want: they
 * ask "does this line set X?" rather than walking the words in order.
 *
 * A repeated letter keeps its LAST value, matching how a controller reads the
 * line and how the two hand-rolled copies this replaces behaved.
 */
export function wordMap(line: string): Map<string, number> {
  const words = new Map<string, number>();
  for (const w of lexWords(line)) words.set(w.letter, w.value);
  return words;
}
