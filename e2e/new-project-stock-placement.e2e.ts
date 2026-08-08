/**
 * Where New Project puts the blank on the sheet: CENTRED, with even margin.
 *
 * The evenness is the requirement, not an aesthetic. A clamp can overhang any
 * edge of the blank, and hold-downs are drawn as geometry on a fixture layer —
 * so there has to be sheet outside the blank on every side to draw them on. Put
 * the blank in a corner and two of its edges have nowhere to draw a clamp.
 *
 * This spec exists because that placement has been changed and reverted once.
 * Moving the blank to (0, 0) makes drawing coordinates equal blank coordinates,
 * which sounds appealing and buys nothing: `resolveOrigin` already folds
 * stockRect.x/y into ox/oy, so G-code zero has always been on the blank. The
 * change cost the fixture room and was reverted. Nothing else pinned the
 * placement at the time — the specs that care about stock position all read
 * `stockRect` dynamically (`stockRect?.x ?? 0`), so they adapt to any default
 * and would not notice it moving again.
 */
import { expect, test, waitForApp } from "./appFixture";

/** The live document's stock rect and canvas, via the dev inspection hook. */
function stockAndCanvas(page: import("@playwright/test").Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __app: {
            doc: {
              stockRect: { x: number; y: number; width: number; height: number } | null;
              canvas: { width: number; height: number };
            };
          };
        }
      ).__app.doc,
  );
}

test("New Project centres the blank, leaving even margin on all four sides", async ({ page }) => {
  await page.goto("/");
  await waitForApp(page);

  const welcome = page.locator(".welcome-backdrop");
  await welcome.locator(".welcome-card", { hasText: "New Project" }).click();
  const npd = page.locator("#npd-backdrop");
  await expect(npd).toBeVisible();
  await npd.getByRole("button", { name: "Create Project" }).click();
  await expect(npd).toHaveCount(0);

  const doc = await stockAndCanvas(page);
  const s = doc.stockRect;
  expect(s, "a milling project must have a positioned blank").not.toBeNull();
  if (!s) return;

  // The sheet is grown past the blank — without this an "even margin" of zero
  // would satisfy every assertion below.
  expect(doc.canvas.width).toBeGreaterThan(s.width);
  expect(doc.canvas.height).toBeGreaterThan(s.height);

  // Margin is equal on opposing sides, and therefore non-zero on all four.
  const left = s.x;
  const right = doc.canvas.width - (s.x + s.width);
  const bottom = s.y;
  const top = doc.canvas.height - (s.y + s.height);

  expect(left).toBeCloseTo(right, 6);
  expect(bottom).toBeCloseTo(top, 6);
  for (const [name, m] of [
    ["left", left],
    ["right", right],
    ["bottom", bottom],
    ["top", top],
  ] as const) {
    expect(m, `no room to draw a clamp overhanging the ${name} edge`).toBeGreaterThan(0);
  }
});
