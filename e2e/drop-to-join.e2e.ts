/* biome-ignore-all lint/suspicious/noExplicitAny: reads untyped app internals */
/**
 * Dropping one line end onto another really joins them.
 *
 * The unit specs in test/dropToJoin.test.ts feed a HAND-BUILT SnapPoint, so they
 * prove the join logic but not that the live snap engine ever hands the tool one
 * during a point drag. If it did not, the feature would be inert and every unit
 * test would still pass — the same shape as the design-tree regression this
 * branch shipped and CI caught.
 *
 * It also only reaches the point-drag path at all because DOF points now beat
 * transform handles: both of a selected line's endpoints sit exactly on the
 * bounding box's corner handles, so before that change this gesture was a scale
 * drag and no join was possible.
 */
import { test, expect, openDoc } from "./appFixture";
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { serializeDoc } from "../src/io/fileio";

/** Two lines whose ends are 20mm apart — drag one onto the other. */
function twoLines(): string {
  const doc = new CADDocument({ width: 200, height: 150 }, "mm");
  doc.add(new LineEntity({ x: 20, y: 20 }, { x: 60, y: 40 }));
  doc.add(new LineEntity({ x: 80, y: 60 }, { x: 140, y: 60 }));
  return JSON.stringify(serializeDoc(doc, "two-lines"));
}

test("dragging one line's end onto another's really creates a constraint", async ({ page }) => {
  await openDoc(page, twoLines());

  const toPx = (w: any) =>
    page.evaluate((p) => {
      const app = (window as any).__app;
      const s = app.view.worldToScreen(p);
      const r = document.querySelector("canvas")!.getBoundingClientRect();
      return { x: s.x + r.left, y: s.y + r.top };
    }, w);

  // Select the first line by clicking its middle.
  const mid = await toPx({ x: 40, y: 30 });
  await page.mouse.click(mid.x, mid.y);

  const before = await page.evaluate(() => (window as any).__app.doc.constraints.length);

  // Drag its `b` end (60,40) onto the second line's `a` end (80,60).
  const from = await toPx({ x: 60, y: 40 });
  const to = await toPx({ x: 80, y: 60 });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10);
    await page.waitForTimeout(12);
  }
  await page.mouse.up();

  const after = await page.evaluate(() => ({
    n: (window as any).__app.doc.constraints.length,
    types: (window as any).__app.doc.constraints.map((c: any) => c.type),
    l1: (window as any).__app.doc.entities.find((e: any) => e.type === "line"),
  }));

  console.log("constraints before:", before, "after:", after.n, JSON.stringify(after.types));
  console.log("dragged end landed at:", JSON.stringify(after.l1.b));
  expect(after.n).toBeGreaterThan(before);
  expect(after.types).toContain("coincident");
});
