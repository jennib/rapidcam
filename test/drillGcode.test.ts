import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { CircleEntity } from "../src/model/entities";
import { generateGCode } from "../src/cam/gcode";
import type { CAMOperation } from "../src/cam/types";

function drillOp(entityIds: string[]): CAMOperation {
  return {
    id: "d1", name: "Drill", type: "drill", entityIds, side: "outside",
    toolType: "drill", toolNumber: 1, diameter: 5, feedrate: 200, plungeRate: 120,
    spindleSpeed: 6000, safeZ: 5, depth: -5, stepdown: 3, stepover: 0.4,
  };
}

test("drill G-code: one plunge per hole, no redundant consecutive retracts", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  const a = doc.add(new CircleEntity({ x: 20, y: 20 }, 2.5));
  const b = doc.add(new CircleEntity({ x: 80, y: 20 }, 2.5));
  const c = doc.add(new CircleEntity({ x: 50, y: 70 }, 2.5));

  const lines = generateGCode([drillOp([a.id, b.id, c.id])], doc).split("\n");

  // One plunge per hole.
  expect(lines.filter((l) => /^G1 Z-5\b/.test(l)).length).toBe(3);

  // Retracts: one establishing move before the first hole + one per hole = 4.
  expect(lines.filter((l) => /^G0 Z5\b/.test(l)).length).toBe(4);

  // No two consecutive identical non-blank lines (the old code emitted two
  // `G0 Z5` in a row between holes).
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    expect(lines[i]).not.toBe(lines[i - 1]);
  }
});
