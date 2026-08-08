import { expect, test, waitForApp } from "./appFixture";

/**
 * New Project's "Stock" size really is the STOCK, and the sheet is derived from
 * it. Unit tests cover deriveSheet itself; what only exists here is the wiring —
 * that the dialog's fields reach doc.stockRect rather than doc.canvas (they used
 * to land on the canvas, which was self-consistent under the old model and wrong
 * under this one).
 *
 * Note the explicit `change` dispatch after each fill: Playwright's fill() does
 * not blur, and the dialog commits on change. A real user gets that for free by
 * clicking away or pressing Create.
 */

const state = (p: import("@playwright/test").Page) =>
  p.evaluate(() => {
    const d = (window as any).__app.doc;
    return { canvas: d.canvas, stockRect: d.stockRect };
  });

async function create(page: import("@playwright/test").Page, w: string, h: string) {
  const npd = page.locator("#npd-backdrop");
  await expect(npd).toBeVisible();
  // By LABEL, not by text proximity. The previous form — the input inside the
  // `.tp-field` containing the text "Width" — resolved to the wrong field in
  // about one run in three, typing the stock width into the Project name box.
  // The document then correctly built a 200×200 stock from the defaults it was
  // actually given, and this spec reported it as a size bug. See the label/id
  // binding in newProjectDialog.ts `row()`.
  const field = (label: string) => npd.getByLabel(label, { exact: true });
  await field("Width").fill(w);
  await field("Width").dispatchEvent("change");
  await field("Height").fill(h);
  await field("Height").dispatchEvent("change");
  await npd.getByRole("button", { name: "Create Project" }).click();
  await expect(npd).toHaveCount(0);
}

test("New Project: typed size is the STOCK, sheet is derived", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.addInitScript(() => localStorage.removeItem("rapidcam:machine:bed"));
  await page.goto("/");
  await waitForApp(page);
  await page.locator(".welcome-backdrop .welcome-card", { hasText: "New Project" }).click();
  await create(page, "300", "200");
  const s1 = await state(page);
  // Stock is exactly what was typed; the sheet grew to leave room for clamps.
  // The blank sits AT the origin so drawing coords and blank coords agree — the
  // margin is therefore all above and to the right, not split around it.
  expect(s1.stockRect).toEqual({ x: 0, y: 0, width: 300, height: 200 });
  expect(s1.canvas).toEqual({ width: 400, height: 300 });
});

test("New Project with a bed: the sheet IS the bed", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.addInitScript(() => localStorage.setItem("rapidcam:machine:bed", "800x400"));
  await page.goto("/");
  await waitForApp(page);
  await page.locator(".welcome-backdrop .welcome-card", { hasText: "New Project" }).click();
  await create(page, "300", "200");
  const s2 = await state(page);
  // The sheet IS the bed, and the blank sits at its origin — the same rule as
  // the no-bed case, so "where is my material" has one answer on both paths.
  // NB this is the bed's near-left corner, not its middle; a blank that really
  // sits mid-table has to be placed by hand (or dragged) to say so.
  expect(s2.canvas).toEqual({ width: 800, height: 400 });
  expect(s2.stockRect).toEqual({ x: 0, y: 0, width: 300, height: 200 });
});
