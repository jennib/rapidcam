/**
 * Clamp generator — workholding placed against an edge of the BLANK.
 *
 * The behaviour worth guarding is placement: a clamp is defined entirely by
 * which stock edge it grips, so every assertion here is about where it lands
 * relative to `doc.stockRect`, not about its size in isolation. The stock is
 * deliberately placed OFF-CENTRE on its sheet in these fixtures — with a centred
 * blank, "measured from the sheet" and "measured from the blank" give identical
 * answers and the tests would pass on either, which is exactly how the flip bug
 * survived a full green suite.
 */
import { test, expect, describe } from "vitest";
import { CADDocument } from "../src/model/document";
import type { RectEntity } from "../src/model/entities";
import { fixturePolygons } from "../src/cam/fixtures";
import {
  GENERATORS,
  regenerateFeature,
  regenerateStockPlacedFeatures,
  runGenerator,
  stockDatum,
} from "../src/generators/index";
import { Sketch } from "../src/generators/sketch";
import { clamp } from "../src/generators/clamp";

/** A 400×300 sheet with a 200×100 blank at (50, 40) — deliberately off-centre. */
function docWithBlank(): CADDocument {
  const doc = new CADDocument({ width: 400, height: 300 });
  doc.stockRect = { x: 50, y: 40, width: 200, height: 100 };
  doc.stockThickness = 12;
  return doc;
}

/** Build the clamp in isolation against `doc`'s blank. */
function build(doc: CADDocument, params: Record<string, number> = {}): RectEntity {
  const s = new Sketch({ params, stock: stockDatum(doc) });
  const handles = clamp.build(s);
  return handles[0].entity as RectEntity;
}

describe("placement against the blank", () => {
  test("a left-edge clamp straddles the blank's left face", () => {
    const doc = docWithBlank();
    const r = build(doc, { edge: 0, width: 60, reach: 40, overhang: 12 });
    const b = r.bounds();
    // 12mm onto the material (x=50..62), the other 28mm outboard on the sheet.
    expect(b.min.x).toBeCloseTo(50 - 28);
    expect(b.max.x).toBeCloseTo(50 + 12);
    // Centred on the edge (y 40..140 → centre 90), 60 wide.
    expect(b.min.y).toBeCloseTo(60);
    expect(b.max.y).toBeCloseTo(120);
  });

  test("a right-edge clamp reaches inward from the far face, not the near one", () => {
    const doc = docWithBlank();
    const b = build(doc, { edge: 1, width: 60, reach: 40, overhang: 12 }).bounds();
    // Right face is x=250; 12mm onto the material means 238..250, rest outboard.
    expect(b.max.x).toBeCloseTo(250 + 28);
    expect(b.min.x).toBeCloseTo(250 - 12);
  });

  test("front and back clamps are the transpose of the side ones", () => {
    const doc = docWithBlank();
    const front = build(doc, { edge: 2, width: 60, reach: 40, overhang: 12 }).bounds();
    // Front face is y=40; the clamp runs along X centred on x=150.
    expect(front.min.y).toBeCloseTo(40 - 28);
    expect(front.max.y).toBeCloseTo(40 + 12);
    expect(front.min.x).toBeCloseTo(120);
    expect(front.max.x).toBeCloseTo(180);

    const back = build(doc, { edge: 3, width: 60, reach: 40, overhang: 12 }).bounds();
    expect(back.max.y).toBeCloseTo(140 + 28);
    expect(back.min.y).toBeCloseTo(140 - 12);
  });

  test("`along` shifts the clamp down the edge from its midpoint", () => {
    const doc = docWithBlank();
    const b = build(doc, { edge: 0, width: 60, along: 30 }).bounds();
    expect(b.min.y).toBeCloseTo(90);
    expect(b.max.y).toBeCloseTo(150);
  });

  test("every edge choice puts the clamp on a DIFFERENT face", () => {
    // Positive control for the per-edge tests: proves the `edge` param is read
    // at all, rather than four assertions that would pass on a hardcoded edge.
    const doc = docWithBlank();
    const centres = [0, 1, 2, 3].map((edge) => {
      const bb = build(doc, { edge }).bounds();
      return `${((bb.min.x + bb.max.x) / 2).toFixed(1)},${((bb.min.y + bb.max.y) / 2).toFixed(1)}`;
    });
    expect(new Set(centres).size).toBe(4);
  });
});

describe("the clamp is workholding, not geometry", () => {
  test("it lands on a fixture layer and carries its own height", () => {
    const doc = docWithBlank();
    const res = runGenerator(doc, GENERATORS.clamp, { height: 15 });
    const layer = doc.layers.find((l) => l.name === "Workholding");
    expect(layer?.fixture).toBe(true);
    // The height belongs to the clamp, NOT the layer — that is what lets a
    // second clamp of a different height share this layer.
    expect(layer?.fixtureHeight).toBeUndefined();
    const ent = doc.entities.find((e) => e.id === res.group.entityIds[0])!;
    expect(ent.fixtureHeight).toBe(15);
    expect(ent.layerId).toBe(layer!.id);
  });

  test("two clamps of different heights coexist on the one layer", () => {
    const doc = docWithBlank();
    runGenerator(doc, GENERATORS.clamp, { edge: 0, height: 12 });
    runGenerator(doc, GENERATORS.clamp, { edge: 1, height: 30 });
    expect(doc.layers.filter((l) => l.name === "Workholding")).toHaveLength(1);
    const heights = fixturePolygons(doc)
      .map((f) => f.height)
      .sort((a, b) => a - b);
    expect(heights).toEqual([12, 30]);
  });

  test("it suggests no toolpaths — workholding is never cut", () => {
    const s = new Sketch({ stock: stockDatum(docWithBlank()) });
    clamp.build(s);
    expect(s.opSuggestions).toHaveLength(0);
  });
});

describe("it follows the blank", () => {
  test("runGenerator does NOT centre it on the work area", () => {
    // The whole point of placement:"stock". A centred clamp would sit in the
    // middle of the part holding nothing.
    const doc = docWithBlank();
    const res = runGenerator(doc, GENERATORS.clamp, { edge: 0, reach: 40, overhang: 12 });
    expect(res.feature.offset).toEqual({ x: 0, y: 0 });
    const b = (doc.entities.find((e) => e.id === res.group.entityIds[0]) as RectEntity).bounds();
    expect(b.max.x).toBeCloseTo(62); // still on the blank's left face
  });

  test("resizing the stock slides the clamp onto the new edge", () => {
    const doc = docWithBlank();
    runGenerator(doc, GENERATORS.clamp, { edge: 1, reach: 40, overhang: 12 });
    const before = fixturePolygons(doc)[0].poly.map((p) => p.x);
    expect(Math.max(...before)).toBeCloseTo(278); // right face 250 + 28 outboard

    doc.stockRect = { x: 50, y: 40, width: 300, height: 100 };
    expect(regenerateStockPlacedFeatures(doc)).toBe(true);

    const after = fixturePolygons(doc)[0].poly.map((p) => p.x);
    expect(Math.max(...after)).toBeCloseTo(378); // right face is now 350
  });

  test("moving the blank moves the clamp with it", () => {
    const doc = docWithBlank();
    runGenerator(doc, GENERATORS.clamp, { edge: 0, reach: 40, overhang: 12 });
    doc.stockRect = { x: 120, y: 40, width: 200, height: 100 };
    regenerateStockPlacedFeatures(doc);
    const xs = fixturePolygons(doc)[0].poly.map((p) => p.x);
    expect(Math.min(...xs)).toBeCloseTo(92); // left face 120 - 28 outboard
  });

  test("a clamp keeps its entity id across a rebuild", () => {
    // Ids surviving is what keeps anything attached to the clamp valid.
    const doc = docWithBlank();
    const res = runGenerator(doc, GENERATORS.clamp, { edge: 0 });
    const id = res.group.entityIds[0];
    doc.stockRect = { x: 50, y: 40, width: 260, height: 100 };
    regenerateStockPlacedFeatures(doc);
    expect(doc.features[0].groupId).toBe(res.group.id);
    expect(doc.groups.find((g) => g.id === res.group.id)!.entityIds).toEqual([id]);
  });

  test("a non-stock generator is left alone by the stock rebuild", () => {
    // Negative control with a positive companion: proves the rebuild is
    // selective rather than a no-op that happens to look right.
    const doc = docWithBlank();
    runGenerator(doc, GENERATORS.panel, { width: 100, height: 80 });
    expect(regenerateStockPlacedFeatures(doc)).toBe(false);
    runGenerator(doc, GENERATORS.clamp, {});
    expect(regenerateStockPlacedFeatures(doc)).toBe(true);
  });

  test("editing a parameter re-derives the position from the CURRENT blank", () => {
    const doc = docWithBlank();
    const res = runGenerator(doc, GENERATORS.clamp, { edge: 0, reach: 40, overhang: 12 });
    doc.stockRect = { x: 200, y: 40, width: 200, height: 100 };
    regenerateFeature(doc, res.feature.id, { overhang: 20 });
    const xs = fixturePolygons(doc)[0].poly.map((p) => p.x);
    expect(Math.max(...xs)).toBeCloseTo(220); // new face 200 + new overhang 20
  });
});

describe("degenerate input", () => {
  test("no stock emits no clamp, and says why", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    doc.stockRect = { x: 0, y: 0, width: 0, height: 0 };
    const s = new Sketch({ stock: stockDatum(doc) });
    expect(clamp.build(s)).toHaveLength(0);
    expect(s.notes.join(" ")).toMatch(/no stock/i);
  });

  test("an overhang deeper than the reach is capped, not silently obeyed", () => {
    const doc = docWithBlank();
    const s = new Sketch({ params: { edge: 0, reach: 20, overhang: 50 }, stock: stockDatum(doc) });
    const r = clamp.build(s)[0].entity as RectEntity;
    expect(r.bounds().max.x - r.bounds().min.x).toBeCloseTo(20);
    expect(s.notes.join(" ")).toMatch(/can't exceed reach/i);
  });

  test("an unrecognised edge falls back to the default rather than a wrong face", () => {
    const doc = docWithBlank();
    const s = new Sketch({ params: { edge: 7 }, stock: stockDatum(doc) });
    clamp.build(s);
    expect(s.params.find((p) => p.name === "edge")!.value).toBe(0);
  });
});
