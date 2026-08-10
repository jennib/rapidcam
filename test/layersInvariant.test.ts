import { describe, expect, test } from "vitest";
import { CADDocument, DEFAULT_LAYER_ID, ORIGIN_ENTITY_ID } from "../src/model/document";
import { RectEntity, TextEntity } from "../src/model/entities";
import { applyFile, parseRcam } from "../src/io/fileio";

/**
 * A document must always have at least one layer.
 *
 * This is not a theoretical invariant. An AI-authored file wrote `"layers": []`
 * with `"activeLayerId": "layer-0"`; `restore()` tested the array's truthiness
 * rather than its length, so the document ended up with none while every entity
 * still carried `layerId: "layer-0"`. The renderer's `layers.find(...) ||
 * layers[0]` then produced `undefined`, and reading `.visible` off it threw on
 * the first entity — aborting the frame inside `drawEntities`, so the canvas
 * kept its grid, stock and origin and lost all geometry. Picking, snapping and
 * machinability all spelled the same lookup and would have thrown too.
 *
 * The assertions are therefore made through the *consumers* of the lookup
 * (`layerFor`, `isPickable`, `snapPoints`), not just against `doc.layers.length`
 * — a length check alone would still pass if some future caller reintroduced
 * its own `layers[0]`.
 */

/** The minimum file that reproduced the fault, parameterised on its layer fields. */
function fileWith(layers: unknown, activeLayerId: unknown): string {
  return JSON.stringify({
    version: 3,
    name: "Hello World VCarve",
    canvas: { width: 300, height: 250 },
    displayUnit: "mm",
    stockThickness: 10,
    origin: { x: "left", y: "front", z: "top" },
    entities: [
      { type: "rectangle", id: "rect1", p0: { x: 10, y: 10 }, p1: { x: 90, y: 60 } },
      {
        type: "text",
        id: "text1",
        text: "Hello World",
        fontId: "roboto-regular",
        sizeMM: 10,
        position: { x: 20, y: 30 },
        angle: 0,
      },
    ],
    layers,
    activeLayerId,
  });
}

function load(layers: unknown, activeLayerId: unknown): CADDocument {
  const doc = new CADDocument({ width: 100, height: 100 });
  applyFile(doc, parseRcam(fileWith(layers, activeLayerId)));
  return doc;
}

describe("a document always has a layer", () => {
  test('"layers": [] loads as the default layer, not as none', () => {
    const doc = load([], "layer-0");
    expect(doc.layers).toHaveLength(1);
    expect(doc.layers[0].id).toBe(DEFAULT_LAYER_ID);
    expect(doc.activeLayerId).toBe(DEFAULT_LAYER_ID);
  });

  test("entities from a layers:[] file are visible, pickable and snappable", () => {
    const doc = load([], "layer-0");
    const rect = doc.entities.find((e) => e.id === "rect1")!;
    const text = doc.entities.find((e) => e.id === "text1")!;
    expect(rect).toBeInstanceOf(RectEntity);
    expect(text).toBeInstanceOf(TextEntity);

    // The exact lookup the renderer makes, for every entity in the document.
    for (const e of doc.entities) {
      expect(doc.layerFor(e)).toBeDefined();
      expect(doc.layerFor(e).visible).toBe(true);
    }
    expect(doc.isPickable(rect)).toBe(true);
    expect(doc.isPickable(text)).toBe(true);
    expect(doc.snapPoints().length).toBeGreaterThan(0);
  });

  // Positive control: the hidden-layer path still bites, so the test above is
  // not passing merely because everything reports visible unconditionally.
  test("a hidden layer still hides its geometry", () => {
    const doc = load(
      [{ id: "l-cut", name: "Cut", color: "#000000", visible: false, locked: false }],
      "l-cut",
    );
    const rect = doc.entities.find((e) => e.id === "rect1")!;
    expect(doc.layers).toHaveLength(1);
    expect(doc.layerFor(rect).visible).toBe(false);
    expect(doc.isPickable(rect)).toBe(false);
  });

  test("activeLayerId naming no layer falls back to one that exists", () => {
    // A file that renames its layer but leaves the stock activeLayerId behind:
    // new geometry would otherwise be filed onto an absent "layer-0".
    const doc = load(
      [{ id: "l-cut", name: "Cut", color: "#000000", visible: true, locked: false }],
      "layer-0",
    );
    expect(doc.activeLayerId).toBe("l-cut");
    expect(doc.layers.some((l) => l.id === doc.activeLayerId)).toBe(true);
  });

  test("omitting layers entirely still yields the default layer", () => {
    const doc = load(undefined, undefined);
    expect(doc.layers).toHaveLength(1);
    expect(doc.layers[0].id).toBe(DEFAULT_LAYER_ID);
    expect(doc.activeLayerId).toBe(DEFAULT_LAYER_ID);
  });

  test("layerFor is total even if layers is emptied behind its back", () => {
    const doc = load([], "layer-0");
    doc.layers = [];
    const rect = doc.entities.find((e) => e.id === "rect1")!;
    expect(() => doc.layerFor(rect)).not.toThrow();
    expect(doc.layerFor(rect).id).toBe(DEFAULT_LAYER_ID);
    expect(() => doc.isPickable(rect)).not.toThrow();
    expect(() => doc.snapPoints()).not.toThrow();
  });

  test("clear() and a fresh document agree on the default layer", () => {
    const doc = new CADDocument({ width: 100, height: 100 });
    const fresh = JSON.stringify(doc.layers);
    doc.add(new RectEntity({ x: 0, y: 0 }, { x: 10, y: 10 }));
    doc.clear();
    expect(JSON.stringify(doc.layers)).toBe(fresh);
    expect(doc.activeLayerId).toBe(DEFAULT_LAYER_ID);
    expect(doc.entities.map((e) => e.id)).toEqual([ORIGIN_ENTITY_ID]);
  });
});
