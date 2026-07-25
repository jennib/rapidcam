import { expect, test } from "@playwright/test";

/**
 * Export preview dialog: it must draw a real backplot of the posted program and
 * resolve Export/Cancel correctly. The parser is unit-tested (gcodePath.test.ts);
 * this covers the browser-only parts — the canvas actually renders the cut path,
 * the run-time shows, findings render, and the buttons resolve the promise.
 */
declare global {
  interface Window {
    __harnessReady?: boolean;
    __openPreview?: (opts: Record<string, unknown>) => boolean;
    __cutPixels?: () => number;
    __result?: boolean;
  }
}

// A 40×30 rectangle cut: rapid to start, four G1 sides.
const RECT_GCODE = [
  "G21", "G90",
  "G0 X0 Y0",
  "G1 X40 Y0 F600", "G1 X40 Y30", "G1 X0 Y30", "G1 X0 Y0",
  "M30",
].join("\n");

test("draws a backplot, shows run time, and Export resolves true", async ({ page }) => {
  await page.goto("/e2e/fixtures/export-preview-harness.html");
  await expect.poll(() => page.evaluate(() => window.__harnessReady === true)).toBe(true);

  await page.evaluate(
    (g) =>
      window.__openPreview!({
        gcode: g,
        filename: "part.nc",
        opCount: 1,
        stockLabel: "40 × 30mm",
        findings: [],
      }),
    RECT_GCODE,
  );

  await expect(page.locator(".tp-dialog h3")).toHaveText("Export preview");
  await expect(page.locator(".tp-dialog")).toContainText("⏱"); // run-time line
  await expect(page.locator(".tp-dialog")).toContainText("part.nc");

  // The backplot actually drew the cut path (many cut-coloured pixels). Poll so we
  // don't read before the requestAnimationFrame draw fires.
  await expect.poll(() => page.evaluate(() => window.__cutPixels!()), { timeout: 3000 }).toBeGreaterThan(50);

  // Clean job → primary button is "Export" and resolves true.
  const btn = page.locator(".tp-dialog-footer button", { hasText: /^Export$/ });
  await expect(btn).toBeVisible();
  await btn.click();
  await expect.poll(() => page.evaluate(() => window.__result)).toBe(true);
});

test("Cancel resolves false; errors show findings and an 'Export anyway' button", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/export-preview-harness.html");
  await expect.poll(() => page.evaluate(() => window.__harnessReady === true)).toBe(true);

  await page.evaluate(
    (g) =>
      window.__openPreview!({
        gcode: g,
        filename: "part.nc",
        opCount: 2,
        stockLabel: "40 × 30mm",
        findings: [
          { code: "cut-through", severity: "error", message: "A cut reaches below the stock." },
          { code: "small-tool", severity: "warning", message: "Tool is large for a slot." },
        ],
      }),
    RECT_GCODE,
  );

  await expect(page.locator(".tp-dialog")).toContainText("A cut reaches below the stock.");
  await expect(page.locator(".tp-dialog")).toContainText("1 error");
  const anyway = page.locator(".tp-dialog-footer button", { hasText: "Export anyway" });
  await expect(anyway).toBeVisible();

  await page.locator(".tp-dialog-footer button", { hasText: "Cancel" }).click();
  await expect.poll(() => page.evaluate(() => window.__result)).toBe(false);
});
