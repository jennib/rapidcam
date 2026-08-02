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
 * (caught via imageDimensionOrphan.test.ts going from 1 dimension to 0). That
 * regressed the "pick a real entity FIRST, then the stock edge SECOND" gesture
 * entirely (reported: starting from a line, clicking the stock edge just kept
 * defining the line's own length). The actual fix: pickStockEdge only matches
 * when `doc.stockRect` is explicitly set — the legacy "stock fills the canvas"
 * case draws no distinct stock rectangle at all (see renderer.ts), so there is
 * no visible line for a click near the canvas edge to have meant, and it's
 * exactly that case the regression test exercises. With a real, visibly-drawn
 * stock rect there's an actual edge to redirect onto.
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
    move(tool, ctx, { x: 50, y: 90 }); // the stock's left edge, off any hotspot
    click(tool, ctx, { x: 50, y: 90 });
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
    move(tool, ctx, { x: 50, y: 90 });
    click(tool, ctx, { x: 50, y: 90 });
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
