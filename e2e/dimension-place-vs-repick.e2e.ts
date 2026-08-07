/**
 * Placing a linear dimension vs. re-targeting it onto a second edge.
 *
 * These two gestures shared one click, separated only by how close it landed to
 * some other edge. That is not separable by position: the pick tolerance is
 * 8px/scale, so at fit zoom it is tens of millimetres of world, and once the
 * stock's edges became pickable while it fills the sheet, that band runs around
 * the whole sheet boundary — exactly where a dimension gets placed. A plain
 * "click just outside the part" was swallowed as a re-pick and the dimension
 * silently measured the part-to-stock gap instead of the edge asked for.
 *
 * Unit tests cannot see this: they build a viewport with `toWorldLen: px => px`,
 * so the band is 8mm there and the zoom dependence disappears. Only the running
 * app has a real scale.
 */
import { test, expect, waitForApp, APP_URL } from "./appFixture";
import type { Page } from "@playwright/test";

async function newProject(page: Page): Promise<void> {
  const welcome = page.locator(".welcome-backdrop");
  await welcome.locator(".welcome-card", { hasText: "New Project" }).click();
  await page.locator("#npd-backdrop .tp-apply-btn").click();
  await expect(welcome).toHaveCount(0);
}

async function toPx(page: Page, mm: [number, number]): Promise<{ x: number; y: number }> {
  return page.evaluate(([x, y]) => {
    const app = (
      window as unknown as {
        __app: {
          view: { worldToScreen(p: { x: number; y: number }): { x: number; y: number } };
          canvas: HTMLElement;
        };
      }
    ).__app;
    const p = app.view.worldToScreen({ x, y });
    const r = app.canvas.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, mm);
}

const dimCount = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __app: { doc: { dimensions: unknown[] } } }).__app.doc.dimensions.length,
  );

const dimValues = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __app: { doc: { dimensions: { value: number }[] } } }
    ).__app.doc.dimensions.map((d) => d.value),
  );

/** The stock rect the app is actually using, and the live pick band in mm. */
async function stockAndBand(page: Page) {
  return page.evaluate(() => {
    const app = (
      window as unknown as {
        __app: {
          view: { scale: number };
          doc: {
            stockRect: { x: number; y: number; width: number; height: number } | null;
            canvas: { width: number; height: number };
          };
        };
      }
    ).__app;
    return {
      scale: app.view.scale,
      bandMM: 8 / app.view.scale,
      stockRect: app.doc.stockRect,
      canvas: app.doc.canvas,
    };
  });
}

test("a plain click places the dimension even inside the stock edge's pick band", async ({
  page,
}) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);

  const { bandMM, stockRect } = await stockAndBand(page);
  // The band must actually be wide enough for this test to mean anything —
  // otherwise the placement click below is trivially outside it.
  expect(bandMM, "pick band should be several mm of world at fit zoom").toBeGreaterThan(2);

  // Draw a rectangle well inside the stock.
  const x0 = (stockRect?.x ?? 0) + 40;
  const y0 = (stockRect?.y ?? 0) + 40;
  await page.locator('button.tool-btn[data-tip^="Rectangle"]').click();
  const a = await toPx(page, [x0, y0]);
  const b = await toPx(page, [x0 + 60, y0 + 40]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();

  await page.locator('button.tool-btn[data-tip^="Dimension"]').click();

  // Click the rectangle's bottom edge, deliberately OFF its midpoint (x0+30):
  // the midpoint is a pickable DOF hotspot, and hitting it takes the
  // discrete-point path instead of the "click an edge directly" shortcut this
  // test is about.
  const edge = await toPx(page, [x0 + 18, y0]);
  await page.mouse.click(edge.x, edge.y);

  // Now place it just below the stock's bottom edge — INSIDE the pick band.
  const stockBottom = stockRect?.y ?? 0;
  const place = await toPx(page, [x0 + 18, stockBottom + bandMM * 0.4]);
  await page.mouse.move(place.x, place.y);
  await page.mouse.click(place.x, place.y);

  expect(await dimCount(page), "the placement click must commit, not re-target").toBe(1);
  // 60 = the rectangle's width, the edge that was clicked. Anything else means
  // the click was re-interpreted as measuring to the stock.
  const [v] = await dimValues(page);
  expect(v, "should measure the clicked edge, not the part-to-stock gap").toBeCloseTo(60, 0);
});

test("Shift-click still re-targets onto a second edge", async ({ page }) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);

  const { stockRect } = await stockAndBand(page);
  const x0 = (stockRect?.x ?? 0) + 40;
  const y0 = (stockRect?.y ?? 0) + 40;

  await page.locator('button.tool-btn[data-tip^="Rectangle"]').click();
  const a = await toPx(page, [x0, y0]);
  const b = await toPx(page, [x0 + 60, y0 + 40]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();

  await page.locator('button.tool-btn[data-tip^="Dimension"]').click();

  // Click the rectangle's bottom edge, off its midpoint (see the note above).
  const edge = await toPx(page, [x0 + 18, y0]);
  await page.mouse.click(edge.x, edge.y);

  // ...then Shift-click the stock's bottom edge to measure to it instead.
  const stockBottom = stockRect?.y ?? 0;
  const target = await toPx(page, [x0 + 18, stockBottom]);
  await page.keyboard.down("Shift");
  await page.mouse.move(target.x, target.y);
  await page.mouse.click(target.x, target.y);
  await page.keyboard.up("Shift");

  // Then a plain click to place it.
  const place = await toPx(page, [x0 + 18, y0 - 20]);
  await page.mouse.move(place.x, place.y);
  await page.mouse.click(place.x, place.y);

  expect(await dimCount(page)).toBe(1);
  const [v] = await dimValues(page);
  // 40 = the gap from the rectangle's bottom edge down to the stock's bottom.
  expect(v, "Shift-click should have re-targeted onto the stock edge").toBeCloseTo(40, 0);
});
