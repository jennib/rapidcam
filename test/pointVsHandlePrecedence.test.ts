import { expect, test } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity, RectEntity } from "../src/model/entities";
import { SnapEngine } from "../src/input/snapping";
import { SelectTool, computeTransformBox } from "../src/tools/selectTool";
import type { ToolContext, ToolPointerEvent } from "../src/tools/tool";
import { Viewport } from "../src/view/viewport";

/**
 * A DOF point beats a transform handle when they coincide.
 *
 * They coincide constantly: the transform box's scale handles sit on the
 * selection's bounding-box corners, and for a single selected line the bbox
 * corners ARE its endpoints — 0.0px apart. Handles used to win, so pressing a
 * line endpoint started a SCALE drag and dragging that endpoint was impossible
 * unless something else was selected to push the bbox off it.
 *
 * Points win because this is a parametric constraint sketcher: AutoCAD grips and
 * Fusion/SolidWorks/Onshape sketch mode all drag the point and make scaling an
 * explicit command, which RapidCAM already has as ScaleTool.
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

function press(tool: SelectTool, ctx: ToolContext, world: { x: number; y: number }) {
  const e: ToolPointerEvent = {
    world,
    worldRaw: world,
    screen: (ctx.view as Viewport).worldToScreen(world),
    snap: null,
    button: 0,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
  };
  tool.onPointerDown(e, ctx);
  return (tool as unknown as { mode: string }).mode;
}

test("the conflict is real: a selected line's endpoint IS a scale handle", () => {
  const doc = new CADDocument({ width: 200, height: 200 }, "mm");
  const l = doc.add(new LineEntity({ x: 10, y: 10 }, { x: 50, y: 40 })) as LineEntity;
  l.selected = true;
  const view = new Viewport();
  const box = computeTransformBox(doc, view)!;
  const ep = view.worldToScreen(l.getPoint("b"));
  const nearest = Math.min(
    ...box.handles.map((h) => {
      const hs = view.worldToScreen(h.pos);
      return Math.hypot(ep.x - hs.x, ep.y - hs.y);
    }),
  );
  // If this ever stops being ~0 the precedence question has gone away.
  expect(nearest).toBeLessThan(0.001);
});

test("pressing a line endpoint drags the point, not the scale handle", () => {
  const doc = new CADDocument({ width: 200, height: 200 }, "mm");
  const l = doc.add(new LineEntity({ x: 10, y: 10 }, { x: 50, y: 40 })) as LineEntity;
  l.selected = true;
  expect(press(new SelectTool(), ctxFor(doc), { x: 50, y: 40 })).toBe("maybeDragPoint");
});

test("a rect corner drags the point too — that IS how a parametric rect resizes", () => {
  const doc = new CADDocument({ width: 200, height: 200 }, "mm");
  const r = doc.add(new RectEntity({ x: 10, y: 10 }, { x: 60, y: 40 })) as RectEntity;
  r.selected = true;
  // RectEntity exposes bl/tr, so those two corners become point drags.
  expect(press(new SelectTool(), ctxFor(doc), { x: 60, y: 40 })).toBe("maybeDragPoint");
});

test("a handle with no DOF point under it still scales", () => {
  const doc = new CADDocument({ width: 200, height: 200 }, "mm");
  const r = doc.add(new RectEntity({ x: 10, y: 10 }, { x: 60, y: 40 })) as RectEntity;
  r.selected = true;
  // `br` is a bbox corner but NOT one of RectEntity's dofPoints (bl/tr only),
  // so nothing shadows the handle there. This is the positive control: without
  // it, "point wins" could be hiding a transform box that never works at all.
  expect(press(new SelectTool(), ctxFor(doc), { x: 60, y: 10 })).toBe("dragScale");
});

test("the rotate handle sits off the box and is never shadowed", () => {
  const doc = new CADDocument({ width: 200, height: 200 }, "mm");
  const l = doc.add(new LineEntity({ x: 10, y: 10 }, { x: 50, y: 40 })) as LineEntity;
  l.selected = true;
  const view = new Viewport();
  const rot = computeTransformBox(doc, view)!.handles.find((h) => h.type === "rotate")!;
  expect(press(new SelectTool(), ctxFor(doc), rot.pos)).toBe("dragRotate");
});
