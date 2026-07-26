import { expect, test } from "@playwright/test";
import { StorageKeys } from "../src/core/storageKeys";

/**
 * The on-canvas rotary wrap hint (degree ruler, quarter-turn guides, seam edges),
 * driven in a real browser. The hint's geometry is unit-covered in
 * test/rotaryOverlay.test.ts; this guards the wiring — that a rotary document
 * actually paints it, and that View ▸ Rotary Wrap Hint turns it off.
 *
 * BASELINE-FREE on purpose: screenshot baselines are per-GPU/OS and a win32-only
 * one fails CI (see the preview specs). Instead we count pixels of the hint's own
 * colour in the live 2D canvas, which no other chrome uses.
 */

/** COLORS.rotaryWrap — #cf7fb8, the magenta reserved for the wrap hint. */
const WRAP_RGB = [0xcf, 0x7f, 0xb8];

/** How many canvas pixels are (near) the wrap-hint magenta. */
function wrapPixelCount(page: import("@playwright/test").Page) {
  return page.evaluate((rgb) => {
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (
        Math.abs(data[i] - rgb[0]) < 24 &&
        Math.abs(data[i + 1] - rgb[1]) < 24 &&
        Math.abs(data[i + 2] - rgb[2]) < 24
      )
        n++;
    }
    return n;
  }, WRAP_RGB);
}

test("rotary wrap hint: painted for a rotary doc, and togglable from the View menu", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  // Record a consent decision BEFORE the app boots, so the banner never renders.
  // It and the welcome screen are both TOP-LAYER elements, so whichever paints
  // above swallows clicks meant for the other — and which one that is shifts
  // with the viewport and with how tall the dialog renders (CI's font metrics
  // made the New Project dialog tall enough for the banner to eat its Create
  // button). Removing the banner outright makes these specs independent of that;
  // consent-clickthrough.e2e.ts is the spec that deliberately exercises it.
  await page.addInitScript((key) => localStorage.setItem(key, "denied"), StorageKeys.analyticsConsent);
  await page.goto("/");
  await expect
    .poll(() =>
      page.evaluate(() => "__app" in window && Boolean((window as { __app?: unknown }).__app)),
    )
    .toBe(true);

  // A plain mill project first: no rotary, so nothing of the hint may appear.
  await page.locator(".welcome-backdrop .welcome-card", { hasText: "New Project" }).click();
  const npd = page.locator("#npd-backdrop");
  await expect(npd).toBeVisible();
  await npd.getByRole("button", { name: "Create Project" }).click();
  await expect(npd).toHaveCount(0);
  expect(await wrapPixelCount(page)).toBe(0);

  // Switch the machine to the rotary: the ruler, guides and seams appear.
  await page.locator("#topbar").getByRole("button", { name: "Settings" }).click();
  const settings = page.locator(".post-settings-dialog");
  await expect(settings).toBeVisible();
  await settings
    .locator(".post-settings-field", { hasText: "Machine type" })
    .locator("select")
    .selectOption("mill-rotary");
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(settings).toHaveCount(0);

  await expect.poll(() => wrapPixelCount(page)).toBeGreaterThan(200);

  // View ▸ Rotary Wrap Hint (offered only for a rotary doc) turns it off …
  await page.getByRole("button", { name: "View" }).click();
  const item = page.locator(".fmenu-item", { hasText: "Rotary Wrap Hint" });
  await expect(item).toBeVisible();
  await item.click();
  await expect.poll(() => wrapPixelCount(page)).toBe(0);

  // … and back on.
  await page.getByRole("button", { name: "View" }).click();
  await page.locator(".fmenu-item", { hasText: "Rotary Wrap Hint" }).click();
  await expect.poll(() => wrapPixelCount(page)).toBeGreaterThan(200);
});
