/**
 * A dialect-aware glossary for G-code, and a curated catalogue of blocks the
 * user can insert into the custom program start/end (Machine Settings).
 *
 * Two jobs, one knowledge base:
 *
 *  1. **Explain** — annotate whatever is already in the custom-G-code box. Most
 *     shops don't author a start block; they paste one from a forum post or a
 *     machine vendor and could not say what half of it does. Naming each line,
 *     and flagging the ones the *selected controller* will reject, turns an
 *     inherited incantation into something readable.
 *  2. **Pick** — offer a short list of blocks that are correct for the selected
 *     post, rather than a blank textarea whose entire help today is the
 *     placeholder `e.g. G54 ; work offset`.
 *
 * Why this is ours and not a dependency: the only question that matters here is
 * "will the controller selected three fields up in this very dialog accept this
 * word", and that is a fact about RapidCAM's post list, not about G-code. The
 * general-purpose references are built for industrial controls (Fanuc, Haas,
 * Mazak) and would happily explain canned cycles `G81`-`G89` or `M98`
 * subprograms to a GRBL user whose controller errors on them — worse than
 * saying nothing. Scope beats breadth for this feature.
 *
 * Deliberately self-contained: pure data and pure functions, no DOM, and its only
 * import is {@link ./gcodeWords}, which is itself pure. That keeps it unit-testable
 * with no environment, reusable by the export inspector / aiCheck / llms.txt later,
 * and extractable as a pair if a second consumer ever appears.
 *
 * This module reads words but resolves no motion — no modal state, no position, no
 * arc maths — because annotating a line asks a different question than resolving a
 * move. The motion parsers (cam/lint.ts, cam/gcodeMotion.ts, cam/gcodePath.ts,
 * cam/timeEstimate.ts) keep their documented reasons to differ from each other;
 * what they now share, via gcodeWords, is the one definition of a word.
 *
 * ---
 *
 * **How this table is maintained: on demand, never by bulk import.**
 *
 * Bulk-importing a published G-code reference was considered and rejected. The
 * content splits by volatility, and the split is unkind to that idea: what a word
 * MEANS is effectively frozen (G54 has meant work offset 1 for decades), while
 * whether OUR four controllers accept it genuinely does change with firmware
 * releases and build flags — and the published references cover industrial
 * controls, not GRBL or Smoothie, so they say nothing about the half that moves.
 * Importing them would add frozen prose we'd rewrite anyway, plus unverified
 * claims in text whose entire job is telling someone whether a move is safe.
 *
 * So grow it from real demand. {@link annotate} already reports `"unknown"` for
 * anything absent, which fails safe ("check your controller's manual") and is the
 * signal: add the codes people actually paste, with support checked against the
 * four controllers we post to.
 *
 * When reviewing the table for staleness, review the `"no"` entries first. Those
 * are the ones that raise errors, and a false error is worse than a missing entry
 * — it teaches people to click through the pre-flight warnings, which is how the
 * G53 misreading in cam/lint.ts would have done real damage. A stale `"yes"` just
 * stays quiet.
 */

import { lexWords, stripComments, WORD_RE, type GWord as RawWord } from "./gcodeWords";

// --- posts and dialects ------------------------------------------------------

/**
 * Every post id the app can have stored, from the two registries: the mill
 * dropdown (ui/postSettingsDialog MILL_POST_OPTIONS) and cam/laserposts.
 * `"grbl"` doubles as a legacy laser value — see laserposts/index.getLaserPost.
 */
export type PostId =
  | "linuxcnc"
  | "grbl"
  | "grbl-dynamic"
  | "grbl-constant"
  | "marlin"
  | "smoothie"
  | "linuxcnc-laser";

/**
 * The controller *family* a post belongs to. Meaning and support are properties
 * of the firmware, not of the head, so the mill and laser GRBL posts share one
 * dialect — what differs between them (M3 vs M4, inline S) is emission, which
 * the posts already own.
 */
export type Dialect = "grbl" | "linuxcnc" | "marlin" | "smoothie";

export const DIALECTS: readonly Dialect[] = ["grbl", "linuxcnc", "marlin", "smoothie"];

/** Human label for a dialect, for messages the user reads. */
export const DIALECT_LABEL: Readonly<Record<Dialect, string>> = {
  grbl: "GRBL / FluidNC",
  linuxcnc: "LinuxCNC",
  marlin: "Marlin",
  smoothie: "Smoothieware",
};

/**
 * Resolve a stored post id to its controller family. Unknown ids fall back to
 * GRBL — the app's most common controller and the laser default — matching what
 * laserposts/index.getLaserPost already does for unrecognised values.
 */
export function dialectOf(postId: string | undefined): Dialect {
  switch (postId) {
    case "linuxcnc":
    case "linuxcnc-laser":
      return "linuxcnc";
    case "marlin":
      return "marlin";
    case "smoothie":
      return "smoothie";
    default:
      return "grbl";
  }
}

// --- the word table ----------------------------------------------------------

/**
 * Whether a controller accepts a word.
 *
 * `"optional"` is the honest third state and earns its place: several codes
 * exist in Marlin and Smoothieware only when a firmware build flag is set
 * (`CNC_COORDINATE_SYSTEMS`, `LASER_FEATURE`). Collapsing those into "yes" would
 * tell a user their block is fine when their own binary will reject it;
 * collapsing into "no" would nag people whose firmware does support it.
 */
export type SupportLevel = "yes" | "no" | "optional";

export interface GlossaryEntry {
  /** Normalised code, e.g. `"G0"`, `"G38.2"`, `"M3"`. */
  code: string;
  /** Short name, e.g. "Work coordinate system 1". */
  title: string;
  /** One plain sentence: what the machine does. No jargon that needs its own lookup. */
  summary: string;
  /** Word letters this code reads, when it takes any. */
  params?: readonly { letter: string; meaning: string }[];
  support: Readonly<Record<Dialect, SupportLevel>>;
  /**
   * The controller-specific note, shown ONLY for the selected dialect.
   *
   * Two jobs, and both need the scoping. For a dialect that accepts the code it
   * says how the behaviour differs — the field that justifies the whole module,
   * since a word both controllers accept that does something different on each
   * is far more dangerous than a word one rejects outright. For a dialect that
   * rejects it, it says what to use instead.
   *
   * Contrast {@link caution}, which is shown on EVERY controller and must
   * therefore be true on all of them. Putting "GRBL rejects this" there meant a
   * LinuxCNC user got a warning on a code their machine runs perfectly.
   */
  divergence?: Readonly<Partial<Record<Dialect, string>>>;
  /** Safety note shown on EVERY controller — so it must hold true on all of them.
   *  Anything true of only one belongs in {@link divergence}. */
  caution?: string;
  /**
   * True when RapidCAM's own generator emits this code. Drives two things: the
   * catalogue never offers it (a second `M5` in a start block stops the spindle
   * the post just started), and the drift guard in test/gcodeGlossary.test.ts
   * asserts this set matches what cam/gcode.ts + the posts actually write.
   */
  emitted?: boolean;
}

const ALL: Record<Dialect, SupportLevel> = {
  grbl: "yes",
  linuxcnc: "yes",
  marlin: "yes",
  smoothie: "yes",
};
/**
 * **When `"no"` is allowed.**
 *
 * `"no"` renders as an error, and a false error is the worst thing this module
 * can produce — it teaches people to click through the pre-flight warnings. So
 * it is reserved for absences we can actually source: GRBL and LinuxCNC publish
 * curated lists of the codes they accept, and they are the two mill posts.
 *
 * Marlin and Smoothieware get `"optional"` for CNC-specific codes instead. Both
 * are 3D-printer firmwares whose CNC features are almost entirely build-flag or
 * config gated (`G38_PROBE_TARGET`, `BEZIER_CURVE_SUPPORT`, `CNC_COORDINATE_SYSTEMS`,
 * `COOLANT_CONTROL`, Smoothie switch modules), so "your build may not have this"
 * is both true and safe, where "does not support" is a claim about someone
 * else's binary that we cannot check. The failure biases toward saying too
 * little, which is the harmless direction.
 *
 * test/gcodeGlossary.test.ts pins the exact set of `"no"` claims, so adding one
 * has to be deliberate.
 */
const CNC_ONLY: Record<Dialect, SupportLevel> = {
  grbl: "yes",
  linuxcnc: "yes",
  marlin: "optional",
  smoothie: "optional",
};
const LINUXCNC_ONLY: Record<Dialect, SupportLevel> = {
  grbl: "no",
  linuxcnc: "yes",
  marlin: "optional",
  smoothie: "optional",
};

export const GLOSSARY: readonly GlossaryEntry[] = [
  // --- motion (all emitted by the generator) ---
  {
    code: "G0",
    title: "Rapid move",
    summary: "Move to the given point as fast as the machine can. Not a cutting move.",
    params: [
      { letter: "X", meaning: "target X" },
      { letter: "Y", meaning: "target Y" },
      { letter: "Z", meaning: "target Z" },
    ],
    support: ALL,
    caution: "A rapid below the surface ploughs through material — retract Z first.",
    emitted: true,
  },
  {
    code: "G1",
    title: "Feed move (straight line)",
    summary: "Move in a straight line at the programmed feed rate. This is a cutting move.",
    params: [
      { letter: "X", meaning: "target X" },
      { letter: "Y", meaning: "target Y" },
      { letter: "Z", meaning: "target Z" },
      { letter: "F", meaning: "feed rate, mm/min" },
    ],
    support: ALL,
    emitted: true,
  },
  {
    code: "G2",
    title: "Arc, clockwise",
    summary: "Cut a clockwise arc to the target point, curving around a centre.",
    params: [
      { letter: "X", meaning: "target X" },
      { letter: "Y", meaning: "target Y" },
      { letter: "I", meaning: "centre X offset FROM the start point" },
      { letter: "J", meaning: "centre Y offset FROM the start point" },
    ],
    support: ALL,
    caution: "I and J are relative to where the arc starts, not absolute coordinates.",
    emitted: true,
  },
  {
    code: "G3",
    title: "Arc, counter-clockwise",
    summary: "Cut a counter-clockwise arc to the target point, curving around a centre.",
    params: [
      { letter: "X", meaning: "target X" },
      { letter: "Y", meaning: "target Y" },
      { letter: "I", meaning: "centre X offset FROM the start point" },
      { letter: "J", meaning: "centre Y offset FROM the start point" },
    ],
    support: ALL,
    emitted: true,
  },
  {
    code: "G5",
    title: "Cubic spline",
    summary: "Cut a cubic Bezier curve directly, without flattening it into line segments.",
    support: LINUXCNC_ONLY,
    divergence: {
      linuxcnc: "Your post emits this for engraved curves; the others flatten them to G1 segments.",
      grbl: "GRBL has no spline support — RapidCAM flattens curves to G1 segments for it instead.",
      marlin: "Marlin's G5 is a Bezier curve behind the BEZIER_CURVE_SUPPORT build flag.",
    },
    emitted: true,
  },
  {
    code: "G4",
    title: "Dwell (pause)",
    summary: "Hold still for a set time, then carry on.",
    params: [{ letter: "P", meaning: "seconds to wait (milliseconds on some firmware)" }],
    support: ALL,
    divergence: {
      grbl: "P is seconds.",
      linuxcnc: "P is seconds.",
      marlin: "P is milliseconds; S is seconds.",
      smoothie: "P is seconds.",
    },
  },

  // --- modal setup (emitted in the header) ---
  {
    code: "G17",
    title: "Select the XY plane",
    summary: "Arcs curve in the XY plane. This is the normal setting for a router or laser.",
    support: ALL,
    emitted: true,
  },
  {
    code: "G20",
    title: "Units: inches",
    summary: "Every coordinate from here on is read as inches.",
    support: ALL,
    caution:
      "RapidCAM posts everything in millimetres and emits G21. A G20 in a custom block " +
      "silently reinterprets the whole program 25.4x too large.",
  },
  {
    code: "G21",
    title: "Units: millimetres",
    summary: "Every coordinate from here on is read as millimetres.",
    support: ALL,
    emitted: true,
  },
  {
    code: "G90",
    title: "Absolute positioning",
    summary: "Coordinates are positions on the work, not distances from where the tool is now.",
    support: ALL,
    emitted: true,
  },
  {
    code: "G91",
    title: "Incremental positioning",
    summary: "Coordinates are distances to move from the current position.",
    support: ALL,
    caution:
      "RapidCAM's whole program is written in absolute (G90). Leaving G91 active at the " +
      "end of a custom start block makes every following move relative — the toolpath " +
      "walks off the stock.",
  },
  {
    code: "G93",
    title: "Inverse-time feed",
    summary: "F is read as 1 / minutes-for-this-move rather than mm per minute.",
    support: CNC_ONLY,
    caution: "Used by rotary jobs (cam/klein.ts). G94 restores normal feed.",
    emitted: true,
  },
  {
    code: "G94",
    title: "Feed per minute",
    summary: "F is read as millimetres per minute. This is the normal mode.",
    support: ALL,
    emitted: true,
  },

  // --- coordinate systems ---
  {
    code: "G53",
    title: "Move in machine coordinates (this line only)",
    summary:
      "Read this one line's coordinates as raw machine position, ignoring the work offset.",
    support: {
      grbl: "yes",
      linuxcnc: "yes",
      marlin: "optional",
      smoothie: "yes",
    },
    caution:
      "Non-modal: it must be on the SAME line as the move. `G53` alone followed by " +
      "`G0 Z-5` on the next line is an ordinary work-coordinate move to Z-5 — which on a " +
      "typical setup is 5mm into the part.",
  },
  {
    code: "G54",
    title: "Work coordinate system 1",
    summary: "Use work offset 1 — the origin you touched off. The usual default.",
    support: { grbl: "yes", linuxcnc: "yes", marlin: "optional", smoothie: "yes" },
    divergence: { marlin: "Requires the CNC_COORDINATE_SYSTEMS build flag." },
  },
  {
    code: "G55",
    title: "Work coordinate system 2",
    summary: "Use work offset 2 — a second saved origin, e.g. a second fixture.",
    support: { grbl: "yes", linuxcnc: "yes", marlin: "optional", smoothie: "yes" },
  },
  {
    code: "G56",
    title: "Work coordinate system 3",
    summary: "Use work offset 3.",
    support: { grbl: "yes", linuxcnc: "yes", marlin: "optional", smoothie: "yes" },
  },
  {
    code: "G57",
    title: "Work coordinate system 4",
    summary: "Use work offset 4.",
    support: { grbl: "yes", linuxcnc: "yes", marlin: "optional", smoothie: "yes" },
  },
  {
    code: "G58",
    title: "Work coordinate system 5",
    summary: "Use work offset 5.",
    support: { grbl: "yes", linuxcnc: "yes", marlin: "optional", smoothie: "yes" },
  },
  {
    code: "G59",
    title: "Work coordinate system 6",
    summary: "Use work offset 6.",
    support: { grbl: "yes", linuxcnc: "yes", marlin: "optional", smoothie: "yes" },
    divergence: {
      linuxcnc: "LinuxCNC adds G59.1, G59.2 and G59.3; GRBL stops at G59.",
    },
  },
  {
    code: "G92",
    title: "Set current position",
    summary: "Declare that the tool is at the given coordinates, shifting the whole work origin.",
    support: ALL,
    caution:
      "A G92 offset survives after the program ends on most controllers, so the NEXT job " +
      "starts shifted. Prefer a work offset (G54-G59), which is stored deliberately.",
  },

  // --- homing and reference positions — the dangerous ones ---
  {
    code: "G28",
    title: "Go to stored position / home",
    summary: "Meaning depends entirely on the controller — see the note.",
    support: ALL,
    divergence: {
      grbl: "Rapids to the position stored by G28.1. It does NOT run the homing cycle ($H does).",
      linuxcnc: "Rapids to the stored G28 position. It does NOT home the machine.",
      marlin: "Runs the auto-home cycle, moving to the endstops.",
      smoothie: "Runs the homing cycle by default.",
    },
    caution:
      "The most misunderstood code in hobby CNC. On GRBL and LinuxCNC this is a full-speed " +
      "rapid to a saved position, and if that position was never taught it is whatever is in " +
      "memory - often machine zero, straight across the work. On Marlin and Smoothie the same " +
      "line homes the machine instead. Do not copy a G28 between controllers.",
  },
  {
    code: "G38.2",
    title: "Probe toward the workpiece",
    summary: "Move slowly until the probe touches, then stop and record where it happened.",
    params: [
      { letter: "Z", meaning: "how far to probe toward" },
      { letter: "F", meaning: "probing feed rate — keep it slow" },
    ],
    support: { grbl: "yes", linuxcnc: "yes", marlin: "optional", smoothie: "yes" },
    divergence: { marlin: "Requires the G38_PROBE_TARGET build flag and a defined probe." },
    caution:
      "Requires a wired, tested probe. If the probe input is not connected the machine drives " +
      "the full commanded distance into the material.",
  },
  {
    code: "G43",
    title: "Apply tool length offset (from the tool table)",
    summary: "Shift Z by the length stored for tool H in the machine's tool table.",
    params: [{ letter: "H", meaning: "tool table slot to read the length from" }],
    support: { grbl: "no", linuxcnc: "yes", marlin: "optional", smoothie: "optional" },
    divergence: {
      grbl:
        "GRBL has no tool table — use G43.1, which carries the length on the line itself. " +
        "A `G43 H1` inherited from an industrial control is the most common line to find in a " +
        "start block that will not run.",
    },
  },
  {
    code: "G43.1",
    title: "Apply tool length offset (dynamic)",
    summary: "Shift Z by a tool length given on this line, rather than from a tool table.",
    support: { grbl: "yes", linuxcnc: "yes", marlin: "optional", smoothie: "optional" },
    divergence: {
      linuxcnc: "LinuxCNC also has plain G43 with a tool table; GRBL only has G43.1.",
    },
  },
  {
    code: "G49",
    title: "Cancel tool length offset",
    summary: "Clear any tool length offset, so Z means what it says again.",
    support: CNC_ONLY,
  },
  {
    code: "G40",
    title: "Cancel cutter compensation",
    summary: "Stop offsetting the path for tool radius. RapidCAM already offsets its own paths.",
    support: CNC_ONLY,
  },
  {
    code: "G64",
    title: "Path blending",
    summary: "Round off corners slightly to keep the machine moving instead of stopping at each.",
    params: [{ letter: "P", meaning: "how far the path may deviate" }],
    support: LINUXCNC_ONLY,
    divergence: { grbl: "GRBL has no G64 — it blends according to its own $11 setting instead." },
  },
  {
    code: "G80",
    title: "Cancel canned cycle",
    summary: "End any drilling or boring cycle and return to ordinary moves.",
    support: CNC_ONLY,
  },
  {
    code: "G81",
    title: "Drilling cycle",
    summary: "Repeat a drill-and-retract at each point, without spelling out every move.",
    support: LINUXCNC_ONLY,
    divergence: {
      grbl:
        "GRBL supports no canned cycles at all (G81-G89). Spell the moves out, or run the " +
        "drilling as a RapidCAM toolpath. This is the most common thing to find in a start " +
        "block copied from an industrial control.",
    },
  },

  // --- spindle, beam and coolant (emitted per operation) ---
  {
    code: "M3",
    title: "Spindle / beam on, clockwise",
    summary: "Start the spindle clockwise at the speed given by S — or fire the laser at power S.",
    params: [{ letter: "S", meaning: "spindle rpm, or laser power" }],
    support: ALL,
    divergence: {
      marlin: "Laser power scale is 0-255 by default, not 0-1000.",
    },
    emitted: true,
  },
  {
    code: "M4",
    title: "Spindle counter-clockwise / dynamic laser power",
    summary:
      "On a mill, run the spindle backwards. On a GRBL laser, scale beam power with speed.",
    support: { grbl: "yes", linuxcnc: "yes", marlin: "yes", smoothie: "yes" },
    divergence: {
      grbl: "On a laser this is dynamic power mode — power tracks feed, so corners don't burn.",
    },
    emitted: true,
  },
  {
    code: "M5",
    title: "Spindle / beam off",
    summary: "Stop the spindle, or switch the laser off.",
    support: ALL,
    emitted: true,
  },
  // Coolant is a build option on three of the four controllers, so "optional" is
  // the accurate answer rather than a flat yes: GRBL needs ENABLE_M7 for mist,
  // Marlin needs COOLANT_CONTROL for any of it.
  {
    code: "M7",
    title: "Mist coolant on",
    summary: "Switch on the mist coolant output.",
    support: { grbl: "optional", linuxcnc: "yes", marlin: "optional", smoothie: "optional" },
    divergence: {
      grbl: "Mist output exists only in builds compiled with ENABLE_M7.",
      marlin: "Requires the COOLANT_CONTROL build flag.",
      smoothie: "Depends on a switch module being configured for it in config.",
    },
    emitted: true,
  },
  {
    code: "M8",
    title: "Flood coolant on",
    summary: "Switch on the flood coolant output — often wired to air assist or dust collection.",
    support: { grbl: "yes", linuxcnc: "yes", marlin: "optional", smoothie: "yes" },
    divergence: { marlin: "Requires the COOLANT_CONTROL build flag." },
    emitted: true,
  },
  {
    code: "M9",
    title: "Coolant off",
    summary: "Switch off all coolant outputs.",
    support: { grbl: "yes", linuxcnc: "yes", marlin: "optional", smoothie: "yes" },
    divergence: { marlin: "Requires the COOLANT_CONTROL build flag." },
    emitted: true,
  },

  // --- program flow ---
  {
    code: "M0",
    title: "Program pause",
    summary: "Stop and wait for the operator to press resume. Used for a manual tool change.",
    support: ALL,
  },
  {
    code: "M2",
    title: "End program",
    summary: "End the program where it stands.",
    support: ALL,
    caution: "RapidCAM already ends every program with M30. A second ending truncates the job.",
  },
  {
    code: "M6",
    title: "Tool change",
    summary: "Change to the tool selected by T. On a manual machine, pauses for the swap.",
    support: { grbl: "optional", linuxcnc: "yes", marlin: "optional", smoothie: "optional" },
    divergence: {
      grbl:
        "Stock Grbl v1.1 has no M6 at all — it is FluidNC and the grblHAL-style forks that add " +
        "it. Check yours before relying on the program pausing for a tool change.",
    },
  },
  {
    code: "M30",
    title: "End program and rewind",
    summary: "End the program and reset it to the top, ready to run again.",
    support: ALL,
    caution: "RapidCAM emits this itself as the last line. Do not add another.",
    emitted: true,
  },
  {
    code: "M98",
    title: "Call subprogram",
    summary: "Jump to a numbered subprogram and come back when it returns.",
    support: { grbl: "no", linuxcnc: "no", marlin: "no", smoothie: "no" },
    caution:
      "None of RapidCAM's controllers support M98/M99. LinuxCNC uses O-codes for subroutines " +
      "instead; GRBL has no subprograms at all.",
  },
];

const BY_CODE: ReadonlyMap<string, GlossaryEntry> = new Map(GLOSSARY.map((e) => [e.code, e]));

/** Look up a normalised code (`"G0"`, `"G38.2"`). Undefined when not in the table. */
export function lookup(code: string): GlossaryEntry | undefined {
  return BY_CODE.get(code.toUpperCase());
}

/**
 * Codes RapidCAM's own generator writes. The catalogue never offers these, and
 * test/gcodeGlossary.test.ts asserts this set equals what cam/gcode.ts,
 * cam/klein.ts and the two post registries actually emit — so adding an M-code
 * to a post without documenting it fails the build rather than drifting.
 */
export const EMITTED_BY_GENERATOR: ReadonlySet<string> = new Set(
  GLOSSARY.filter((e) => e.emitted).map((e) => e.code),
);

// --- lexer -------------------------------------------------------------------

/** A lexed word, plus the canonical code when the letter names an action. */
export interface GlossaryWord extends RawWord {
  /** Normalised code for `G`/`M` words, else undefined. */
  code?: string;
}

/**
 * Normalise a G/M word to its canonical code: `G01` -> `G1`, `M03` -> `M3`,
 * while `G38.2` and `G59.3` keep their decimals, because those are distinct
 * codes rather than formatting noise.
 */
function normalizeCode(letter: string, value: number): string {
  return letter + String(value);
}

/** Lexical pass over one line — no modal state, no position. See the module note. */
export function lexLine(line: string): GlossaryWord[] {
  return lexWords(line).map((w) => {
    const word: GlossaryWord = { ...w };
    if (w.letter === "G" || w.letter === "M") word.code = normalizeCode(w.letter, w.value);
    return word;
  });
}

// --- annotation --------------------------------------------------------------

export type LineStatus =
  | "blank"
  | "comment"
  | "ok"
  | "caution"
  | "unsupported"
  | "optional"
  | "unknown";

export interface AnnotatedLine {
  /** 1-based line number within the block. */
  n: number;
  text: string;
  status: LineStatus;
  /** The action code this line carries, when it has one. */
  code?: string;
  title?: string;
  summary?: string;
  /** Controller-specific meaning or caveat, already resolved for the chosen post. */
  note?: string;
}

/**
 * Explain each line of a custom block for one controller. Pure — feed it the
 * textarea's value and the selected post id, render the result beside the box.
 *
 * A line with several action words (`G53 G0 X0 Y0`) is annotated on the FIRST
 * one, because that is the word that changes what the line means; the rest are
 * modifiers on it.
 */
export function annotate(block: string, postId: string | undefined): AnnotatedLine[] {
  const dialect = dialectOf(postId);
  return block.split(/\r?\n/).map((text, i) => {
    const n = i + 1;
    if (!text.trim()) return { n, text, status: "blank" as const };
    if (!stripComments(text).trim()) return { n, text, status: "comment" as const };

    const words = lexLine(text);
    const action = words.find((w) => w.code);
    if (!action?.code) {
      // Words with no G/M — a bare `F1000` or `S12000` line, which is legal and
      // simply sets a modal value.
      const letters = words.map((w) => w.letter).join("");
      return {
        n,
        text,
        status: "ok" as const,
        summary: letters
          ? `Sets ${letters.split("").join(", ")} without commanding a move.`
          : "No G-code words on this line.",
      };
    }

    const entry = lookup(action.code);
    if (!entry) {
      return {
        n,
        text,
        status: "unknown" as const,
        code: action.code,
        note: `${action.code} is not in RapidCAM's reference. Check your controller's manual before running it.`,
      };
    }

    const support = entry.support[dialect];
    const divergence = entry.divergence?.[dialect];
    const note = [divergence, entry.caution].filter(Boolean).join(" ") || undefined;

    const status: LineStatus =
      support === "no"
        ? "unsupported"
        : support === "optional"
          ? "optional"
          : entry.caution || divergence
            ? "caution"
            : "ok";

    return {
      n,
      text,
      status,
      code: entry.code,
      title: entry.title,
      summary: entry.summary,
      note:
        support === "no"
          ? `${DIALECT_LABEL[dialect]} does not support ${entry.code}. ${note ?? ""}`.trim()
          : support === "optional"
            ? `${DIALECT_LABEL[dialect]} supports ${entry.code} only if the matching firmware option is enabled. ${note ?? ""}`.trim()
            : note,
    };
  });
}

// --- the catalogue -----------------------------------------------------------

export type Slot = "start" | "end";

export interface BlockOption {
  id: string;
  slot: Slot;
  /** Menu label. */
  label: string;
  /** One sentence on why you would want this — shown under the label. */
  blurb: string;
  /** Which machine kinds it makes sense for. */
  machine: "mill" | "laser" | "both";
  caution?: string;
  /**
   * The lines to insert for this controller, or null when it has no equivalent —
   * which is a first-class answer, not a failure. "Home the machine" genuinely
   * has no in-program form on LinuxCNC.
   */
  lines(dialect: Dialect): readonly string[] | null;
}

/**
 * What the catalogue may contain is sharply constrained, and the constraint is
 * the feature: the post already emits G21/G90/G17 in the header and M3/M5,
 * M7/M8/M9, tool changes and M30 through the body. Offering any of those would
 * double-emit, and a second M5 in a start block stops the spindle the post just
 * started.
 *
 * Deliberately NOT offered, and why:
 *  - "Spindle warm-up dwell" — the custom start block runs BEFORE any operation,
 *    so the spindle is not yet on (cam/gcode.ts emits M3 per operation). A dwell
 *    there waits for nothing.
 *  - "Set units / absolute mode" — already in the header, three lines above where
 *    the custom block lands.
 *  - Canned cycles, cutter comp, subprograms — RapidCAM computes its own offset
 *    paths, and GRBL supports none of them.
 */
export const BLOCK_CATALOGUE: readonly BlockOption[] = [
  {
    id: "work-offset",
    slot: "start",
    label: "Select work offset (G54)",
    blurb:
      "Makes the program explicit about which saved origin it uses, instead of inheriting " +
      "whatever the last job left selected.",
    machine: "both",
    lines: (d) =>
      d === "marlin"
        ? null // Marlin needs CNC_COORDINATE_SYSTEMS; don't hand out a line that may error.
        : ["G54 ; use work offset 1 (the origin you touched off)"],
  },
  {
    id: "home",
    slot: "start",
    label: "Home the machine first",
    blurb:
      "Runs the homing cycle so the machine knows where it is before cutting. Requires " +
      "homing switches.",
    machine: "both",
    caution:
      "Homing moves the machine to its limits at speed — make sure the tool can travel there " +
      "without hitting the work or a clamp. On GRBL this is a sender command rather than " +
      "G-code, and senders differ on whether they forward it from inside a file.",
    lines: (d) => {
      switch (d) {
        // $H is a GRBL system command, not G-code. It is the ONLY way to home GRBL
        // from a file; G28 would rapid to a stored position instead. Senders differ
        // on whether they forward it mid-file — checkBlock warns about that.
        case "grbl":
          return ["$H ; run the homing cycle (GRBL system command, not G-code)"];
        // LinuxCNC homes from the UI or an axis config; there is no in-program form.
        // Saying so is more useful than emitting a G28 that means something else.
        case "linuxcnc":
          return null;
        case "marlin":
        case "smoothie":
          return ["G28 ; home all axes"];
      }
    },
  },
  {
    id: "safe-z",
    slot: "start",
    label: "Retract Z to a safe height first",
    blurb:
      "Lifts the tool clear in machine coordinates before anything else moves, so a stale " +
      "position cannot drag it across the work.",
    machine: "mill",
    lines: (d) =>
      d === "grbl" || d === "linuxcnc" || d === "smoothie"
        ? ["G53 G0 Z-5 ; rapid to 5mm below machine Z zero (adjust for your machine)"]
        : null,
    caution:
      "G53 is non-modal — it must stay on the same line as the G0. Check the value suits " +
      "your machine: Z-5 assumes machine zero is at the top of travel.",
  },
  {
    id: "unlock",
    slot: "start",
    label: "Clear alarm lock",
    blurb: "Releases GRBL's soft lock after a reset or a triggered limit, so the job can start.",
    machine: "both",
    caution:
      "Only add this if you understand why the machine is in alarm. Clearing the lock without " +
      "homing leaves the controller with no idea where it is.",
    lines: (d) => (d === "grbl" ? ["$X ; clear alarm lock (GRBL system command)"] : null),
  },
  {
    id: "dust-on",
    slot: "start",
    label: "Accessory / dust collection on (M8)",
    blurb:
      "Switches the flood-coolant output on for the whole job — the usual wiring for a dust " +
      "shoe or air assist relay.",
    machine: "both",
    caution:
      "If coolant is enabled in Machine Settings the post already drives M8/M9 per operation, " +
      "and this will fight it.",
    lines: () => ["M8 ; accessory output on (dust collection / air)"],
  },
  {
    id: "park-work",
    slot: "end",
    label: "Park at the work origin",
    blurb: "Returns the tool over X0 Y0 so the part is easy to reach and measure.",
    machine: "both",
    lines: () => ["G0 X0 Y0 ; park over the work origin"],
    caution: "Z is left wherever the program finished — pair this with a Z retract.",
  },
  {
    id: "park-machine",
    slot: "end",
    label: "Park at a machine position",
    blurb:
      "Moves to a fixed spot on the table regardless of where the work origin is — usually " +
      "the front of the machine, to unload.",
    machine: "both",
    lines: (d) =>
      d === "grbl" || d === "linuxcnc" || d === "smoothie"
        ? [
            "G53 G0 Z-5 ; lift clear in machine coordinates",
            "G53 G0 X0 Y0 ; park at the machine origin",
          ]
        : null,
  },
  {
    id: "dust-off",
    slot: "end",
    label: "Accessory / dust collection off (M9)",
    blurb: "Switches the accessory output back off at the end of the job.",
    machine: "both",
    caution: "Pair this with the matching start block; the post emits its own M9 when coolant is on.",
    lines: () => ["M9 ; accessory output off"],
  },
];

/** Catalogue entries available for one slot, machine kind and controller. */
export function blocksFor(
  slot: Slot,
  machine: "mill" | "laser",
  postId: string | undefined,
): { option: BlockOption; lines: readonly string[] }[] {
  const dialect = dialectOf(postId);
  const out: { option: BlockOption; lines: readonly string[] }[] = [];
  for (const option of BLOCK_CATALOGUE) {
    if (option.slot !== slot) continue;
    if (option.machine !== "both" && option.machine !== machine) continue;
    const lines = option.lines(dialect);
    if (lines) out.push({ option, lines });
  }
  return out;
}

// --- block checks ------------------------------------------------------------

export interface BlockFinding {
  code: string;
  severity: "error" | "warning";
  message: string;
  /** 1-based line within the block. */
  line?: number;
}

export interface CheckOptions {
  postId?: string;
  slot: Slot;
  /** Whether Machine Settings has coolant enabled — the post then drives M7/M8/M9 itself. */
  coolantEnabled?: boolean;
}

/**
 * The part of a line the lexer could not account for — text that is not a word.
 *
 * A G-code line is letter+number pairs and nothing else, so anything left over
 * is a typo. This matters because the leftovers are SILENT otherwise: `Gq9999`
 * lexes to the single word `Q9999` (the `G` is orphaned and dropped, and `Q` is
 * not a code we check), and `G1 X10 F` quietly loses its valueless `F`. Neither
 * produced a single finding — the field accepted gibberish without a word.
 *
 * Returns "" for a clean line.
 */
function unlexedResidue(line: string): string {
  const bare = stripComments(line);
  let out = "";
  let cursor = 0;
  for (const m of bare.matchAll(WORD_RE)) {
    out += bare.slice(cursor, m.index);
    cursor = m.index + m[0].length;
  }
  return (out + bare.slice(cursor)).trim();
}

const WORK_OFFSETS = new Set(["G54", "G55", "G56", "G57", "G58", "G59"]);

/**
 * The once-per-program setup modals — the only emitted codes worth a duplication
 * warning. Motion words are emitted constantly and a park block is *made* of
 * them, so warning on `emitted` alone would flag the catalogue's own suggestions.
 */
const SETUP_MODALS = new Set(["G17", "G21", "G90", "G93", "G94"]);

/**
 * Check a custom start/end block for the mistakes that actually happen. These are
 * cheap predicates over one small block, so they can run on every keystroke.
 */
export function checkBlock(block: string, opts: CheckOptions): BlockFinding[] {
  const dialect = dialectOf(opts.postId);
  const findings: BlockFinding[] = [];
  const lines = block.split(/\r?\n/);
  const offsetsSeen: number[] = [];

  lines.forEach((text, i) => {
    const n = i + 1;
    const bare = stripComments(text);
    if (!bare.trim()) return;

    // Not G-code at all. Checked FIRST and reported as an error, because every
    // check below reasons about recognised words and therefore has nothing to
    // say about a line that has none.
    //
    // `$`/`%` lines are exempt: `$H`/`$X` are GRBL system commands (the picker
    // emits one) and `%` is a program delimiter. Neither is letter+number, and
    // neither is a mistake.
    //
    // A well-formed code we simply don't document is NOT flagged here. `G10 L20
    // P1 X0` is a perfectly good start-block line that is absent from the table,
    // and "unknown to RapidCAM" is not the same claim as "wrong" — saying so
    // would be the false-warning problem this field already had once.
    const residue = unlexedResidue(text);
    if (residue && !/^[$%]/.test(bare.trim())) {
      findings.push({
        code: "malformed-line",
        severity: "error",
        line: n,
        message:
          `Line ${n} is not valid G-code: "${residue}" is not a word the controller can read. ` +
          `A line is letter-and-number pairs (G0, X10, F600) — check for a typo.`,
      });
      return;
    }

    // A word written without a space (`G0X10Y20`) is legal on GRBL, but RapidCAM's
    // pre-flight parser splits on whitespace (cam/lint.ts parseMoves), so the whole
    // line collapses to one unparseable token and the coordinates are lost — that
    // move is then invisible to the out-of-bounds and over-deep checks. The
    // generator always emits spaces, so this only ever bites hand-typed text, which
    // is exactly what this box holds. Matches a number butted straight against the
    // next word's letter, so it catches partial cases (`G0 X10Y20`) too.
    if (/[A-Za-z]\s*-?(?:\d+(?:\.\d+)?|\.\d+)[A-Za-z]/.test(bare)) {
      findings.push({
        code: "no-space-words",
        severity: "warning",
        line: n,
        message:
          `Line ${n} runs words together (${bare.trim()}). Your controller accepts it, but ` +
          `RapidCAM's pre-flight check cannot read it, so this move is skipped by the ` +
          `out-of-bounds and depth checks. Put spaces between the words.`,
      });
    }

    for (const w of lexLine(text)) {
      if (!w.code) continue;
      const entry = lookup(w.code);

      if (WORK_OFFSETS.has(w.code)) offsetsSeen.push(n);

      if (!entry) continue;

      if (entry.support[dialect] === "no") {
        findings.push({
          code: "unsupported-code",
          severity: "error",
          line: n,
          message:
            `${DIALECT_LABEL[dialect]} does not support ${w.code} (${entry.title}) — ` +
            `line ${n} will be rejected by the controller.`,
        });
      }

      // G20 deserves its own error rather than the generic "already emitted"
      // warning: it does not merely duplicate the header, it inverts it, and the
      // failure is a silent 25.4x scale error across the whole program.
      if (w.code === "G20") {
        findings.push({
          code: "inches-in-custom-block",
          severity: "error",
          line: n,
          message:
            `Line ${n} switches the controller to inches (G20). RapidCAM posts in ` +
            `millimetres — every coordinate after this is read 25.4x too large.`,
        });
        continue;
      }

      if (w.code === "M30" || w.code === "M2") {
        findings.push({
          code: "premature-end",
          severity: "error",
          line: n,
          message:
            `Line ${n} ends the program (${w.code}). RapidCAM emits M30 itself as the last ` +
            `line, so everything after this point never runs.`,
        });
        continue;
      }

      if (w.code === "G91") {
        findings.push({
          code: "incremental-left-active",
          severity: "warning",
          line: n,
          message:
            `Line ${n} switches to incremental positioning (G91). The rest of the program is ` +
            `written in absolute coordinates — add G90 before the block ends.`,
        });
        continue;
      }

      const coolantWord = w.code === "M7" || w.code === "M8" || w.code === "M9";
      if (coolantWord && opts.coolantEnabled) {
        findings.push({
          code: "coolant-conflict",
          severity: "warning",
          line: n,
          message:
            `Coolant is enabled in Machine Settings, so RapidCAM already switches ${w.code} ` +
            `per operation. Line ${n} will fight it — either remove it, or turn coolant off ` +
            `and drive the output from here.`,
        });
        continue;
      }

      // Spindle/beam control belongs to the post, which starts it per operation and
      // stops it at program end. A custom block that also drives it leaves the
      // spindle running outside the generator's model — including, for a start
      // block, before any toolpath has positioned the tool.
      if (w.code === "M3" || w.code === "M4" || w.code === "M5") {
        findings.push({
          code: "spindle-in-custom-block",
          severity: "warning",
          line: n,
          message:
            `Line ${n} controls the spindle/beam (${w.code}). RapidCAM already starts it per ` +
            `toolpath and stops it at the end, so this runs outside its control — in a start ` +
            `block it spins up before the first move is positioned.`,
        });
        continue;
      }

      if (SETUP_MODALS.has(w.code)) {
        findings.push({
          code: "already-emitted",
          severity: "warning",
          line: n,
          message:
            `RapidCAM already emits ${w.code} (${entry.title}) in the program header. ` +
            `Line ${n} duplicates it.`,
        });
      }
    }

  });

  if (offsetsSeen.length > 1) {
    findings.push({
      code: "duplicate-work-offset",
      severity: "warning",
      line: offsetsSeen[1],
      message:
        `This block selects a work offset ${offsetsSeen.length} times (lines ` +
        `${offsetsSeen.join(", ")}). Only the last one takes effect.`,
    });
  }

  const order = { error: 0, warning: 1 } as const;
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}
