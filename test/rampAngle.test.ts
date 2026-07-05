import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { generateGCode } from "../src/cam/gcode";
import type { CAMOperation } from "../src/cam/types";

// A default pocket enters the cut with a helical descent instead of plunging
// straight. A shallower ramp angle spreads that descent over more laps (a longer
// entry); a steeper angle over fewer. This exercises `rampAngle` end to end.

function squarePocket(doc: CADDocument, s: number): string[] {
  const p = [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s }];
  return p.map((a, i) => doc.add(new LineEntity(a, p[(i + 1) % 4])).id);
}

function pocketOp(ids: string[], rampAngle?: number): CAMOperation {
  return {
    id: "op", name: "pocket", type: "pocket", side: "outside", entityIds: ids,
    toolType: "end-mill", toolNumber: 1, diameter: 6,
    feedrate: 1000, plungeRate: 300, spindleSpeed: 10000,
    safeZ: 5, depth: -4, stepdown: 4, stepover: 0.4, rampAngle,
  };
}

// Descending feed moves that also travel in XY (the helical entry segments).
const rampMoves = (code: string): number =>
  code.split("\n").filter((l) => /^G1 X\S+ Y\S+ Z\S+/.test(l)).length;
const build = (angle?: number): string => {
  const doc = new CADDocument({ width: 100, height: 100 });
  return generateGCode([pocketOp(squarePocket(doc, 40), angle)], doc);
};

test("a shallower ramp angle produces a longer entry than a steeper one", () => {
  expect(rampMoves(build(1))).toBeGreaterThan(rampMoves(build(30)));
});

test("setting a ramp angle changes the toolpath (the override is wired through)", () => {
  expect(build(1)).not.toBe(build(undefined)); // override differs from the default
  expect(build(1)).not.toBe(build(30));         // and the angle actually matters
});

test("out-of-range ramp angles are clamped (0.5°–45°), not taken literally", () => {
  // 90° would be a vertical plunge; clamped to 45° the tool still ramps in.
  expect(build(90)).toBe(build(45));
  expect(rampMoves(build(90))).toBeGreaterThan(0);
});
