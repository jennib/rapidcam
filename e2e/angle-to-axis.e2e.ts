/**
 * Placing a VISIBLE angle-from-horizontal dimension with the dimension tool.
 *
 * The X axis is not selectable geometry — it is named by the dimension type —
 * so there is no second thing to click. The gesture is: pick a line, then click
 * OPEN SPACE, which previously did nothing in that phase. The status-bar hint
 * advertises it, since a gesture nobody can discover is not a feature.
 */
import { expect, openDoc, test } from "./appFixture";
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { serializeDoc } from "../src/io/fileio";
import type { Page } from "@playwright/test";

function doc(): string {
  const d = new CADDocument({ width: 200, height: 150 }, "mm");
  d.add(new LineEntity({ x: 20, y: 20 }, { x: 80, y: 80 })); // 45°
  // A separate pair, well clear of the first dimension's arc, for the
  // does-the-flag-reset half of the test.
  d.add(new LineEntity({ x: 120, y: 100 }, { x: 190, y: 100 }));
  d.add(new LineEntity({ x: 120, y: 100 }, { x: 120, y: 145 }));
  return JSON.stringify(serializeDoc(d, "angle-axis"));
}

async function toPx(page: Page, mm: [number, number]) {
  return page.evaluate(([x, y]) => {
    const app = (window as any).__app;
    const p = app.view.worldToScreen({ x, y });
    const r = app.canvas.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, mm);
}
const click = async (page: Page, mm: [number, number]) => {
  const p = await toPx(page, mm);
  await page.mouse.click(p.x, p.y);
};
const dims = (page: Page) =>
  page.evaluate(() => (window as any).__app.doc.dimensions.map((d: any) => ({ t: d.type, v: d.value })));

test("live: pick a line then open space to dimension its angle from horizontal", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openDoc(page, doc());
  await page.locator('button.tool-btn[data-tip^="Dimension"]').click();

  await click(page, [50, 50]); // midpoint of the 45° line
  await expect(page.locator("#statusbar")).toContainText(/angle from horizontal/i);

  await click(page, [95, 20]); // open space → the axis
  await click(page, [80, 35]); // place it

  const placed = await dims(page);
  expect(placed).toHaveLength(1);
  expect(placed[0].t).toBe("angle-x");
  expect(placed[0].v).toBeCloseTo(45, 1); // degrees

  // The flag must not stick: a second run of the same gesture, on a different
  // line, must produce that line's angle rather than repeating the first.
  await click(page, [155, 100]); // midpoint of the horizontal line
  await click(page, [170, 135]); // open space → the axis again
  await click(page, [175, 125]); // place

  const after = await dims(page);
  expect(after).toHaveLength(2);
  expect(after[1].t).toBe("angle-x");
  expect(after[1].v, "measures ITS line, not the first one").toBeCloseTo(0, 1);
});
