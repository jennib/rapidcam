import { describe, it, expect } from "vitest";
import { LineEntity, RectEntity } from "../src/model/entities";
import { CADDocument } from "../src/model/document";
import { RectTool } from "../src/tools/rectTool";
import type { ToolContext, ToolPointerEvent } from "../src/tools/tool";
import { SnapEngine } from "../src/input/snapping";
import type { Vec2 } from "../src/core/vec2";

function makeCtx(doc: CADDocument): ToolContext {
  return {
    doc,
    view: { scale: 1 } as ToolContext["view"],
    requestRender() {},
    solve() {},
    pushHistory() {},
    openDimEditor() {},
    currentDof: () => 0,
    openValueEditor() {},
    openMultiValueEditor() {},
    closeValueEditor() {},
    notify() {},
    setHint() {},
    snap: new SnapEngine(),
  };
}

function click(tool: RectTool, ctx: ToolContext, pos: Vec2): void {
  const e: ToolPointerEvent = {
    world: pos,
    worldRaw: pos,
    screen: pos,
    snap: null,
    button: 0,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
  };
  tool.onPointerDown(e, ctx);
}

const rectsOf = (doc: CADDocument) => doc.entities.filter((e): e is RectEntity => e instanceof RectEntity);

describe("RectTool", () => {
  it("emits a single whole-shape RectEntity (not four lines) sized by the corners", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const ctx = makeCtx(doc);
    const tool = new RectTool();
    click(tool, ctx, { x: 20, y: 30 });
    click(tool, ctx, { x: 170, y: 130 });

    // One resizable object with editable Width/Height — not four separate lines.
    const rects = rectsOf(doc);
    expect(rects).toHaveLength(1);
    expect(doc.entities.some((e) => e instanceof LineEntity)).toBe(false);
    const rect = rects[0];
    expect(rect.width).toBeCloseTo(150);
    expect(rect.height).toBeCloseTo(100);
    expect(rect.selected).toBe(true);
  });

  it("normalizes corners regardless of click order", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const ctx = makeCtx(doc);
    const tool = new RectTool();
    // Click top-right first, then bottom-left.
    click(tool, ctx, { x: 170, y: 130 });
    click(tool, ctx, { x: 20, y: 30 });

    const rect = rectsOf(doc)[0];
    expect(rect.bounds().min).toEqual({ x: 20, y: 30 });
    expect(rect.bounds().max).toEqual({ x: 170, y: 130 });
  });

  it("carries the construction flag when drawn in construction mode", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    doc.isConstructionMode = true;
    const ctx = makeCtx(doc);
    const tool = new RectTool();
    click(tool, ctx, { x: 0, y: 0 });
    click(tool, ctx, { x: 50, y: 40 });

    expect(rectsOf(doc)[0].isConstruction).toBe(true);
  });

  it("commits nothing for a degenerate (zero-area) rectangle", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const ctx = makeCtx(doc);
    const tool = new RectTool();
    click(tool, ctx, { x: 10, y: 10 });
    click(tool, ctx, { x: 10, y: 90 }); // zero width → no rectangle

    expect(rectsOf(doc)).toHaveLength(0);
  });
});
