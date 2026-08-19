import { describe, expect, it } from "vitest";
import { generateGCode, generateInlayPrograms } from "../src/cam/gcode";
import type { CAMOperation } from "../src/cam/types";
import type { Vec2 } from "../src/core/vec2";
import { CADDocument } from "../src/model/document";
import { PolylineEntity } from "../src/model/entities";

const square = (s: number): Vec2[] => [
  { x: 10, y: 10 },
  { x: 10 + s, y: 10 },
  { x: 10 + s, y: 10 + s },
  { x: 10, y: 10 + s },
];

function inlayOp(entityIds: string[], over: Partial<CAMOperation> = {}): CAMOperation {
  return {
    id: "i1",
    name: "inlay",
    type: "inlay",
    entityIds,
    side: "outside",
    toolType: "v-bit",
    toolNumber: 1,
    diameter: 12,
    vAngle: 90,
    feedrate: 1000,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -3,
    stepdown: 1.5,
    stepover: 0.4,
    vStep: 1,
    pocketDepth: 3,
    glueGap: 0.5,
    sawAllowance: 1,
    inlayMargin: 10,
    ...over,
  };
}

const cutDepths = (lines: string): number[] =>
  [...lines.matchAll(/G1 Z(-?\d+(?:\.\d+)?)/g)].map((m) => parseFloat(m[1]));

describe("v-carve inlay G-code", () => {
  it("carves the female pocket, clamped to the pocket floor", () => {
    const doc = new CADDocument({ width: 100, height: 100 });
    const poly = doc.add(new PolylineEntity(square(20), true));
    const out = generateGCode([inlayOp([poly.id])], doc);

    expect(out).toContain('; --- Inlay "inlay"');
    const depths = cutDepths(out);
    expect(depths.length).toBeGreaterThan(0);
    for (const z of depths) expect(z).toBeGreaterThanOrEqual(-3 - 1e-6);
    expect(Math.min(...depths)).toBeCloseTo(-3, 6);
  });

  it("posts two programs from one op, the male deeper by the saw allowance", () => {
    const doc = new CADDocument({ width: 100, height: 100 });
    const poly = doc.add(new PolylineEntity(square(20), true));
    doc.operations.push(inlayOp([poly.id]));

    const { female, male } = generateInlayPrograms(doc.operations, doc);
    expect(female).toContain("; --- Inlay");
    expect(male).toContain("; --- Inlay");
    expect(male.length).toBeGreaterThan(0);

    expect(Math.min(...cutDepths(female))).toBeCloseTo(-3, 6);
    expect(Math.min(...cutDepths(male))).toBeCloseTo(-4, 6); // pocket 3 + saw 1
  });

  it("requires a V-bit", () => {
    const doc = new CADDocument({ width: 100, height: 100 });
    const poly = doc.add(new PolylineEntity(square(20), true));
    const out = generateGCode([inlayOp([poly.id], { toolType: "end-mill" })], doc);
    expect(out).toMatch(/inlay requires a V-bit/);
    expect(cutDepths(out)).toEqual([]);
  });

  it("a picked region carves the face, and the male clears the field around it", () => {
    const doc = new CADDocument({ width: 100, height: 100 });
    const outer = doc.add(new PolylineEntity(square(20), true)); // 10..30
    doc.add(
      new PolylineEntity(
        square(10).map((p) => ({ x: p.x + 5, y: p.y + 5 })),
        true,
      ),
    ); // 15..25 — a counter (island) inside the face
    const op = inlayOp([]); // no entityIds — the design is the picked region
    op.regions = [{ containingLoops: [[outer.id]] }];
    doc.operations.push(op);

    const { female, male } = generateInlayPrograms(doc.operations, doc);
    const xs = (g: string): number[] =>
      [...g.matchAll(/G1 X(-?\d+(?:\.\d+)?)/g)].map((m) => parseFloat(m[1]));

    expect(xs(female).length).toBeGreaterThan(0);
    expect(xs(male).length).toBeGreaterThan(0);

    // The female carves the face itself — nothing left of the outer square.
    expect(Math.min(...xs(female))).toBeGreaterThanOrEqual(10 - 1e-6);
    // The male clears the FIELD around the face, so its cuts reach the generated
    // boundary left of the design. Without forceBoundary the outer square would
    // be mistaken for a drawn boundary and this would fail.
    expect(Math.min(...xs(male))).toBeLessThan(10);
  });
});
