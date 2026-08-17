/**
 * Apollo pre-flight linter tests. Run with: npx vitest run test/lint.test.ts
 *
 * Two layers:
 *  - unit checks against hand-built LintContexts + minimal G-code snippets, one
 *    per predicate (each snippet trips exactly its own check);
 *  - a false-positive guard + end-to-end cases asserting real generateGCode
 *    output lints clean on a sane job and flags a deliberately-broken one.
 */

import { test, expect } from "vitest";
import { lintGCode, buildLintContext, type LintContext } from "../src/cam/lint";
import { generateGCode } from "../src/cam/gcode";
import type { CAMOperation } from "../src/cam/types";
import { CADDocument } from "../src/model/document";
import { RectEntity, CircleEntity, RasterImageEntity } from "../src/model/entities";

// A 100 × 80mm stock, top-origin: X/Y envelope [0,100]×[0,80], Z top 0, bottom −10.
const CTX: LintContext = {
  bounds: { xMin: 0, xMax: 100, yMin: 0, yMax: 80 },
  zTop: 0,
  zBottom: -10,
  machineKind: "mill",
};

const codes = (g: string, ctx = CTX) => lintGCode(g, ctx).map((f) => f.code);

// --- rapid through stock -----------------------------------------------------
test("rapid through stock: G0 XY below the surface is an error", () => {
  const g = ["G0 Z5", "G1 Z-3 F300", "G0 X10 Y10", "G0 Z5"].join("\n");
  //                       ^ still at Z-3 when the next line rapids in XY
  const f = lintGCode(g, CTX).find((x) => x.code === "rapid-through-stock");
  expect(f?.severity).toBe("error");
});

test("rapid through stock: a proper retract-first sequence is clean", () => {
  const g = ["G0 Z5", "G1 Z-3 F300", "G0 Z5", "G0 X10 Y10"].join("\n");
  expect(codes(g)).not.toContain("rapid-through-stock");
});

// --- out of bounds -----------------------------------------------------------
// A cut (below-surface) move off the stock is the hazard; a safe-Z rapid off the
// work (park/end position) is legitimate and must NOT be flagged.
test("out of bounds: a cut past the stock edge is an error", () => {
  const g = ["G0 Z5", "G0 X120 Y10", "G1 Z-3 F300"].join("\n"); // plunge at X120 > xMax 100
  const f = lintGCode(g, CTX).find((x) => x.code === "out-of-bounds");
  expect(f?.severity).toBe("error");
});

test("out of bounds: negative excursion caught too", () => {
  const g = ["G0 Z5", "G0 X-5 Y10", "G1 Z-3 F300"].join("\n");
  expect(codes(g)).toContain("out-of-bounds");
});

test("out of bounds: a cut on the edge is within tolerance", () => {
  const g = ["G0 Z5", "G0 X100 Y80", "G1 Z-3 F300"].join("\n");
  expect(codes(g)).not.toContain("out-of-bounds");
});

test("out of bounds: a safe-Z rapid off the work (park) is not flagged", () => {
  const g = ["G0 Z5", "G0 X-20 Y-20 ; park for tool change"].join("\n");
  expect(codes(g)).not.toContain("out-of-bounds");
});

// --- over deep ---------------------------------------------------------------
test("over-deep: cutting well below the stock bottom warns", () => {
  const g = ["G0 Z5", "G0 X10 Y10", "G1 Z-12 F300"].join("\n"); // bottom is −10, 2mm past
  const f = lintGCode(g, CTX).find((x) => x.code === "over-deep");
  expect(f?.severity).toBe("warning");
});

test("over-deep: a normal through-cut overshoot (<1mm) stays quiet", () => {
  const g = ["G0 Z5", "G0 X10 Y10", "G1 Z-10.5 F300"].join("\n"); // 0.5mm onto the spoilboard
  expect(codes(g)).not.toContain("over-deep");
});

// --- fast plunge -------------------------------------------------------------
test("fast plunge: a straight plunge at/above cutting feed warns", () => {
  const g = [
    "G0 Z5",
    "G0 X10 Y10",
    "G1 X20 Y10 F1000", // establish the cutting feed
    "G0 Z5",
    "G0 X30 Y30",
    "G1 Z-3 F1200", // plunge faster than cutting → warn
  ].join("\n");
  const f = lintGCode(g, CTX).find((x) => x.code === "fast-plunge");
  expect(f?.severity).toBe("warning");
});

test("fast plunge: a slow plunge below cutting feed is clean", () => {
  const g = [
    "G0 Z5",
    "G0 X10 Y10",
    "G1 X20 Y10 F1000",
    "G0 Z5",
    "G0 X30 Y30",
    "G1 Z-3 F300", // proper plunge rate
  ].join("\n");
  expect(codes(g)).not.toContain("fast-plunge");
});

test("fast plunge: a ramp entry (lateral + Z at feed) is not flagged", () => {
  const g = [
    "G0 Z5",
    "G0 X10 Y10",
    "G1 X20 Y10 F1000",
    "G0 Z5",
    "G0 X30 Y30",
    "G1 X40 Y30 Z-3 F1000", // ramps down while moving laterally — intentional
  ].join("\n");
  expect(codes(g)).not.toContain("fast-plunge");
});

// --- missing tool change -----------------------------------------------------
test("missing tool change: manual marker with commented pause warns", () => {
  const g = [
    "; *** Manual tool change to T2 (⌀3mm) ***",
    "; M0 ; uncomment to pause for manual tool change",
    "M3 S18000",
  ].join("\n");
  const f = lintGCode(g, CTX).find((x) => x.code === "missing-tool-change");
  expect(f?.severity).toBe("warning");
});

test("missing tool change: an active M0 clears the warning", () => {
  const g = [
    "; *** Manual tool change to T2 (⌀3mm) ***",
    "M0 ; pause for manual tool change",
    "M3 S18000",
  ].join("\n");
  expect(codes(g)).not.toContain("missing-tool-change");
});

// --- laser scoping -----------------------------------------------------------
test("laser: Z-based checks are skipped, bounds still apply", () => {
  const laserCtx: LintContext = { ...CTX, machineKind: "laser" };
  const g = ["G0 X120 Y10", "G1 Z-99"].join("\n"); // OOB + a nonsense Z
  const found = codes(g, laserCtx);
  expect(found).toContain("out-of-bounds");
  expect(found).not.toContain("over-deep");
});

// --- false-positive guard: real generated output ----------------------------
function docWith(op: Partial<CAMOperation>): { doc: CADDocument; op: CAMOperation } {
  const doc = new CADDocument({ width: 100, height: 80 });
  doc.stockThickness = 10;
  const rect = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 80, y: 60 }));
  doc.add(new CircleEntity({ x: 50, y: 40 }, 15));
  const base: CAMOperation = {
    id: "op1",
    name: "profile",
    type: "profile",
    entityIds: [rect.id],
    side: "outside",
    toolNumber: 1,
    toolType: "end-mill",
    diameter: 6,
    feedrate: 1000,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -3,
    stepdown: 1.5,
    stepover: 0.4,
    ...op,
  } as CAMOperation;
  return { doc, op: base };
}

test("clean profile job produces no findings", () => {
  const { doc, op } = docWith({});
  const g = generateGCode([op], doc);
  expect(g).toMatch(/^G1 /m); // guard: there IS a toolpath to find fault with
  expect(lintGCode(g, buildLintContext(doc))).toEqual([]);
});

test("clean pocket job produces no findings", () => {
  const { doc, op } = docWith({ type: "pocket" });
  const g = generateGCode([op], doc);
  expect(g).toMatch(/^G1 /m); // guard: there IS a toolpath to find fault with
  expect(lintGCode(g, buildLintContext(doc))).toEqual([]);
});

test("end-to-end: a job deeper than the stock warns over-deep", () => {
  const { doc, op } = docWith({ depth: -15 }); // stock is 10mm thick
  const g = generateGCode([op], doc);
  const found = lintGCode(g, buildLintContext(doc)).map((f) => f.code);
  expect(found).toContain("over-deep");
});

test("an operation bound to no geometry warns empty-toolpath", () => {
  const { doc, op } = docWith({ entityIds: [] });
  doc.operations.push(op); // doc-level check reads doc.operations
  const g = generateGCode([op], doc);
  const found = lintGCode(g, buildLintContext(doc));
  const empty = found.find((f) => f.code === "empty-toolpath");
  expect(empty).toBeDefined();
  expect(empty?.severity).toBe("warning");
  expect(empty?.message).toContain("cut nothing");
});

test("a bound operation does not warn empty-toolpath", () => {
  const { doc, op } = docWith({}); // bound to the rect
  doc.operations.push(op);
  const g = generateGCode([op], doc);
  expect(lintGCode(g, buildLintContext(doc)).map((f) => f.code)).not.toContain("empty-toolpath");
});

test("buildLintContext maps a centered origin into emitted bounds", () => {
  const doc = new CADDocument({ width: 100, height: 80 });
  doc.origin = { x: "center", y: "center", z: "top" };
  const ctx = buildLintContext(doc);
  expect(ctx.bounds).toEqual({ xMin: -50, xMax: 50, yMin: -40, yMax: 40 });
});

// --- positioned StockRect (workholding phase 2) ------------------------------
// New Project centres the blank on a margin-padded sheet (stockRect off (0,0))
// so there's room to draw clamps that overhang it. resolveOrigin's ox/oy already
// fold stockRect.x/y in, but the bounds calc used to build the envelope from
// canvas (0,0) regardless — silently shifting the whole valid box by
// (-stockRect.x, -stockRect.y). On the New Project default (200×150 stock
// centred on a 300×250 sheet, so stockRect = {x:50,y:50,...}) that produced a
// false "outside the stock" error on the first export of a first project, while
// letting a real off-stock move through on the opposite edge.
test("buildLintContext anchors bounds to a POSITIONED stockRect, not canvas (0,0)", () => {
  const doc = new CADDocument({ width: 300, height: 250 });
  doc.origin = { x: "left", y: "front", z: "top" };
  doc.stockRect = { x: 50, y: 50, width: 200, height: 150 };
  const ctx = buildLintContext(doc);
  expect(ctx.bounds).toEqual({ xMin: 0, xMax: 200, yMin: 0, yMax: 150 });
});

test("out of bounds: a positioned stockRect doesn't false-flag a move inside the true stock", () => {
  const doc = new CADDocument({ width: 300, height: 250 });
  doc.origin = { x: "left", y: "front", z: "top" };
  doc.stockRect = { x: 50, y: 50, width: 200, height: 150 };
  const ctx = buildLintContext(doc);
  const g = ["G0 Z5", "G0 X22 Y103", "G1 Z-3 F300"].join("\n"); // comfortably inside 0-200 × 0-150
  expect(codes(g, ctx)).not.toContain("out-of-bounds");
});

test("out of bounds: a positioned stockRect still catches a move genuinely off the stock", () => {
  const doc = new CADDocument({ width: 300, height: 250 });
  doc.origin = { x: "left", y: "front", z: "top" };
  doc.stockRect = { x: 50, y: 50, width: 200, height: 150 };
  const ctx = buildLintContext(doc);
  const g = ["G0 Z5", "G0 X22 Y-3", "G1 Z-3 F300"].join("\n"); // 3mm past the true Y0 edge
  expect(codes(g, ctx)).toContain("out-of-bounds");
});

// --- G93 inverse-time feed (rotary combined moves) ---------------------------
test("fast plunge: G93 inverse-time moves aren't compared as if F were mm/min", () => {
  // Under G93 (cam/klein.ts, a rotary job with inverseTimeFeed) F is
  // 1/minutes-for-the-whole-move, not mm/min — a short pure-Z plunge naturally
  // gets a NUMERICALLY LARGER F than a long lateral move at the same true
  // surface feed, which the check (before it knew about G93) read as "plunging
  // at or above the cutting feed" on essentially every rotary job.
  const g = [
    "G93",
    "G0 Z5",
    "G0 X10 Y10",
    "G1 X73 A13.369 F15.873", // 63mm lateral move at surface feed 1000mm/min
    "G0 Z5",
    "G0 X30 Y30",
    "G1 Z-3 F37.5", // 8mm plunge at surface feed 300mm/min — but a LARGER inverse-time F
  ].join("\n");
  expect(codes(g)).not.toContain("fast-plunge");
});

test("fast plunge: a G94 plunge after a G93 block is compared normally again", () => {
  const g = [
    "G93",
    "G1 X73 A13.369 F15.873",
    "G94",
    "G0 Z5",
    "G0 X30 Y30",
    "G1 X40 Y30 F1000", // establishes an ordinary mm/min cutting feed
    "G0 Z5",
    "G0 X50 Y50",
    "G1 Z-3 F1200", // genuinely faster than the cutting feed — should still warn
  ].join("\n");
  expect(codes(g)).toContain("fast-plunge");
});

// --- word tokenisation -------------------------------------------------------
// The generator always writes spaces between words, so these cases only ever
// arise from hand-typed text — which the custom program start/end blocks
// (Machine Settings) inject verbatim into every program. A parser that reads
// them as one opaque token silently drops the coordinates, and the move then
// slips past every geometric check below.

test("run-together words: an off-stock cut is caught without spaces", () => {
  const g = ["G0Z5", "G0X120Y10", "G1Z-3F300"].join("\n"); // X120 > xMax 100
  expect(codes(g)).toContain("out-of-bounds");
});

test("run-together words: a partially spaced line is caught too", () => {
  const g = ["G0 Z5", "G0 X120Y10", "G1 Z-3 F300"].join("\n");
  expect(codes(g)).toContain("out-of-bounds");
});

test("run-together words: an over-deep cut is caught without spaces", () => {
  const g = ["G0 Z5", "G0 X10 Y10", "G1Z-15F300"].join("\n"); // zBottom −10
  expect(codes(g)).toContain("over-deep");
});

test("run-together words: a legitimate tight-packed program still lints clean", () => {
  // Positive control — the fix must not make every compact program noisy.
  const g = ["G0Z5", "G0X10Y10", "G1Z-3F300", "G1X50Y40F600", "G0Z5"].join("\n");
  expect(codes(g)).toEqual([]);
});

test("parenthetical comments are not read as motion", () => {
  // `(...)` is the other standard comment syntax. Scanning words without
  // stripping it would read this as a cut at X120, off the stock.
  const g = ["G0 Z5", "(rapid to X120 Y10 next time)", "G0 X10 Y10", "G1 Z-3 F300"].join("\n");
  expect(codes(g)).toEqual([]);
});

test("a space between a letter and its number is still one word", () => {
  const g = ["G0 Z5", "G0 X 120 Y 10", "G1 Z-3 F300"].join("\n");
  expect(codes(g)).toContain("out-of-bounds");
});

// --- G53 machine coordinates -------------------------------------------------
// G53 makes ONE line's coordinates raw machine position. Nothing in the program
// records where the work origin sits on the table, so those numbers cannot be
// compared against the stock envelope — doing so reported confident errors on
// the machine-coordinate retract and park blocks that the Machine Settings
// catalogue recommends, which is how a safety tool teaches people to ignore it.

test("G53: a machine-coordinate retract is not an out-of-bounds cut", () => {
  const g = ["G53 G0 Z-5", "G0 Z5", "G0 X10 Y10", "G1 Z-3 F300"].join("\n");
  expect(codes(g)).toEqual([]);
});

test("G53: a machine-coordinate park is neither out-of-bounds nor a rapid through stock", () => {
  const g = ["G0 Z5", "G0 X10 Y10", "G1 Z-3 F300", "G0 Z5", "G53 G0 Z-5", "G53 G0 X0 Y0"].join(
    "\n",
  );
  expect(codes(g)).toEqual([]);
});

test("G53 is non-modal: the very next line is judged in work coordinates again", () => {
  // Positive control — the exemption must not leak past its own line, or a real
  // off-stock cut after a G53 park would go unreported.
  const g = ["G53 G0 Z-5", "G0 X120 Y10", "G1 Z-3 F300"].join("\n"); // X120 > xMax 100
  expect(codes(g)).toContain("out-of-bounds");
});

test("G53 does not suppress an over-deep cut on a following line", () => {
  const g = ["G53 G0 Z-5", "G0 X10 Y10", "G1 Z-15 F300"].join("\n"); // zBottom −10
  expect(codes(g)).toContain("over-deep");
});

// A stock that does NOT straddle the work origin — the shape that exposed the
// position-leak below. The default CTX starts at X0 Y0, where an untracked
// position is coincidentally inside the envelope and hides the bug.
const OFFSET_CTX: LintContext = {
  bounds: { xMin: 20, xMax: 120, yMin: 20, yMax: 100 },
  zTop: 0,
  zBottom: -10,
  machineKind: "mill",
};

test("G53: machine coordinates do not leak into the next move's position", () => {
  // `G0 Z5` is innocent, but inherited a "before" Z of −5 from the G53 line and
  // so read as engaged in material at X0 Y0 — outside this stock.
  const g = ["G53 G0 Z-5", "G0 Z5", "G0 X30 Y30", "G1 Z-3 F300"].join("\n");
  expect(codes(g, OFFSET_CTX)).toEqual([]);
});

test("G53: a real off-stock cut after a machine-frame move is still caught", () => {
  // Positive control for the leak fix — suppressing the leak must not suppress
  // the check itself.
  const g = ["G53 G0 Z-5", "G0 Z5", "G0 X200 Y30", "G1 Z-3 F300"].join("\n");
  expect(codes(g, OFFSET_CTX)).toContain("out-of-bounds");
});

// --- relief rough/finish mismatch -------------------------------------------

/**
 * The guard for the drift the relief path warns about in its own doc comment:
 * roughing leaves its allowance relative to ITS depth, so if the finish op is
 * set deeper the finisher meets a wall of material rather than the allowance.
 */
function reliefPair(over: Partial<CAMOperation> = {}): CADDocument {
  const doc = new CADDocument({ width: 100, height: 80 });
  const img = doc.add(new RasterImageEntity("img-x", { x: 10, y: 10 }, 40, 40, 0));
  const base: CAMOperation = {
    id: "r",
    name: "Rough",
    type: "relief-rough",
    entityIds: [img.id],
    side: "outside",
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 6,
    feedrate: 1500,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -8,
    stepdown: 2,
    stepover: 0.4,
    finishAllowance: 0.5,
  };
  doc.operations.push(base, {
    ...base,
    id: "f",
    name: "Finish",
    type: "engrave",
    toolType: "ball-nose",
    diameter: 3,
    ...over,
  });
  return doc;
}

test("relief mismatch: a finish pass deeper than its roughing pass is flagged", () => {
  const doc = reliefPair({ depth: -12 });
  const f = lintGCode("G0 Z5", buildLintContext(doc)).find(
    (x) => x.code === "relief-pass-mismatch",
  );
  expect(f?.severity).toBe("warning");
  expect(f?.message).toContain("8mm");
  expect(f?.message).toContain("12mm");
  expect(f?.entityIds?.length).toBe(1);
});

test("relief mismatch: disagreeing about Invert carves the image and its negative", () => {
  const doc = reliefPair({ rasterInvert: true });
  const f = lintGCode("G0 Z5", buildLintContext(doc)).find(
    (x) => x.code === "relief-pass-mismatch",
  );
  expect(f?.message).toContain("Invert");
});

// --- relief stepover wider than the bit --------------------------------------

test("relief stepover: rows wider than the cutter leave uncut stripes", () => {
  // ⌀3 ball, rows 4mm apart: the passes never meet, so what stands between them
  // is not a cusp but full-height stock — a program that looks entirely normal.
  const doc = reliefPair({ rasterLineInterval: 4 });
  const f = lintGCode("G0 Z5", buildLintContext(doc)).find(
    (x) => x.code === "relief-stepover-gap",
  );
  expect(f?.severity).toBe("warning");
  expect(f?.message).toContain("never touch");
  expect(f?.entityIds?.length).toBe(1);
});

test("relief stepover: a stepover inside the bit lints clean (positive control)", () => {
  // 0.3mm on the same ⌀3 bit. Without this the test above would pass on a rule
  // that fires for every relief op.
  const doc = reliefPair({ rasterLineInterval: 0.3 });
  expect(lintGCode("G0 Z5", buildLintContext(doc)).map((x) => x.code)).not.toContain(
    "relief-stepover-gap",
  );
});

test("relief stepover: a halftone is not measured against its bit's width", () => {
  // A halftone DERIVES its row pitch from the groove width and ignores this
  // field; grooves overlapping their neighbours is the printing mechanism.
  const doc = reliefPair({
    rasterLineInterval: 4,
    toolType: "v-bit",
    vAngle: 60,
    halftone: true,
  });
  expect(lintGCode("G0 Z5", buildLintContext(doc)).map((x) => x.code)).not.toContain(
    "relief-stepover-gap",
  );
});

test("relief mismatch: matched passes lint clean (positive control)", () => {
  // Same depth, same invert — the pairing and the check both ran, and found
  // nothing. Without this the two tests above would pass on a rule that fires
  // for every relief pair.
  const doc = reliefPair();
  expect(lintGCode("G0 Z5", buildLintContext(doc)).map((x) => x.code)).not.toContain(
    "relief-pass-mismatch",
  );
});

/**
 * Two ROUGHING passes on one image — the arrangement `restToolDiameter` invites.
 * The rest pass works out what the earlier tool left by opening the same field
 * with each tool, so a depth mismatch hands it two different surfaces to
 * subtract and it answers confidently and wrongly.
 */
function reliefRoughRest(over: Partial<CAMOperation> = {}): CADDocument {
  const doc = reliefPair();
  doc.operations.pop(); // drop the engrave; this is rough-against-rough
  const rough = doc.operations[0];
  doc.operations.push({
    ...rough,
    id: "rest",
    name: "Rest",
    diameter: 3,
    restToolDiameter: 6,
    ...over,
  });
  return doc;
}

test("relief mismatch: a REST pass at a different depth from its roughing pass is flagged", () => {
  const f = lintGCode("G0 Z5", buildLintContext(reliefRoughRest({ depth: -12 }))).find(
    (x) => x.code === "relief-pass-mismatch",
  );
  expect(f?.severity).toBe("warning");
  expect(f?.message).toContain("8mm");
  expect(f?.message).toContain("12mm");
  expect(f?.entityIds?.length).toBe(1);
});

test("relief mismatch: two roughing passes disagreeing about Invert are flagged", () => {
  const f = lintGCode("G0 Z5", buildLintContext(reliefRoughRest({ rasterInvert: true }))).find(
    (x) => x.code === "relief-pass-mismatch",
  );
  expect(f?.message).toContain("Invert");
});

test("relief mismatch: a correctly matched rest pass lints clean (positive control)", () => {
  // Without this, the two above pass just as well for a rule that fires on any
  // two relief-rough ops sharing an image — which is the normal arrangement.
  expect(
    lintGCode("G0 Z5", buildLintContext(reliefRoughRest())).map((x) => x.code),
  ).not.toContain("relief-pass-mismatch");
});

test("relief mismatch: ops on DIFFERENT images are not paired", () => {
  const doc = reliefPair({ depth: -12 });
  doc.operations[1].entityIds = ["some-other-image"];
  expect(lintGCode("G0 Z5", buildLintContext(doc)).map((x) => x.code)).not.toContain(
    "relief-pass-mismatch",
  );
});
