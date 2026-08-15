/* biome-ignore-all lint/suspicious/noExplicitAny: reads untyped app internals */
import { test, expect, openDoc } from "./appFixture";
import { CADDocument } from "../src/model/document";
import { RectEntity } from "../src/model/entities";
import { serializeDoc } from "../src/io/fileio";

function oneRect(): string {
  const doc = new CADDocument({ width: 200, height: 150 }, "mm");
  doc.add(new RectEntity({ x: 40, y: 30 }, { x: 140, y: 100 }));
  return JSON.stringify(serializeDoc(doc, "rect"));
}

/**
 * Shift-drag rounds EVERY corner in one gesture.
 *
 * The unit specs pin the corner walk. They cannot show that the real gesture
 * reaches it — a drag that never commits, or a Shift read at press instead of
 * release, looks identical to them.
 *
 * The rectangle must still BE a rectangle afterwards, with four radii on it.
 * It used to come back as a ~187-vertex polyline, which is the "can't edit a
 * fillet" ticket: nothing about that shape could be adjusted again.
 */
test("Shift-drag rounds every corner of the rectangle", async ({ page }) => {
  await openDoc(page, oneRect());
  const toPx = (w: any) =>
    page.evaluate((p) => {
      const app = (window as any).__app;
      const s = app.view.worldToScreen(p);
      const r = document.querySelector("canvas")!.getBoundingClientRect();
      return { x: s.x + r.left, y: s.y + r.top };
    }, w);

  await page.evaluate(() => (window as any).__app.tools.activate("fillet"));

  const from = await toPx({ x: 40, y: 30 });   // bottom-left corner
  const to = await toPx({ x: 50, y: 40 });     // drag out ~14mm => radius
  await page.keyboard.down("Shift");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 6, from.y + ((to.y - from.y) * i) / 6);
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
  await page.keyboard.up("Shift");

  const out = await page.evaluate(() => {
    const doc = (window as any).__app.doc;
    const e = doc.entities.find((x: any) => x.type === "polyline" || x.type === "rectangle");
    return {
      type: e.type,
      radii: e.cornerRadii ?? null,
      cornerType: e.cornerType ?? null,
      // The boundary the renderer and every toolpath actually read.
      outline: e.outlinePoints ? e.outlinePoints().length : 4,
    };
  });
  console.log("RESULT:", JSON.stringify(out));
  expect(out.type).toBe("rectangle");
  expect(out.cornerType).toBe("round");
  // All four, not just the one under the cursor.
  expect(out.radii.filter((r: number) => r > 0)).toHaveLength(4);
  // And really rounded: four tessellated corners, not four corner points.
  expect(out.outline).toBeGreaterThan(4);
});
