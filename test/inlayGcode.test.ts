import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { estimateOpSeconds, generateGCode, generateInlayPrograms } from "../src/cam/gcode";
import { textToContours } from "../src/cam/textOutlines";
import { estimateGCodeTime } from "../src/cam/timeEstimate";
import type { CAMOperation } from "../src/cam/types";
import { loadFromFile } from "../src/core/fontManager";
import type { Vec2 } from "../src/core/vec2";
import { CADDocument } from "../src/model/document";
import { PolylineEntity, RectEntity, TextEntity } from "../src/model/entities";

let fontId: string;
beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const bytes = readFileSync(join(here, "..", "public", "fonts", "roboto-regular.woff"));
  const fakeFile = {
    name: "roboto.woff",
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as File;
  ({ id: fontId } = await loadFromFile(fakeFile));
});

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

  it("a single letter with a counter clears the field, not the stroke", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const text = doc.add(new TextEntity("o", fontId, 40, { x: 20, y: 20 }, 0));
    const op = inlayOp([text.id]);
    doc.operations.push(op);

    const { male } = generateInlayPrograms(doc.operations, doc);
    const xs = (g: string): number[] =>
      [...g.matchAll(/G1 X(-?\d+(?:\.\d+)?)/g)].map((m) => parseFloat(m[1]));
    const glyphLeft = Math.min(
      ...textToContours(text)
        .flatMap((c) => c.points)
        .map((p) => p.x),
    );

    // The male clears the FIELD, so its cuts reach the generated boundary well
    // left of the glyph. If the glyph's outer ring were mistaken for a boundary,
    // the male would carve only the stroke and never reach this far left.
    expect(Math.min(...xs(male))).toBeLessThan(glyphLeft - 1);
  });

  it("a drawn boundary rectangle is honoured even with text in the design", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const rect = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 100, y: 100 }));
    const text = doc.add(new TextEntity("x", fontId, 20, { x: 30, y: 30 }, 0));
    const op = inlayOp([rect.id, text.id]);
    doc.operations.push(op);

    const { male } = generateInlayPrograms(doc.operations, doc);
    const xs = (g: string): number[] =>
      [...g.matchAll(/G1 X(-?\d+(?:\.\d+)?)/g)].map((m) => parseFloat(m[1]));

    // The male clears the field inside the drawn rectangle — nothing beyond it.
    // With the boundary forced (the regression), cuts would spill past the rect
    // to a generated margin.
    expect(Math.min(...xs(male))).toBeGreaterThanOrEqual(-1e-6);
    expect(Math.max(...xs(male))).toBeLessThanOrEqual(100 + 1e-6);
  });

  it("an inlay's run-time estimate counts both boards", () => {
    const doc = new CADDocument({ width: 100, height: 100 });
    const poly = doc.add(new PolylineEntity(square(20), true));
    const op = inlayOp([poly.id]);

    const femaleOnly = estimateGCodeTime(generateGCode([op], doc)).seconds;
    expect(femaleOnly).toBeGreaterThan(0);

    // The male adds its own carve, so the inlay estimate is larger than the
    // female board alone (which is what the op-list estimate used to show).
    expect(estimateOpSeconds(op, doc)).toBeGreaterThan(femaleOnly);
  });
});
