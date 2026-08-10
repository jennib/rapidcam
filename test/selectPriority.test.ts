/**
 * Pick-priority fixes: dimension lines must not shadow entity bodies (they used
 * a looser tolerance and always won), and a drag started inside the selection's
 * bounds moves the selection even off the outlines (Illustrator convention),
 * while a plain click there still deselects.
 */

import { describe, it, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity, RectEntity } from "../src/model/entities";
import { SelectTool } from "../src/tools/selectTool";
import type { ToolContext, ToolPointerEvent } from "../src/tools/tool";
import { SnapEngine } from "../src/input/snapping";
import { makeDimension, dimensionLayout } from "../src/model/dimensions";
import type { Vec2 } from "../src/core/vec2";

function makeCtx(doc: CADDocument, dof = 4): ToolContext {
  const snap = new SnapEngine();
  snap.gridEnabled = false; // keep drag deltas exact for assertions
  return {
    doc,
    view: {
      scale: 1,
      worldToScreen: (p: Vec2) => p,
      toWorldLen: (px: number) => px,
    } as unknown as ToolContext["view"],
    requestRender() {},
    solve() {},
    pushHistory() {},
    openDimEditor() {},
    currentDof: () => dof,
    openTypeToDraw() {},
    closeTypeToDraw() {},
    notify() {},
    setHint() {},
    snap,
  };
}

function ev(pos: Vec2): ToolPointerEvent {
  return {
    world: pos,
    worldRaw: pos,
    screen: pos,
    snap: null,
    button: 0,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
  };
}

describe("dimension vs entity-body priority", () => {
  function setup() {
    const doc = new CADDocument({ width: 200, height: 200 });
    const line = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 0 })) as LineEntity;
    const dim = makeDimension("distance", {
      points: [
        { entityId: line.id, key: "a" },
        { entityId: line.id, key: "b" },
      ],
      value: 100,
      offset: 6,
    });
    doc.dimensions.push(dim);
    const geo = (id: string) => doc.entities.find((e) => e.id === id);
    const layout = dimensionLayout(dim, geo, "mm")!;
    return { doc, line, dim, layout };
  }

  it("clicking ON the entity selects it even with a dimension line 6px away", () => {
    const { doc, line } = setup();
    const tool = new SelectTool();
    const ctx = makeCtx(doc);
    // Mid-body click, but away from the endpoints and midpoint (x=30).
    tool.onPointerDown(ev({ x: 30, y: 0 }), ctx);
    tool.onPointerUp(ev({ x: 30, y: 0 }), ctx);
    expect(line.selected).toBe(true);
    expect(doc.selectedDimensionId).toBeNull();
  });

  it("clicking on the dimension line (nearest thing) still selects the dimension", () => {
    const { doc, dim, layout } = setup();
    const tool = new SelectTool();
    const ctx = makeCtx(doc);
    // On the dimension line, 30px from the label so the label branch doesn't fire.
    const p = { x: layout.textPos.x + 30, y: layout.textPos.y };
    tool.onPointerDown(ev(p), ctx);
    tool.onPointerUp(ev(p), ctx);
    expect(doc.selectedDimensionId).toBe(dim.id);
  });
});

describe("drag inside the selection bounds", () => {
  function setup() {
    const doc = new CADDocument({ width: 200, height: 200 });
    const rect = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 100, y: 50 })) as RectEntity;
    rect.selected = true;
    return { doc, rect };
  }

  it("moves the selection when the press turns into a drag", () => {
    const { doc, rect } = setup();
    const tool = new SelectTool();
    const ctx = makeCtx(doc);
    // Interior point: >10px from every outline, handle, and edge-midpoint.
    tool.onPointerDown(ev({ x: 50, y: 25 }), ctx);
    tool.onPointerMove(ev({ x: 60, y: 35 }), ctx);
    tool.onPointerUp(ev({ x: 60, y: 35 }), ctx);
    const moved = doc.entities.find((e) => e.id === rect.id) as RectEntity;
    expect(moved.p0.x).toBeCloseTo(10);
    expect(moved.p0.y).toBeCloseTo(10);
    expect(moved.selected).toBe(true); // drag keeps the selection
  });

  it("clears the selection when the press stays a click", () => {
    const { doc, rect } = setup();
    const tool = new SelectTool();
    const ctx = makeCtx(doc);
    tool.onPointerDown(ev({ x: 50, y: 25 }), ctx);
    tool.onPointerUp(ev({ x: 50, y: 25 }), ctx);
    const same = doc.entities.find((e) => e.id === rect.id) as RectEntity;
    expect(same.selected).toBe(false);
    expect(same.p0).toEqual({ x: 0, y: 0 }); // and nothing moved
  });
});
