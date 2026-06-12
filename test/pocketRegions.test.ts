import { describe, it, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { generateGCode } from "../src/cam/gcode";
import type { CAMOperation } from "../src/cam/types";

// Multi-region pocket: two disjoint line-drawn boundaries plus a line-drawn
// island, all in one operation (what region picking in the toolpath dialog
// produces).

function addSquare(doc: CADDocument, x: number, y: number, s: number): LineEntity[] {
  const p = [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];
  return p.map((a, i) => doc.add(new LineEntity(a, p[(i + 1) % 4]))) as LineEntity[];
}

function pocketOp(entityIds: string[], islandIds: string[]): CAMOperation {
  return {
    id: "op1", name: "pocket", type: "pocket", side: "outside",
    entityIds, islandIds: islandIds.length ? islandIds : undefined,
    toolType: "end-mill", toolNumber: 1, diameter: 6,
    feedrate: 1000, plungeRate: 300, spindleSpeed: 10000,
    safeZ: 5, depth: -2, stepdown: 2, stepover: 0.4,
  };
}

describe("pocket G-code for multiple line-chained regions", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  const pocket1 = addSquare(doc, 0, 0, 50);
  const island1 = addSquare(doc, 10, 10, 10);
  const pocket2 = addSquare(doc, 100, 0, 30);

  const code = generateGCode(
    [pocketOp([...pocket1, ...pocket2].map((e) => e.id), island1.map((e) => e.id))],
    doc,
  );
  const cutXs = code
    .split("\n")
    .filter((l) => l.startsWith("G1 X"))
    .map((l) => parseFloat(l.match(/X(-?[\d.]+)/)![1]));

  it("cuts both disjoint boundaries", () => {
    expect(cutXs.some((x) => x < 60)).toBe(true);   // first pocket
    expect(cutXs.some((x) => x >= 100)).toBe(true); // second pocket
  });

  it("recognises the line-chained island", () => {
    expect(code).toContain("islands: 1 polygon(s)");
  });

  it("emits no skipped-lines note when all chains close", () => {
    expect(code).not.toContain("do not form a closed polygon");
  });
});
