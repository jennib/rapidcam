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
  expect(lintGCode(g, buildLintContext(doc))).toEqual([]);
});

test("clean pocket job produces no findings", () => {
  const { doc, op } = docWith({ type: "pocket" });
  const g = generateGCode([op], doc);
  expect(lintGCode(g, buildLintContext(doc))).toEqual([]);
});

test("end-to-end: a job deeper than the stock warns over-deep", () => {
  const { doc, op } = docWith({ depth: -15 }); // stock is 10mm thick
  const g = generateGCode([op], doc);
  const found = lintGCode(g, buildLintContext(doc)).map((f) => f.code);
  expect(found).toContain("over-deep");
});

test("buildLintContext maps a centered origin into emitted bounds", () => {
  const doc = new CADDocument({ width: 100, height: 80 });
  doc.origin = { x: "center", y: "center", z: "top" };
  const ctx = buildLintContext(doc);
  expect(ctx.bounds).toEqual({ xMin: -50, xMax: 50, yMin: -40, yMax: 40 });
});
