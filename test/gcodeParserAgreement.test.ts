/**
 * Differential cover for the five modules that read G-code text.
 *
 * They are deliberately NOT one parser — each answers a different question, and
 * each has a documented reason to differ (position through comments for the
 * linter, byte preservation for tiling, arc resolution for the backplot, feeds
 * for the estimate, axis rewriting for the rotary wrap). What they must never do
 * is disagree about what the *input* says.
 *
 * That is not hypothetical. Three separate bugs lived in this seam:
 *
 *  - cam/lint.ts split on whitespace, so `G0X10Y20` was one opaque token and the
 *    move was invisible to every geometric check;
 *  - cam/klein.ts parsed words out of `(...)` comments, turning a line that only
 *    described a position into a commanded rapid, and wrapped `G53` machine
 *    coordinates into a rotary angle;
 *  - cam/gcodeMotion.ts dropped every run-together move AND failed to report it,
 *    because `unsupportedMotions`' `\b[XYZ]` guard cannot match inside `G0X120`.
 *
 * Every one of them only bites on hand-typed text — and the custom program
 * start/end blocks (Machine Settings) inject exactly that, verbatim, into every
 * posted program, where all five then read it back.
 *
 * So the corpus below is written in the awkward forms a person types, and each
 * case asserts the readers agree. A parser that stops seeing a move is the
 * dangerous direction: it does not fail loudly, it quietly stops checking.
 */

import { describe, expect, test } from "vitest";
import { lintGCode, type LintContext } from "../src/cam/lint";
import { parseGcodePath } from "../src/cam/gcodePath";
import { estimateGCodeTime } from "../src/cam/timeEstimate";
import { parseProgram, unsupportedMotions } from "../src/cam/gcodeMotion";
import { wrapGCode, defaultRotarySettings } from "../src/cam/klein";
import { CADDocument } from "../src/model/document";

const CTX: LintContext = {
  bounds: { xMin: 0, xMax: 100, yMin: 0, yMax: 80 },
  zTop: 0,
  zBottom: -10,
  machineKind: "mill",
};

const ROTARY = defaultRotarySettings(new CADDocument({ width: 200, height: 200 }));

/** Number of position-resolved moves gcodeMotion finds. */
const motionMoves = (g: string) =>
  parseProgram(g).events.filter((e) => e.kind === "move").length;

/** Motion lines the rotary wrap emits. */
const wrappedMoves = (g: string) =>
  wrapGCode(g, ROTARY, {}).split("\n").filter((l) => /^G[0-3]\b/.test(l)).length;

// The same four moves, written three ways a person might type them.
const SPACED = ["G21", "G90", "G0 Z5", "G0 X120 Y10", "G1 Z-3 F300", "G1 X50 Y40 F600"];
const TOGETHER = ["G21", "G90", "G0Z5", "G0X120Y10", "G1Z-3F300", "G1X50Y40F600"];
const GAPPED = ["G21", "G90", "G0 Z 5", "G0 X 120 Y 10", "G1 Z -3 F 300", "G1 X 50 Y 40 F 600"];

describe("the readers agree about the same program written three ways", () => {
  test("the linter reaches the same verdict", () => {
    // A cut at X120 is off a 100mm stock. Every spelling must be caught.
    for (const [label, lines] of [
      ["spaced", SPACED],
      ["run-together", TOGETHER],
      ["gapped", GAPPED],
    ] as const) {
      const codes = lintGCode(lines.join("\n"), CTX).map((f) => f.code);
      expect(codes, `${label} spelling`).toContain("out-of-bounds");
    }
  });

  test("the backplot draws the same extent", () => {
    const spaced = parseGcodePath(SPACED.join("\n")).bounds;
    expect(parseGcodePath(TOGETHER.join("\n")).bounds).toEqual(spaced);
    expect(parseGcodePath(GAPPED.join("\n")).bounds).toEqual(spaced);
  });

  test("the time estimate is the same", () => {
    const spaced = estimateGCodeTime(SPACED.join("\n")).seconds;
    expect(estimateGCodeTime(TOGETHER.join("\n")).seconds).toBeCloseTo(spaced, 6);
    expect(estimateGCodeTime(GAPPED.join("\n")).seconds).toBeCloseTo(spaced, 6);
  });

  test("tiling finds the same moves", () => {
    // This is the regression: run-together lines used to yield ZERO moves, so a
    // tiled job silently passed them through untranslated.
    const spaced = motionMoves(SPACED.join("\n"));
    expect(spaced).toBeGreaterThan(0);
    expect(motionMoves(TOGETHER.join("\n"))).toBe(spaced);
    expect(motionMoves(GAPPED.join("\n"))).toBe(spaced);
  });

  test("the rotary wrap emits the same number of moves", () => {
    const spaced = wrappedMoves(SPACED.join("\n"));
    expect(spaced).toBeGreaterThan(0);
    expect(wrappedMoves(TOGETHER.join("\n"))).toBe(spaced);
    expect(wrappedMoves(GAPPED.join("\n"))).toBe(spaced);
  });

  test("nothing reports the run-together program as unclippable", () => {
    // It is ordinary G0/G1 motion; only the spacing differed.
    expect(unsupportedMotions(TOGETHER.join("\n"))).toEqual([]);
    expect(unsupportedMotions(SPACED.join("\n"))).toEqual([]);
  });

  test("a motion this module cannot clip is reported however it is spelled", () => {
    // G5 is a LinuxCNC spline: tiling cannot clip it, and the export warns rather
    // than mis-clipping. The old coordinate test was a `\b[XYZ]` regex, whose word
    // boundary cannot match inside `G5I1J2...X10`, so the run-together spelling
    // reported nothing at all — the silent version of the failure this check
    // exists to prevent.
    const spaced = ["G0 Z5", "G5 I1 J2 P0 Q0 X10 Y20 F600"].join("\n");
    const together = ["G0 Z5", "G5I1J2P0Q0X10Y20F600"].join("\n");
    expect(unsupportedMotions(spaced)).toEqual(["G5"]);
    expect(unsupportedMotions(together)).toEqual(["G5"]);
  });
});

describe("comments are never read as motion", () => {
  // `(...)` is the other standard comment syntax. RapidCAM writes `;`, so this
  // only arrives via a custom block or a hand-edited file.
  // The comment must contain a full motion word, not just coordinates: klein's
  // lexer needs a `G`+digits to form a move at all, so prose like "rapid to X120"
  // could never reproduce the bug and a corpus using it would test nothing.
  // Mutation-testing this file is what exposed that — the assertion passed with
  // the fix reverted.
  const PAREN = ["G0 Z5", "(then G0 X120 Y10)", "G0 X50 Y40", "G1 Z-3 F300"].join("\n");
  const SEMI = ["G0 Z5", "; then G0 X120 Y10", "G0 X50 Y40", "G1 Z-3 F300"].join("\n");

  test("the linter does not invent an off-stock move", () => {
    expect(lintGCode(PAREN, CTX)).toEqual([]);
    expect(lintGCode(SEMI, CTX)).toEqual([]);
  });

  test("the backplot does not draw to a mentioned coordinate", () => {
    expect(parseGcodePath(PAREN).bounds?.max.x).toBe(50);
    expect(parseGcodePath(SEMI).bounds?.max.x).toBe(50);
  });

  test("the rotary wrap does not turn a comment into a rapid", () => {
    // The bug: `(then rapid to X120 Y10)` came out as `G0 X120 A…`, so the
    // machine moved to a position the file only described.
    const out = wrapGCode(PAREN, ROTARY, {});
    expect(out).toContain("(then G0 X120 Y10)");
    expect(out).not.toMatch(/^G0 X120/m);
    // Positive control: the real moves DID still get wrapped.
    expect(out).toMatch(/A[\d.]/);
  });

  test("an inline comment on a real move keeps both the move and the text", () => {
    const out = wrapGCode(["G0 Z5", "G0 X20 (rapid in) Y10"].join("\n"), ROTARY, {});
    expect(out).toContain("(rapid in)");
    expect(out).toMatch(/A[\d.]/);
  });
});

describe("G53 machine coordinates are never treated as work coordinates", () => {
  const PARK = ["G0 Z5", "G0 X50 Y40", "G1 Z-3 F300", "G0 Z5", "G53 G0 X0 Y0"].join("\n");

  test("the linter does not judge them against the stock", () => {
    expect(lintGCode(PARK, CTX)).toEqual([]);
  });

  test("the rotary wrap passes them through untouched", () => {
    // The bug: `G53 G0 X0 Y0` became `G0 X0 A0` — the machine-coordinate
    // qualifier dropped and a machine axis converted into a rotary angle.
    const out = wrapGCode(PARK, ROTARY, {});
    expect(out).toContain("G53 G0 X0 Y0");
  });

  test("tiling refuses to clip them rather than shifting them", () => {
    // Machine coordinates must not be tile-translated; reporting it is the safe
    // answer, and it is what the export surfaces to the user.
    expect(unsupportedMotions(PARK)).toContain("G53");
  });
});
