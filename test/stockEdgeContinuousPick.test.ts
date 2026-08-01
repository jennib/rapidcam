/**
 * The stock rect's corner/midpoint points (via CADDocument.pickPoint, see
 * stockRefDimension.test.ts) are each only an ~8px hotspot. This covers the gap
 * on top of that: clicking ANYWHERE along a stock edge — like clicking anywhere
 * on a real rectangle's edge — should pick that edge, not just its exact corners
 * and midpoint. Reported: "can I dimension a vertical line to the left edge of
 * the stock" — clicking mid-edge (not a hotspot) previously did nothing at all.
 *
 * A first attempt at this fix offered the same continuous pick while RE-SELECTING
 * the second point during "placeLinear" — which also governs the FINAL placement
 * click. Since the stock usually fills or nearly fills the canvas, an ordinary
 * "click open space to place the dimension" click routinely lands within
 * tolerance of ITS edge too, silently swallowing the click instead of committing
 * (caught via imageDimensionOrphan.test.ts going from 1 dimension to 0). The
 * second test below guards that regression directly.
 */
import { describe, expect, it } from "vitest";
import type { Vec2 } from "../src/core/vec2";
import { SnapEngine } from "../src/input/snapping";
import { CADDocument, STOCK_ENTITY_ID } from "../src/model/document";
import { LineEntity, RasterImageEntity } from "../src/model/entities";
import { DimensionTool } from "../src/tools/dimensionTool";
import type { ToolContext, ToolPointerEvent } from "../src/tools/tool";

function makeCtx(doc: CADDocument): ToolContext {
  return {
    doc,
    view: { scale: 1, toWorldLen: (px: number) => px } as ToolContext["view"],
    requestRender() {},
    solve() {},
    pushHistory() {},
    openDimEditor() {},
    currentDof: () => 5,
    openValueEditor() {},
    openMultiValueEditor() {},
    closeValueEditor() {},
    notify() {},
    setHint() {},
    snap: new SnapEngine(),
  };
}

function event(pos: Vec2): ToolPointerEvent {
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
function click(tool: DimensionTool, ctx: ToolContext, pos: Vec2): void {
  tool.onPointerDown(event(pos), ctx);
}
function move(tool: DimensionTool, ctx: ToolContext, pos: Vec2): void {
  tool.onPointerMove(event(pos), ctx);
}

describe("continuous stock-edge picking", () => {
  it("clicking mid-edge (not a corner or exact midpoint) picks that edge as the FIRST point", () => {
    const doc = new CADDocument({ width: 300, height: 250 });
    doc.stockRect = { x: 50, y: 50, width: 200, height: 150 }; // left edge y:50..200
    const line = doc.add(new LineEntity({ x: 150, y: 70 }, { x: 150, y: 170 }));
    const ctx = makeCtx(doc);
    const tool = new DimensionTool();

    click(tool, ctx, { x: 50, y: 90 }); // deliberately off bl(50,50), mid_l(50,125), tl(50,200)
    // On the line's body, but far enough from its own a/mid/b DOF points (70,
    // 120, 170) that this exercises the generic hitTest edge-click path — not
    // an exact-point pick, which (same as clicking a rectangle edge precisely
    // on another entity's endpoint) skips the firstMid simplification and
    // would leave p1 on the stock's raw corner instead of its edge midpoint.
    // The measured distance is identical either way (the edge is vertical, so
    // every point on it shares the same x) — this just keeps the assertion
    // below matching what a normal "click the line" gesture actually produces.
    move(tool, ctx, { x: 150, y: 140 });
    click(tool, ctx, { x: 150, y: 140 });
    move(tool, ctx, { x: 100, y: 260 }); // place well above -> horizontal type
    click(tool, ctx, { x: 100, y: 260 });

    expect(doc.dimensions).toHaveLength(1);
    const dim = doc.dimensions[0];
    const stockPoint = dim.points.find((p) => p.entityId === STOCK_ENTITY_ID);
    expect(stockPoint?.key).toBe("mid_l");
    expect(dim.points.some((p) => p.entityId === line.id)).toBe(true);
    expect(dim.value).toBeCloseTo(100, 3); // |150 - 50|
  });

  it("an open-space placement click near the stock edge still commits — it is not reinterpreted as a re-pick", () => {
    const doc = new CADDocument({ width: 200, height: 200 }); // no stockRect: stock fills the canvas
    const img = doc.add(new RasterImageEntity("img1", { x: 20, y: 20 }, 100, 60));
    const ctx = makeCtx(doc);
    const tool = new DimensionTool();

    // Click the image's bottom edge, then place BELOW it — 5mm above the
    // canvas edge (y=0), which is also the (undrawn, legacy) stock's own edge.
    click(tool, ctx, { x: 70, y: 20 });
    move(tool, ctx, { x: 70, y: 5 });
    click(tool, ctx, { x: 70, y: 5 });

    expect(doc.dimensions).toHaveLength(1);
    expect(doc.dimensions[0].points.every((p) => p.entityId === img.id)).toBe(true);
  });
});
