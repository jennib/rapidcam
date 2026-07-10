import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { generateGCode } from "../src/cam/gcode";
import type { CAMOperation } from "../src/cam/types";

// A 50×50 square pocket cut with a ⌀6 tool. The wall lap is inset by the tool
// radius (3), so its corners sit at (3,3)…(47,47). Dog-bone relief drives the
// tool diagonally *past* each wall corner toward the true corner — so cut moves
// dip below x=3 / y=3, which a plain pocket never does.

function squarePocket(doc: CADDocument, x: number, y: number, s: number): string[] {
  const p = [
    { x, y },
    { x: x + s, y },
    { x: x + s, y: y + s },
    { x, y: y + s },
  ];
  return p.map((a, i) => doc.add(new LineEntity(a, p[(i + 1) % 4])).id);
}

function pocketOp(ids: string[], cornerStyle?: "none" | "dogbone"): CAMOperation {
  return {
    id: "op",
    name: "pocket",
    type: "pocket",
    side: "outside",
    entityIds: ids,
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 6,
    feedrate: 1000,
    plungeRate: 300,
    spindleSpeed: 10000,
    safeZ: 5,
    depth: -2,
    stepdown: 2,
    stepover: 0.4,
    cornerStyle,
  };
}

const cutCoords = (code: string): { x: number; y: number }[] =>
  code
    .split("\n")
    .filter((l) => /^G[123] /.test(l) && /X/.test(l) && /Y/.test(l))
    .map((l) => ({
      x: parseFloat(l.match(/X(-?[\d.]+)/)![1]),
      y: parseFloat(l.match(/Y(-?[\d.]+)/)![1]),
    }));

test("a plain pocket keeps every cut move inside the inset wall (x,y ≥ 3)", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  const g = generateGCode([pocketOp(squarePocket(doc, 0, 0, 50), "none")], doc);
  const pts = cutCoords(g);
  expect(pts.length).toBeGreaterThan(0);
  const minXY = Math.min(...pts.map((p) => Math.min(p.x, p.y)));
  expect(minXY).toBeGreaterThan(3 - 1e-6);
});

test("dog-bone relief drives cut moves past the wall corners toward (0,0)", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  const g = generateGCode([pocketOp(squarePocket(doc, 0, 0, 50), "dogbone")], doc);
  const pts = cutCoords(g);
  // The (3,3) wall corner's overcut reaches ≈ (2.12, 2.12) — toolR·(√2−1) along
  // the diagonal — so at least one move dips below the inset wall.
  const overcuts = pts.filter((p) => p.x < 2.5 && p.y < 2.5);
  expect(overcuts.length).toBeGreaterThan(0);
  const near = overcuts.find((p) => Math.abs(p.x - 2.121) < 0.05 && Math.abs(p.y - 2.121) < 0.05);
  expect(near).toBeDefined();
});

test("all four corners are relieved", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  const g = generateGCode([pocketOp(squarePocket(doc, 0, 0, 50), "dogbone")], doc);
  const pts = cutCoords(g);
  // One overcut point per corner, ≈ toolR·(√2−1) ≈ 1.243 outside each wall corner.
  const corners = [
    { x: 2.121, y: 2.121 },
    { x: 47.879, y: 2.121 },
    { x: 47.879, y: 47.879 },
    { x: 2.121, y: 47.879 },
  ];
  for (const c of corners) {
    const hit = pts.some((p) => Math.abs(p.x - c.x) < 0.05 && Math.abs(p.y - c.y) < 0.05);
    expect(hit, `corner ${c.x},${c.y} relieved`).toBe(true);
  }
});

test("dog-bone requires no explicit finishing pass (the wall lap is emitted for it)", () => {
  // pocketOp above sets no finishPass; the dog-bone still produces the wall lap.
  const doc = new CADDocument({ width: 200, height: 200 });
  const g = generateGCode([pocketOp(squarePocket(doc, 0, 0, 50), "dogbone")], doc);
  expect(g).toMatch(/finishing pass \(full-depth wall\)/);
});
