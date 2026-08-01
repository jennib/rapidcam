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
import { RectEntity, CircleEntity } from "../src/model/entities";

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
