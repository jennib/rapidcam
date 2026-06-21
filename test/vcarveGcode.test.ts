import { describe, it, expect } from "vitest";
import { generateGCode } from "../src/cam/gcode";
import { groupContoursIntoRegions } from "../src/cam/vcarve";
import { CADDocument } from "../src/model/document";
import { PolylineEntity } from "../src/model/entities";
import type { CAMOperation } from "../src/cam/types";
import type { Vec2 } from "../src/core/vec2";

const square = (s: number): Vec2[] => [
  { x: 10, y: 10 }, { x: 10 + s, y: 10 }, { x: 10 + s, y: 10 + s }, { x: 10, y: 10 + s },
];

function vcarveOp(entityIds: string[], over: Partial<CAMOperation> = {}): CAMOperation {
  return {
    id: "v1", name: "carve", type: "vcarve", entityIds, side: "outside",
    toolType: "v-bit", toolNumber: 1, diameter: 12, vAngle: 90,
    feedrate: 1000, plungeRate: 300, spindleSpeed: 18000,
    safeZ: 5, depth: -3, stepdown: 1.5, stepover: 0.4, vStep: 1, ...over,
  };
}

// Pull every commanded G1 Z depth out of the program.
const cutDepths = (lines: string): number[] =>
  [...lines.matchAll(/G1 Z(-?\d+(?:\.\d+)?)/g)].map((m) => parseFloat(m[1]));

describe("v-carve G-code", () => {
  it("carves a closed shape with varying, clamped depth", () => {
    const doc = new CADDocument({ width: 100, height: 100 });
    const poly = doc.add(new PolylineEntity(square(20), true));
    const out = generateGCode([vcarveOp([poly.id])], doc);

    expect(out).toContain('; --- V-Carve "carve"');

    const depths = cutDepths(out);
    expect(depths.length).toBeGreaterThan(0);
    // The defining property of a v-carve: the cut depth varies pass to pass.
    expect(new Set(depths).size).toBeGreaterThan(2);
    // Nothing is cut deeper than |depth| (the floor clamp).
    for (const z of depths) expect(z).toBeGreaterThanOrEqual(-3 - 1e-6);
    // And it actually reaches the floor on this 20 mm square (90° bit).
    expect(Math.min(...depths)).toBeCloseTo(-3, 6);
  });

  it("requires a V-bit tool", () => {
    const doc = new CADDocument({ width: 100, height: 100 });
    const poly = doc.add(new PolylineEntity(square(20), true));
    const out = generateGCode([vcarveOp([poly.id], { toolType: "end-mill" })], doc);
    expect(out).toMatch(/v-carve requires a V-bit/);
    expect(cutDepths(out)).toEqual([]);
  });
});

describe("groupContoursIntoRegions", () => {
  it("nests a counter as a hole", () => {
    const outer = square(20);
    const hole: Vec2[] = [ // inner ring → becomes a hole
      { x: 16, y: 16 }, { x: 24, y: 16 }, { x: 24, y: 24 }, { x: 16, y: 24 },
    ];
    const regions = groupContoursIntoRegions([outer, hole]);
    expect(regions.length).toBe(1);
    expect(regions[0].holes.length).toBe(1);
  });

  it("treats two disjoint shapes as two solid regions", () => {
    const a = square(10);
    const b: Vec2[] = [ { x: 40, y: 40 }, { x: 50, y: 40 }, { x: 50, y: 50 }, { x: 40, y: 50 } ];
    const regions = groupContoursIntoRegions([a, b]);
    expect(regions.length).toBe(2);
    expect(regions.every((r) => r.holes.length === 0)).toBe(true);
  });
});
