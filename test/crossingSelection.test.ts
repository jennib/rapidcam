import { expect, test } from "vitest";
import { CADDocument } from "../src/model/document";
import { CircleEntity, LineEntity } from "../src/model/entities";
import { SnapEngine } from "../src/input/snapping";
import { SelectTool } from "../src/tools/selectTool";
import type { ToolContext, ToolPointerEvent } from "../src/tools/tool";
import { Viewport } from "../src/view/viewport";

/**
 * A crossing marquee should select what it actually TOUCHES.
 *
 * Right-to-left = crossing, left-to-right = window: that part matches AutoCAD,
 * Fusion, SolidWorks and Onshape already. What did not match is the test used
 * for crossing — it compared bounding BOXES, so a marquee that never came near
 * a circle's curve still caught it by clipping the empty corner of its box. A
 * circle's bbox corner is 0.41r outside the curve, so the error is large and it
 * is worst for exactly the shapes people box-select around.
 *
 * Window selection is unaffected and stays a bbox test: if the box is contained
 * the geometry is contained, so it was already exact.
 */

function ctxFor(doc: CADDocument) {
  return {
    doc,
    view: new Viewport(),
    requestRender() {},
    solve() {},
    pushHistory() {},
    openDimEditor() {},
    currentDof: () => 8,
    openTypeToDraw() {},
    activateTool() {},
    closeTypeToDraw() {},
    notify() {},
    setHint() {},
    snap: new SnapEngine(),
  } as unknown as ToolContext;
}

function evt(pos: { x: number; y: number }, view: Viewport): ToolPointerEvent {
  return {
    world: pos,
    worldRaw: pos,
    screen: view.worldToScreen(pos),
    snap: null,
    button: 0,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
  };
}

/** Drag a marquee from `a` to `b` on empty space and return what got selected. */
function marquee(doc: CADDocument, a: { x: number; y: number }, b: { x: number; y: number }) {
  const ctx = ctxFor(doc);
  const view = ctx.view as Viewport;
  const tool = new SelectTool();
  tool.onPointerDown(evt(a, view), ctx);
  tool.onPointerMove(evt({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view), ctx);
  tool.onPointerMove(evt(b, view), ctx);
  tool.onPointerUp(evt(b, view), ctx);
  return doc.entities.filter((e) => e.selected).map((e) => e.id);
}

test("a crossing marquee that only clips a circle's bbox corner does NOT select it", () => {
  const doc = new CADDocument({ width: 300, height: 200 }, "mm");
  // Circle centred (100,100) r=40 — bbox corner at (140,140), curve nowhere near it.
  const c = doc.add(new CircleEntity({ x: 100, y: 100 }, 40)) as CircleEntity;

  // A small box in the bbox's empty top-right corner. Right-to-left = crossing.
  const hit = marquee(doc, { x: 145, y: 145 }, { x: 136, y: 136 });

  expect(hit, "the marquee never touched the curve").not.toContain(c.id);
});

test("but a crossing marquee that really crosses the curve does select it", () => {
  const doc = new CADDocument({ width: 300, height: 200 }, "mm");
  const c = doc.add(new CircleEntity({ x: 100, y: 100 }, 40)) as CircleEntity;

  // Straddles the curve on the +x side (the curve passes through x=140, y=100).
  const hit = marquee(doc, { x: 150, y: 105 }, { x: 130, y: 95 });

  expect(hit, "this one genuinely crosses the circle").toContain(c.id);
});

test("a diagonal line is not caught by a box in the empty corner of its bounds", () => {
  const doc = new CADDocument({ width: 300, height: 200 }, "mm");
  const l = doc.add(new LineEntity({ x: 20, y: 20 }, { x: 120, y: 120 })) as LineEntity;

  // Well away from the line itself, but inside its bounding box.
  const hit = marquee(doc, { x: 115, y: 35 }, { x: 100, y: 25 });

  expect(hit).not.toContain(l.id);
});

test("window selection is unchanged — full containment still selects", () => {
  const doc = new CADDocument({ width: 300, height: 200 }, "mm");
  const c = doc.add(new CircleEntity({ x: 100, y: 100 }, 40)) as CircleEntity;

  // Left-to-right, enclosing the whole circle.
  expect(marquee(doc, { x: 40, y: 40 }, { x: 170, y: 170 })).toContain(c.id);

  // Positive control on the other side of the same rule: a window that does NOT
  // enclose it must not select it, so the assertion above is about containment
  // and not about the marquee selecting everything.
  const doc2 = new CADDocument({ width: 300, height: 200 }, "mm");
  const c2 = doc2.add(new CircleEntity({ x: 100, y: 100 }, 40)) as CircleEntity;
  expect(marquee(doc2, { x: 40, y: 40 }, { x: 110, y: 110 })).not.toContain(c2.id);
});

test("a crossing marquee that swallows a shape whole still selects it", () => {
  const doc = new CADDocument({ width: 300, height: 200 }, "mm");
  const c = doc.add(new CircleEntity({ x: 100, y: 100 }, 8)) as CircleEntity;

  // Right-to-left (crossing), but the box contains the circle entirely — so NO
  // border sample touches the curve. Without the containment shortcut this
  // misses a shape the user dragged straight over, which is the obvious
  // simplification to make when reading the sampling loop.
  expect(marquee(doc, { x: 160, y: 160 }, { x: 40, y: 40 })).toContain(c.id);
});
