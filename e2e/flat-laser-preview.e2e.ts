import { expect, test } from "@playwright/test";

/**
 * Flat laser-preview density-aware shading guard (the real, pixel-level proof that
 * a browser can shade a dithered engrave by dot DENSITY instead of smearing).
 *
 * The 2-D preview strokes each raster scan-row at its true physical height. At a
 * zoomed-out scale the 0.1 mm dots fall well under one screen pixel, so a fixed
 * line width used to fatten a ~50%-density dither pattern into a solid red block
 * (indistinguishable from a full-black engrave). With true-size strokes the canvas
 * coverage anti-aliasing averages the tiling, non-overlapping runs into a per-pixel
 * fill = local density, so a mid-grey reads as mid-tone.
 *
 * Baseline-free: we compare the SAME scene at three tones and assert the mid-grey
 * dither darkens the background about half as much as a solid full burn — i.e. it
 * did NOT saturate. (A regression to fixed-width strokes makes mid ≈ solid.)
 */
declare global {
  interface Window {
    __harnessReady?: boolean;
    __err?: string;
    __renderFlatLaser?: (opts?: Record<string, unknown>) => boolean;
    __meanBrightness?: number;
  }
}

async function render(
  page: import("@playwright/test").Page,
  opts: Record<string, unknown>,
): Promise<number> {
  const ok = await page.evaluate((o) => window.__renderFlatLaser?.(o) === true, opts);
  const err = await page.evaluate(() => window.__err ?? "");
  expect(err, "flat laser preview must render without throwing").toBe("");
  expect(ok, "render must return true").toBe(true);
  return page.evaluate(() => window.__meanBrightness ?? -1);
}

test("dithered mid-grey shades to mid-tone, not a saturated solid burn", async ({ page }) => {
  await page.setViewportSize({ width: 500, height: 400 });
  await page.goto("/e2e/fixtures/flat-laser-harness.html");
  await expect.poll(() => page.evaluate(() => window.__harnessReady === true)).toBe(true);

  // scale 3 px/mm ⇒ a 0.1 mm dot is 0.3 px (sub-pixel) — the regime that used to smear.
  const scale = 3;
  const base = await render(page, { baseline: true, scale }); // background, no burn
  const midDither = await render(page, { tone: 128, dither: "floyd-steinberg", scale }); // ~50% dots
  const solid = await render(page, { tone: 0, dither: "none", scale }); // full black burn

  // Every burn darkens the background, and the solid burn is the darkest.
  expect(base).toBeGreaterThan(0);
  expect(midDither).toBeLessThan(base);
  expect(solid).toBeLessThan(midDither);

  // The crux: the mid-grey dither darkens roughly HALF as much as the solid burn.
  // A fixed-width regression would push mid ≈ solid (ratio → 1); true density gives ~0.5.
  const ratio = (base - midDither) / (base - solid);
  expect(ratio).toBeGreaterThan(0.25);
  expect(ratio).toBeLessThan(0.75);
});
