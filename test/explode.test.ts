/**
 * Explode: rectangles and polylines break into individually selectable lines.
 */

import { describe, it, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity, RectEntity, PolylineEntity, CircleEntity } from "../src/model/entities";
import { explodeSelected } from "../src/tools/explodeCommand";
import { solve } from "../src/solver/solver";

const dof = (doc: CADDocument): number => {
  const r = solve(doc);
  return r.variables - r.equations;
};

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

  it("explodes a rectangle into a FULLY CONSTRAINED rectangle (the old tool's form)", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const rect = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 100, y: 50 }));
    rect.selected = true;
    expect(explodeSelected(doc)).toBe(true);

    // The constraint set that makes four lines behave as a rectangle: opposite
    // sides parallel, one right angle, and the four corners pinned together.
    const byType = (t: string) => doc.constraints.filter((c) => c.type === t).length;
    expect(byType("parallel")).toBe(2);
    expect(byType("perpendicular")).toBe(1);
    expect(byType("coincident")).toBe(4);

    // 4 lines (16 point DOFs) − 11 equations (4 coincident×2 + 2 parallel + 1
    // perpendicular) = 5 DOF: position + width + height + rotation. Exactly a
    // hand-drawn rectangle — nothing lost versus emitting four lines up front.
    expect(dof(doc)).toBe(5);
  });

  it("keeps the exploded rectangle rectangular through a solve", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const rect = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 100, y: 50 }));
    rect.selected = true;
    explodeSelected(doc);
    solve(doc); // constraints already satisfied → geometry unchanged, not degenerate

    const lines = doc.entities.filter((e): e is LineEntity => e instanceof LineEntity);
    expect(lines).toHaveLength(4);
    // Opposite sides stay equal length and corners stay closed.
    const lens = lines.map((l) => l.length).sort((a, b) => a - b);
    expect(lens[0]).toBeCloseTo(50);
    expect(lens[1]).toBeCloseTo(50);
    expect(lens[2]).toBeCloseTo(100);
    expect(lens[3]).toBeCloseTo(100);
  });

  it("explodes a polyline into UNCONSTRAINED segments (no implied parallelism)", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const pl = doc.add(
      new PolylineEntity(
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ],
        true,
      ),
    );
    pl.selected = true;
    explodeSelected(doc);
    // A polyline's edges carry no implied constraints — unlike a rectangle.
    expect(doc.constraints).toHaveLength(0);
  });

  it("turns a closed polyline into one line per edge", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const pl = doc.add(
      new PolylineEntity(
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ],
        true,
      ),
    );
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
