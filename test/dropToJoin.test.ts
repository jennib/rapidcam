import { expect, test, vi } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity, PolylineEntity } from "../src/model/entities";
import { SnapEngine } from "../src/input/snapping";
import { SelectTool } from "../src/tools/selectTool";
import type { ToolContext, ToolPointerEvent } from "../src/tools/tool";
import { Viewport } from "../src/view/viewport";
import { makeConstraint } from "../src/model/constraints";

/**
 * Dropping an endpoint onto another JOINS them.
 *
 * Dragging a point already landed it on the snapped coordinates, so the two
 * looked joined — but nothing held them there, and the next solve or drag pulled
 * them apart. That is what "points close together don't merge" meant.
 *
 * The refusals matter as much as the join: a constraint that is already implied
 * would only clutter the constraint list, and one that over-constrains must be
 * refused OUT LOUD, because a silent refusal reads as "the app ignored me".
 */

function ctxFor(doc: CADDocument) {
  const notify = vi.fn();
  const ctx: ToolContext = {
    doc,
    view: new Viewport(),
    requestRender() {},
    solve() {},
    pushHistory() {},
    openDimEditor() {},
    // Must be > 0: SelectTool refuses to start a point drag on a fully
    // constrained sketch ("edit a dimension or remove a constraint to move this").
    currentDof: () => 8,
    openTypeToDraw() {},
    activateTool() {},
    closeTypeToDraw() {},
    notify,
    setHint() {},
    snap: new SnapEngine(),
  };
  return { ctx, notify };
}

function evt(
  pos: { x: number; y: number },
  snap: ToolPointerEvent["snap"],
  view: Viewport,
): ToolPointerEvent {
  return {
    world: pos,
    worldRaw: pos,
    // Screen must come from the viewport: the point hit-test measures in SCREEN
    // pixels, so passing world coords through means nothing is ever within 10px
    // and the drag never becomes a dragPoint.
    screen: view.worldToScreen(pos),
    snap,
    button: 0,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
  };
}

/**
 * A polyline whose MIDDLE vertex is dragged onto a line endpoint.
 *
 * Deliberately not two lines. A single selected line puts both its endpoints
 * exactly on transform-box corner handles, and onPointerDown tests handles
 * first — so pressing a line endpoint starts a SCALE drag and never reaches the
 * point drag. That is a real pre-existing bug (see the issues list); using a
 * mid-vertex, which no handle sits on, tests the join itself rather than that.
 */
function polyAndLine() {
  const doc = new CADDocument({ width: 200, height: 200 }, "mm");
  const poly = doc.add(
    new PolylineEntity([{ x: 0, y: 0 }, { x: 15, y: 5 }, { x: 40, y: 10 }], false),
  ) as PolylineEntity;
  const l2 = doc.add(new LineEntity({ x: 60, y: 20 }, { x: 100, y: 20 })) as LineEntity;
  const midKey = `v${poly.vertexIds[1]}`;
  return { doc, poly, l2, midKey, midPos: { x: 15, y: 5 } };
}

/** Drive a point drag from press to release, ending on `snap`. */
function dragPointOnto(
  tool: SelectTool,
  ctx: ToolContext,
  from: { x: number; y: number },
  to: { x: number; y: number },
  snap: ToolPointerEvent["snap"],
) {
  const view = ctx.view as Viewport;
  tool.onPointerDown(evt(from, null, view), ctx);
  // Past DRAG_THRESHOLD_PX so `maybeDragPoint` becomes `dragPoint`.
  tool.onPointerMove(evt({ x: from.x + 20, y: from.y + 20 }, null, view), ctx);
  tool.onPointerMove(evt(to, snap, view), ctx);
  tool.onPointerUp(evt(to, snap, view), ctx);
}

function midKeyOf(p: PolylineEntity): string {
  return `v${p.vertexIds[1]}`;
}

function coincidents(doc: CADDocument) {
  return doc.constraints.filter((c) => c.type === "coincident");
}

test("dropping an endpoint on another adds a coincident constraint", () => {
  const { doc, poly, l2, midPos } = polyAndLine();
  const { ctx, notify } = ctxFor(doc);
  poly.selected = true;
  const tool = new SelectTool();

  dragPointOnto(tool, ctx, midPos, { x: 60, y: 20 }, {
    pos: { x: 60, y: 20 },
    kind: "endpoint",
    entityId: l2.id,
    key: "a",
  });

  expect(coincidents(doc)).toHaveLength(1);
  expect(notify).toHaveBeenCalledWith("Joined");
});

test("a join that is already implied is not added again", () => {
  const { doc, poly, l2, midPos } = polyAndLine();
  // Already constrained — dropping on it again must not stack a duplicate.
  doc.addConstraint(
    makeConstraint("coincident", {
      points: [
        { entityId: poly.id, key: midKeyOf(poly) },
        { entityId: l2.id, key: "a" },
      ],
    }),
  );
  const { ctx, notify } = ctxFor(doc);
  poly.selected = true;
  const tool = new SelectTool();

  dragPointOnto(tool, ctx, midPos, { x: 60, y: 20 }, {
    pos: { x: 60, y: 20 },
    kind: "endpoint",
    entityId: l2.id,
    key: "a",
  });

  expect(coincidents(doc)).toHaveLength(1);
  expect(notify).not.toHaveBeenCalledWith("Joined");
});

test("a point is never joined to its own entity", () => {
  const { doc, poly, midPos } = polyAndLine();
  const { ctx } = ctxFor(doc);
  poly.selected = true;
  const tool = new SelectTool();

  // Snap reports the line's OWN other end — coincident against itself is
  // degenerate, and it is usually just the drag's start point.
  dragPointOnto(tool, ctx, midPos, { x: 0, y: 0 }, {
    pos: { x: 0, y: 0 },
    kind: "endpoint",
    entityId: poly.id,
    key: midKeyOf(poly),
  });

  expect(coincidents(doc)).toHaveLength(0);
});

test("no snap under the drop means no join", () => {
  const { doc, poly, l2, midPos } = polyAndLine();
  const { ctx } = ctxFor(doc);
  poly.selected = true;
  const tool = new SelectTool();

  // What holding Ctrl produces: App.toolEvent hands the tool a null snap.
  dragPointOnto(tool, ctx, midPos, { x: 60, y: 20 }, null);
  expect(coincidents(doc)).toHaveLength(0);

  // Positive control: the identical drag WITH a snap does join, so the
  // assertion above is about the missing snap and not a dead code path.
  const t2 = new SelectTool();
  dragPointOnto(t2, ctx, midPos, { x: 60, y: 20 }, {
    pos: { x: 60, y: 20 },
    kind: "endpoint",
    entityId: l2.id,
    key: "a",
  });
  expect(coincidents(doc)).toHaveLength(1);
});
