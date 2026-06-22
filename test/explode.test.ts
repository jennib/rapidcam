/**
 * Explode: rectangles and polylines break into individually selectable lines.
 */

import { describe, it, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity, RectEntity, PolylineEntity, CircleEntity } from "../src/model/entities";
import { explodeSelected } from "../src/tools/explodeCommand";

describe("explodeSelected", () => {
  it("turns a rectangle into 4 lines", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const rect = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 100, y: 50 }));
    rect.selected = true;

    expect(explodeSelected(doc)).toBe(true);
    const lines = doc.entities.filter((e) => e instanceof LineEntity) as LineEntity[];
    expect(lines.length).toBe(4);
    expect(doc.entities.some((e) => e instanceof RectEntity)).toBe(false);
    // Every new line is selected and closes back to the start.
    expect(lines.every((l) => l.selected)).toBe(true);
    const total = lines.reduce((s, l) => s + l.length, 0);
    expect(total).toBeCloseTo(2 * (100 + 50));
  });

  it("turns a closed polyline into one line per edge", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const pl = doc.add(new PolylineEntity(
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], true,
    ));
    pl.selected = true;

    expect(explodeSelected(doc)).toBe(true);
    const lines = doc.entities.filter((e) => e instanceof LineEntity);
    expect(lines.length).toBe(3); // closed → 3 edges
  });

  it("leaves circles untouched and reports no change", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const c = doc.add(new CircleEntity({ x: 0, y: 0 }, 10));
    c.selected = true;
    expect(explodeSelected(doc)).toBe(false);
    expect(doc.entities.some((e) => e instanceof CircleEntity)).toBe(true);
  });

  it("preserves layer and construction flags", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const rect = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 20, y: 20 }));
    rect.isConstruction = true;
    rect.layerId = "layer-0";
    rect.selected = true;
    explodeSelected(doc);
    const lines = doc.entities.filter((e) => e instanceof LineEntity) as LineEntity[];
    expect(lines.every((l) => l.isConstruction && l.layerId === "layer-0")).toBe(true);
  });
});
