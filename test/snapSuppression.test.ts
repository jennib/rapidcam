import { expect, test } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { SnapEngine } from "../src/input/snapping";
import { Viewport } from "../src/view/viewport";

/**
 * Holding Ctrl suppresses snapping.
 *
 * SelectTool has honoured this while DRAGGING existing geometry for a while, and
 * the Object-snap tooltip promises it — but nothing honoured it while DRAWING,
 * so holding Ctrl on a rectangle's second corner did nothing and the point still
 * jumped to a snap. That was the reported bug (filed as "Alt doesn't disable
 * snapping"; Alt was never the key — it means "from centre" in rectTool).
 *
 * The suppression lives in `App.toolEvent`, the single place every tool gets its
 * snapped position, so it cannot be honoured by some tools and not others. That
 * is a DOM-bound method, so what is pinned here is the invariant it relies on:
 * the snap engine really would have moved the point, i.e. the fix is load-bearing
 * rather than suppressing something that was already a no-op.
 */

function docWithSnapTarget() {
  const doc = new CADDocument({ width: 200, height: 200 }, "mm");
  // An endpoint at exactly (50,50) for the cursor to be attracted to.
  doc.add(new LineEntity({ x: 50, y: 50 }, { x: 90, y: 50 }));
  return doc;
}

test("without Ctrl the engine pulls the cursor onto a nearby endpoint", () => {
  const doc = docWithSnapTarget();
  const view = new Viewport();
  const snap = new SnapEngine();

  // A few pixels off the endpoint — inside the 10px pickup radius.
  const screen = view.worldToScreen({ x: 50, y: 50 });
  const near = { x: screen.x + 3, y: screen.y + 3 };

  const r = snap.resolve(near, view, doc);
  expect(r.snap).not.toBeNull();
  expect(r.world.x).toBeCloseTo(50, 6);
  expect(r.world.y).toBeCloseTo(50, 6);
  // And the raw position is genuinely different — otherwise suppressing the
  // snap would change nothing and the test below would be vacuous.
  const raw = view.screenToWorld(near);
  expect(Math.hypot(raw.x - 50, raw.y - 50)).toBeGreaterThan(1e-6);
});

test("the raw position is what Ctrl hands the tool instead", () => {
  const view = new Viewport();
  const screen = view.worldToScreen({ x: 50, y: 50 });
  const near = { x: screen.x + 3, y: screen.y + 3 };

  // What App.toolEvent substitutes when ctrlKey is held: no engine call at all.
  const raw = view.screenToWorld(near);
  expect(raw.x).not.toBeCloseTo(50, 6);
});

test("object snap disabled is not the same lever as Ctrl", () => {
  // The status-bar toggle is persistent; Ctrl is momentary. Both must work, and
  // conflating them would make the toggle impossible to turn back on mid-drag.
  const doc = docWithSnapTarget();
  const view = new Viewport();
  const snap = new SnapEngine();
  const screen = view.worldToScreen({ x: 50, y: 50 });
  const near = { x: screen.x + 3, y: screen.y + 3 };

  snap.objectSnapEnabled = false;
  expect(snap.resolve(near, view, doc).snap).toBeNull();
  snap.objectSnapEnabled = true;
  expect(snap.resolve(near, view, doc).snap).not.toBeNull();
});
