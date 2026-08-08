/**
 * Where New Project puts the blank on the sheet.
 *
 * The blank sits AT the sheet origin, so drawing coordinates and blank
 * coordinates agree — a feature placed at (10, 10) is 10mm in from the corner of
 * the material. It used to be centred on the margin-padded sheet, which put the
 * default blank at (50, 50).
 *
 * This is worth a guard because nothing else pins it: the specs that care about
 * stock position all read `stockRect` dynamically (`stockRect?.x ?? 0`), so they
 * adapt to any default and would not notice it moving. It is also a value other
 * code is easy to hardcode against — `test/lint.test.ts` and
 * `test/stockRefDimension.test.ts` both build a `{x:50, y:50}` rect by hand, and
 * their comments describe it as "the New Project default". They construct their
 * own documents so they stay correct as tests of a POSITIONED rect, but the
 * prose is now historical.
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

test("New Project puts the blank at the sheet origin", async ({ page }) => {
  await page.goto("/");
  await waitForApp(page);

  const welcome = page.locator(".welcome-backdrop");
  await welcome.locator(".welcome-card", { hasText: "New Project" }).click();
  const npd = page.locator("#npd-backdrop");
  await expect(npd).toBeVisible();
  await npd.getByRole("button", { name: "Create Project" }).click();
  await expect(npd).toHaveCount(0);

  const doc = await stockAndCanvas(page);

  expect(doc.stockRect, "a milling project must have a positioned blank").not.toBeNull();
  expect(doc.stockRect?.x).toBe(0);
  expect(doc.stockRect?.y).toBe(0);

  // Positive control: the sheet is still GROWN past the blank. Asserting only
  // that the offset is 0 would also pass if the sheet had collapsed onto the
  // blank, which would leave nowhere to draw hold-downs.
  expect(doc.canvas.width).toBeGreaterThan(doc.stockRect?.width ?? 0);
  expect(doc.canvas.height).toBeGreaterThan(doc.stockRect?.height ?? 0);
});
