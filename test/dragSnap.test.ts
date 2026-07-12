import { describe, it, expect } from "vitest";
import { SnapEngine } from "../src/input/snapping";
import { Viewport } from "../src/view/viewport";
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";

// Snap-while-moving: SnapEngine.resolveDrag corrects an entity-drag delta so a
// point of the dragged selection lands on another entity's snap point (object
// snap) or the grid, mirroring resolve()'s priority. The dragged entities are
// excluded from the target set. Note the document's origin marker at (0, 0) is
// itself snappable — geometry here stays far from it.

function setup() {
  const view = new Viewport();
  view.scale = 10; // px/mm → 10 px tolerance = 1 mm
  const doc = new CADDocument({ width: 200, height: 200 });
  const dragged = new LineEntity({ x: 50, y: 50 }, { x: 60, y: 50 });
  const target = new LineEntity({ x: 100, y: 50 }, { x: 130, y: 80 });
  doc.entities.push(dragged, target);
  const engine = new SnapEngine();
  return { view, doc, dragged, target, engine };
}

describe("SnapEngine.resolveDrag", () => {
  it("captures a dragged endpoint onto another entity's endpoint", () => {
    const { view, doc, dragged, engine } = setup();
    engine.gridEnabled = false;
    const moved = [dragged.a, dragged.b].map((p) => ({ ...p }));
    // Raw delta leaves dragged.a 0.4 mm (4 px) short of the target's (100, 50).
    const r = engine.resolveDrag({ x: 49.6, y: 0.05 }, moved, view, doc, new Set([dragged.id]));
    expect(r.delta.x).toBeCloseTo(50);
    expect(r.delta.y).toBeCloseTo(0);
    expect(r.snap).not.toBeNull();
    expect(r.snap!.pos.x).toBeCloseTo(100);
    expect(r.snap!.pos.y).toBeCloseTo(50);
  });

  it("leaves the delta alone beyond the pixel tolerance", () => {
    const { view, doc, dragged, engine } = setup();
    engine.gridEnabled = false;
    const moved = [{ ...dragged.a }];
    const r = engine.resolveDrag({ x: 30, y: 20 }, moved, view, doc, new Set([dragged.id]));
    expect(r.delta).toEqual({ x: 30, y: 20 });
    expect(r.snap).toBeNull();
  });

  it("falls back to quantising the anchor point to the grid", () => {
    const { view, doc, dragged, engine } = setup();
    engine.objectSnapEnabled = false;
    engine.gridEnabled = true;
    // At 10 px/mm the minor grid step is 2 mm; (50, 50) + (3.3, 0.2) → (54, 50).
    const r = engine.resolveDrag({ x: 3.3, y: 0.2 }, [{ ...dragged.a }], view, doc, new Set());
    expect(r.delta.x).toBeCloseTo(4);
    expect(r.delta.y).toBeCloseTo(0);
    expect(r.snap).toBeNull(); // grid snaps draw no marker
  });

  it("never snaps to the dragged entities themselves", () => {
    const { view, doc, dragged, target, engine } = setup();
    engine.gridEnabled = false;
    // Exclude BOTH entities: nothing near remains → delta unchanged, even
    // though the raw delta would land dragged.a exactly on target.a.
    const r = engine.resolveDrag(
      { x: 50, y: 0.05 },
      [{ ...dragged.a }],
      view,
      doc,
      new Set([dragged.id, target.id]),
    );
    expect(r.delta).toEqual({ x: 50, y: 0.05 });
    expect(r.snap).toBeNull();
  });
});
