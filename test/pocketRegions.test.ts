import { describe, it, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { generateGCode } from "../src/cam/gcode";
import type { CAMOperation } from "../src/cam/types";
import type { Vec2 } from "../src/core/vec2";

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

describe("pocket G-code from flood-fill region seeds", () => {
  // Two overlapping rectangles: A spans x 0..50, B spans x 30..80, both y 0..50.
  const doc = new CADDocument({ width: 200, height: 200 });
  const A = addSquare(doc, 0, 0, 50);
  const B = addSquareWH(doc, 30, 0, 50, 50);

  function genWithSeeds(seeds: Vec2[]): number[] {
    const op = pocketOp([...A, ...B].map((e) => e.id), []);
    op.regionSeeds = seeds;
    const code = generateGCode([op], doc);
    return code
      .split("\n")
      .filter((l) => l.startsWith("G1 X"))
      .map((l) => parseFloat(l.match(/X(-?[\d.]+)/)![1]));
  }

  it("pocketing the intersection stays inside the overlap (x 30..50)", () => {
    const xs = genWithSeeds([{ x: 40, y: 25 }]);
    expect(xs.length).toBeGreaterThan(0);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(30 - 0.01);
    expect(Math.max(...xs)).toBeLessThanOrEqual(50 + 0.01);
  });

  it("pocketing the A-only crescent never enters the overlap", () => {
    const xs = genWithSeeds([{ x: 10, y: 25 }]);
    expect(xs.length).toBeGreaterThan(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(30 + 0.01);
  });

  it("a seed outside any enclosed area is skipped with a note", () => {
    const op = pocketOp([...A, ...B].map((e) => e.id), []);
    op.regionSeeds = [{ x: 150, y: 150 }];
    const code = generateGCode([op], doc);
    expect(code).toContain("not inside any enclosed area");
    expect(code.split("\n").some((l) => l.startsWith("G1 X"))).toBe(false);
  });
});

function addSquareWH(doc: CADDocument, x: number, y: number, w: number, h: number): LineEntity[] {
  const p = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  return p.map((a, i) => doc.add(new LineEntity(a, p[(i + 1) % 4]))) as LineEntity[];
}
