/**
 * The stock rect's corner/midpoint points (via CADDocument.pickPoint, see
 * stockRefDimension.test.ts) are each only an ~8px hotspot. This covers the gap
 * on top of that: clicking ANYWHERE along a stock edge — like clicking anywhere
 * on a real rectangle's edge — should pick that edge, not just its exact corners
 * and midpoint. Reported: "can I dimension a vertical line to the left edge of
 * the stock" — clicking mid-edge (not a hotspot) previously did nothing at all.
 *
 * Two gestures used to share one click during "placeLinear" — re-targeting onto
 * a second edge, and the FINAL placement click — disambiguated only by proximity
 * to some other edge. That is not separable by position: the pick tolerance is
 * 8px/scale (~35mm of world at fit zoom), and once `pickStockEdge` stopped
 * requiring an explicit `doc.stockRect`, the stock's edges ARE the sheet boundary
 * in the default fills-the-sheet case. So an ordinary "click just outside the
 * part to place it" click landed in that band and was swallowed as a re-pick —
 * the dimension then measured the part-to-stock gap instead of what was asked
 * for (caught via imageDimensionOrphan.test.ts going 1 dimension -> 0).
 *
 * Gating on `doc.stockRect` was tried and rejected: it killed the reported
 * gesture outright (starting from a line, clicking the stock edge just kept
 * defining the line's own length) precisely when stock fills the sheet.
 *
 * So the two gestures are now separated by INPUT, not position: a bare click
 * always places, and Shift-click re-targets onto another edge. Placing is the
 * overwhelmingly common action, so it keeps the bare click; the hover preview
 * only shows a re-target while Shift is held, so the preview always matches what
 * a click would do.
 */
import { describe, expect, it } from "vitest";
import type { Vec2 } from "../src/core/vec2";
import { SnapEngine } from "../src/input/snapping";
import { CADDocument, STOCK_ENTITY_ID } from "../src/model/document";
import { LineEntity, RasterImageEntity } from "../src/model/entities";
import { DimensionTool } from "../src/tools/dimensionTool";
import type { Dimension } from "../src/model/dimensions";
import type { ToolContext, ToolPointerEvent } from "../src/tools/tool";

/**
 * Which entities a dimension is anchored to, regardless of how it stores
 * them. Point dimensions keep PointRefs; an edge-to-edge "line-distance"
 * dimension keeps `entities`, edge-qualified as "<id>#mid_l". Two parallel
 * edges now produce the latter, so these tests assert the anchoring the user
 * asked for rather than one particular encoding of it.
 */
function anchorIds(dim: Dimension): string[] {
  return [...dim.points.map((p) => p.entityId), ...dim.entities.map((e) => e.split("#")[0])];
}

function makeCtx(doc: CADDocument): ToolContext {
  return {
    doc,
    view: { scale: 1, toWorldLen: (px: number) => px } as ToolContext["view"],
    requestRender() {},
    solve() {},
    pushHistory() {},
    openDimEditor() {},
    currentDof: () => 5,
    openTypeToDraw() {},
    closeTypeToDraw() {},
    notify() {},
    setHint() {},
    snap: new SnapEngine(),
  };
}

function event(pos: Vec2, shiftKey = false): ToolPointerEvent {
  return {
    world: pos,
    worldRaw: pos,
    screen: pos,
    snap: null,
    button: 0,
    shiftKey,
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
/**
 * Re-target the dimension onto a SECOND edge. During "placeLinear" a bare click
 * always places the dimension, so redirecting onto another edge takes Shift —
 * otherwise "click just outside the part to place it" lands in the stock edge's
 * ~35mm-at-fit-zoom pick band and silently measures the gap instead.
 */
function shiftClick(tool: DimensionTool, ctx: ToolContext, pos: Vec2): void {
  tool.onPointerMove(event(pos, true), ctx);
  tool.onPointerDown(event(pos, true), ctx);
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
    shiftClick(tool, ctx, { x: 150, y: 140 });
    move(tool, ctx, { x: 100, y: 260 }); // place well above -> horizontal type
    click(tool, ctx, { x: 100, y: 260 });

    expect(doc.dimensions).toHaveLength(1);
    const dim = doc.dimensions[0];
    expect(anchorIds(dim)).toContain(STOCK_ENTITY_ID);
    expect(anchorIds(dim)).toContain(line.id);
    // The stock side names WHICH edge — the left one that was clicked.
    expect(dim.entities.some((e) => e === `${STOCK_ENTITY_ID}#mid_l`)).toBe(true);
    expect(dim.value).toBeCloseTo(100, 3); // |150 - 50|
  });

  it("clicking the LINE first, then the stock edge mid-point second, redirects onto the stock (not the line's own length)", () => {
    // The exact reported failure: starting from the stock worked, starting
    // from the line did not — clicking the stock edge second just kept
    // defining the line's own length, because the FIRST fix attempt disabled
    // the continuous stock pick entirely during "placeLinear" (see the file
    // banner comment) rather than gating it on a real, visible stockRect.
    const doc = new CADDocument({ width: 300, height: 250 });
    doc.stockRect = { x: 50, y: 50, width: 200, height: 150 }; // left edge y:50..200
    const line = doc.add(new LineEntity({ x: 150, y: 70 }, { x: 150, y: 170 }));
    const ctx = makeCtx(doc);
    const tool = new DimensionTool();

    // y=100, not the line's exact endpoints/midpoint (70/120/170) — a generic
    // body click (hits the "first" phase's hit.type==="line" branch, which goes
    // straight to "placeLinear"), not an exact-point pick (which would instead
    // land in "second" phase — a different, discrete-points-only code path).
    click(tool, ctx, { x: 150, y: 100 }); // the line's body -> starts as "measure my own length"
    // Re-target onto the stock's left edge, off any hotspot.
    shiftClick(tool, ctx, { x: 50, y: 90 });
    move(tool, ctx, { x: 100, y: 260 }); // place well above the midpoint -> horizontal type
    click(tool, ctx, { x: 100, y: 260 });

    expect(doc.dimensions).toHaveLength(1);
    const dim = doc.dimensions[0];
    // Must NOT be the line's own two endpoints (its length, 100mm) — must be
    // redirected to measure against the stock edge instead.
    expect(anchorIds(dim)).toContain(STOCK_ENTITY_ID);
    expect(anchorIds(dim)).toContain(line.id);
    expect(dim.value).toBeCloseTo(100, 3); // |150 - 50|, same edge, different anchor
  });

  it("anchors the gap where you CLICKED, not at either edge's midpoint", () => {
    // The reported complaint: "the dimension line snaps to the mid points of
    // the vertical line and the left edge ... looks terrible and is not the
    // intent". Both anchors used to jump to their own edge's midpoint — two
    // unrelated heights — because a stock/rect edge could not be named
    // individually, so the dimension degraded to a point dimension.
    const doc = new CADDocument({ width: 300, height: 250 });
    doc.stockRect = { x: 50, y: 50, width: 200, height: 150 }; // left edge y:50..200, mid y=125
    doc.add(new LineEntity({ x: 150, y: 70 }, { x: 150, y: 170 })); // mid y=120
    const ctx = makeCtx(doc);
    const tool = new DimensionTool();

    // Click both sides LOW (y=90) — nowhere near either midpoint (125 / 120).
    click(tool, ctx, { x: 150, y: 90 });
    shiftClick(tool, ctx, { x: 50, y: 90 });
    move(tool, ctx, { x: 100, y: 90 });
    click(tool, ctx, { x: 100, y: 90 });

    expect(doc.dimensions).toHaveLength(1);
    const dim = doc.dimensions[0];
    expect(dim.type).toBe("line-distance");
    expect(dim.value).toBeCloseTo(100, 3);

    // Resolve both anchors to world points and check they sit at the clicked
    // height, directly across from each other (a straight perpendicular span).
    const lineY = 70 + (dim.anchors?.[0] ?? 0.5) * 100; // line runs y 70 -> 170
    const stockY = 200 + (dim.anchors?.[1] ?? 0.5) * (50 - 200); // left edge tl -> bl
    expect(lineY).toBeCloseTo(90, 3);
    expect(stockY).toBeCloseTo(90, 3);
  });

  it("an open-space placement click commits — it is not reinterpreted as a re-pick", () => {
    const doc = new CADDocument({ width: 200, height: 200 }); // no stockRect: stock fills the canvas
    const img = doc.add(new RasterImageEntity("img1", { x: 20, y: 20 }, 100, 60));
    const ctx = makeCtx(doc);
    const tool = new DimensionTool();

    // Click the image's bottom edge, then place in open space BELOW it — at
    // y=5, INSIDE the stock edge's 8-unit pick band, which is exactly where a
    // bare click used to be swallowed as a re-pick.
    click(tool, ctx, { x: 70, y: 20 });
    move(tool, ctx, { x: 70, y: 5 });
    click(tool, ctx, { x: 70, y: 5 });

    expect(doc.dimensions).toHaveLength(1);
    expect(doc.dimensions[0].points.every((p) => p.entityId === img.id)).toBe(true);
  });

  it("dimensions from a stock edge to a line when stock fills the sheet (no stockRect)", () => {
    const doc = new CADDocument({ width: 300, height: 250 }); // stock fills sheet: left edge at x=0
    const line = doc.add(new LineEntity({ x: 100, y: 70 }, { x: 100, y: 170 }));
    const ctx = makeCtx(doc);
    const tool = new DimensionTool();

    // Click anywhere on the sheet/stock's left edge (x=0, y=90)
    click(tool, ctx, { x: 0, y: 90 });
    shiftClick(tool, ctx, { x: 100, y: 140 });
    move(tool, ctx, { x: 50, y: 220 });
    click(tool, ctx, { x: 50, y: 220 });

    expect(doc.dimensions).toHaveLength(1);
    const dim = doc.dimensions[0];
    expect(anchorIds(dim)).toContain(STOCK_ENTITY_ID);
    expect(anchorIds(dim)).toContain(line.id);
    expect(dim.value).toBeCloseTo(100, 3); // |100 - 0|
  });

  it("dimensions from a line to a stock edge when stock fills the sheet (no stockRect)", () => {
    const doc = new CADDocument({ width: 300, height: 250 }); // stock fills sheet: left edge at x=0
    const line = doc.add(new LineEntity({ x: 100, y: 70 }, { x: 100, y: 170 }));
    const ctx = makeCtx(doc);
    const tool = new DimensionTool();

    click(tool, ctx, { x: 100, y: 100 });
    shiftClick(tool, ctx, { x: 0, y: 90 });
    move(tool, ctx, { x: 50, y: 220 });
    click(tool, ctx, { x: 50, y: 220 });

    expect(doc.dimensions).toHaveLength(1);
    const dim = doc.dimensions[0];
    expect(anchorIds(dim)).toContain(STOCK_ENTITY_ID);
    expect(anchorIds(dim)).toContain(line.id);
    expect(dim.value).toBeCloseTo(100, 3); // |100 - 0|
  });

  it("dimensions from the left end of a horizontal line to the left stock edge when clicked near the left end", () => {
    const doc = new CADDocument({ width: 300, height: 250 });
    doc.stockRect = { x: 20, y: 20, width: 200, height: 150 }; // left edge at x=20
    const line = doc.add(new LineEntity({ x: 70, y: 100 }, { x: 170, y: 100 })); // horizontal line x: 70..170, y=100
    const ctx = makeCtx(doc);
    const tool = new DimensionTool();

    // Click on the horizontal line near its LEFT end (x=75, y=100)
    click(tool, ctx, { x: 75, y: 100 });
    // Click on the stock's left edge (x=20, y=80)
    move(tool, ctx, { x: 20, y: 80 });
    click(tool, ctx, { x: 20, y: 80 });
    // Place dimension above in open space
    move(tool, ctx, { x: 45, y: 130 });
    click(tool, ctx, { x: 45, y: 130 });

    expect(doc.dimensions).toHaveLength(1);
    const dim = doc.dimensions[0];
    expect(dim.type).toBe("horizontal");
    expect(dim.value).toBeCloseTo(50, 3); // |70 - 20|
    expect(dim.points[0]).toEqual({ entityId: line.id, key: "a" });
    expect(dim.points[1].entityId).toBe(STOCK_ENTITY_ID);
  });

  it("dimensions from a point to a stock edge when starting with a point pick in phase second", () => {
    const doc = new CADDocument({ width: 300, height: 250 });
    doc.stockRect = { x: 20, y: 20, width: 200, height: 150 }; // left edge at x=20
    const line = doc.add(new LineEntity({ x: 70, y: 100 }, { x: 170, y: 100 }));
    const ctx = makeCtx(doc);
    const tool = new DimensionTool();

    // Click exactly on the line's left endpoint (x=70, y=100) -> enters phase "second"
    click(tool, ctx, { x: 70, y: 100 });
    // Click anywhere on the stock's left edge (x=20, y=60)
    move(tool, ctx, { x: 20, y: 60 });
    click(tool, ctx, { x: 20, y: 60 });
    // Place dimension above in open space
    move(tool, ctx, { x: 45, y: 130 });
    click(tool, ctx, { x: 45, y: 130 });

    expect(doc.dimensions).toHaveLength(1);
    const dim = doc.dimensions[0];
    expect(dim.type).toBe("horizontal");
    expect(dim.value).toBeCloseTo(50, 3); // |70 - 20|
    expect(dim.points[0]).toEqual({ entityId: line.id, key: "a" });
    expect(dim.points[1].entityId).toBe(STOCK_ENTITY_ID);
  });

  it("dimensions from the right end of a horizontal line to the right stock edge when clicked near the right end", () => {
    const doc = new CADDocument({ width: 300, height: 250 });
    doc.stockRect = { x: 20, y: 20, width: 200, height: 150 }; // right edge at x=220
    const line = doc.add(new LineEntity({ x: 70, y: 100 }, { x: 170, y: 100 }));
    const ctx = makeCtx(doc);
    const tool = new DimensionTool();

    // Click on the horizontal line near its RIGHT end (x=165, y=100)
    click(tool, ctx, { x: 165, y: 100 });
    // Click on the stock's right edge (x=220, y=90)
    move(tool, ctx, { x: 220, y: 90 });
    click(tool, ctx, { x: 220, y: 90 });
    // Place dimension above
    move(tool, ctx, { x: 195, y: 130 });
    click(tool, ctx, { x: 195, y: 130 });

    expect(doc.dimensions).toHaveLength(1);
    const dim = doc.dimensions[0];
    expect(dim.type).toBe("horizontal");
    expect(dim.value).toBeCloseTo(50, 3); // |220 - 170|
    expect(dim.points[0]).toEqual({ entityId: line.id, key: "b" });
    expect(dim.points[1].entityId).toBe(STOCK_ENTITY_ID);
  });

  it("dimensions from the top end of a vertical line to the top stock edge", () => {
    const doc = new CADDocument({ width: 300, height: 250 });
    doc.stockRect = { x: 20, y: 20, width: 200, height: 150 }; // top edge at y=170
    const line = doc.add(new LineEntity({ x: 100, y: 50 }, { x: 100, y: 130 })); // top end at y=130
    const ctx = makeCtx(doc);
    const tool = new DimensionTool();

    // Click near top end of vertical line (x=100, y=125)
    click(tool, ctx, { x: 100, y: 125 });
    // Click on stock top edge (x=120, y=170)
    move(tool, ctx, { x: 120, y: 170 });
    click(tool, ctx, { x: 120, y: 170 });
    // Place dimension
    move(tool, ctx, { x: 140, y: 150 });
    click(tool, ctx, { x: 140, y: 150 });

    expect(doc.dimensions).toHaveLength(1);
    const dim = doc.dimensions[0];
    expect(dim.type).toBe("vertical");
    expect(dim.value).toBeCloseTo(40, 3); // |170 - 130|
    expect(dim.points[0]).toEqual({ entityId: line.id, key: "b" });
    expect(dim.points[1].entityId).toBe(STOCK_ENTITY_ID);
  });
});

