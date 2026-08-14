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
 * The unit specs pin the corner ORDER (highest index first, because each fillet
 * shifts every index above it). They cannot show that the real gesture reaches
 * that code, or that the four splices compose — walking the wrong way would
 * still produce a polyline, just one with arcs cut into arcs.
 *
 * A 90 degree corner tessellates at ~2 degrees per step, so each rounded corner
 * contributes ~46 vertices. One corner would leave ~49; four leave ~187. The
 * count is therefore the cheapest honest discriminator between "it rounded one"
 * and "it rounded all four".
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
    return { type: e.type, n: e.points ? e.points.length : 4 };
  });
  console.log("RESULT:", JSON.stringify(out));
  expect(out.type).toBe("polyline");
  // Four arcs, not one: a single rounded corner would land near 49.
  expect(out.n).toBeGreaterThan(150);
});
