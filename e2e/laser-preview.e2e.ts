import { expect, test } from "@playwright/test";

/**
 * Laser 3D-preview shading guard.
 *
 * A laser engrave is SCORCHED, not gouged — the surface fragment shader has a
 * dedicated `uLaserMode` branch (src/cam/webglPreview.ts) that colours removed
 * material as a scorch→char burn instead of the milled "fresh wood gets lighter"
 * ramp. This test drives that branch through the shared preview harness.
 *
 * Two guards, both baseline-free (no per-GPU/OS screenshot):
 *  1. The laser branch of the shader compiles + links and renders without error.
 *  2. The SAME shallow height field reads DARKER as a laser burn than as a mill
 *     cut — proving the burn shading is actually active (a shallow mill removal
 *     lightens toward fresh wood; a laser burn darkens toward char).
 */
declare global {
  interface Window {
    __harnessReady?: boolean;
    __err?: string;
    __renderPreview?: (opts?: Record<string, unknown>) => boolean;
    __px?: Uint8ClampedArray | null;
  }
}

/** Mean brightness (0..255) of the last captured frame, or -1 if unavailable. */
async function meanBrightness(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const px = window.__px;
    if (!px) return -1;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += (px[i] + px[i + 1] + px[i + 2]) / 3;
    return sum / (px.length / 4);
  });
}

test("laser 3D preview shades engraves as a burn (darker than a mill cut)", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto("/e2e/fixtures/preview-harness.html");
  await expect.poll(() => page.evaluate(() => window.__harnessReady === true)).toBe(true);

  // 1. The laser shader branch compiles + links and renders.
  const okLaser = await page.evaluate(() => window.__renderPreview?.({ laser: true }) === true);
  const errLaser = await page.evaluate(() => window.__err ?? "");
  expect(errLaser, "laser-mode shader must compile and link").toBe("");
  expect(okLaser, "laser preview must render without throwing").toBe(true);
  const laserBrightness = await meanBrightness(page);

  // 2. Same shallow field rendered as a mill cut — the brightness baseline.
  const okMill = await page.evaluate(() => window.__renderPreview?.({ shallow: true }) === true);
  expect(okMill, "mill baseline must render without throwing").toBe(true);
  const millBrightness = await meanBrightness(page);

  expect(laserBrightness).toBeGreaterThan(0);
  expect(millBrightness).toBeGreaterThan(0);
  // The burn must be visibly darker than the equivalent mill removal.
  expect(laserBrightness).toBeLessThan(millBrightness);
  expect(millBrightness - laserBrightness).toBeGreaterThan(3);
});

test("a ROTARY laser burns on the cylinder too, not just the flat board", async ({ page }) => {
  // The cylinder surface shader used to carry its own copy of the albedo ramp,
  // which silently kept only the milled-wood branch — so a laser rotary rendered
  // as a freshly machined dowel. Both shaders now share one `surfaceAlbedo`, and
  // the laser uniforms are uploaded for both programs. Same comparison as above,
  // through the wrapped path.
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto("/e2e/fixtures/preview-harness.html");
  await expect.poll(() => page.evaluate(() => window.__harnessReady === true)).toBe(true);

  const okLaser = await page.evaluate(
    () => window.__renderPreview?.({ laser: true, rotary: true }) === true,
  );
  expect(await page.evaluate(() => window.__err ?? ""), "cylinder laser shader must link").toBe("");
  expect(okLaser, "rotary laser preview must render without throwing").toBe(true);
  const laserBrightness = await meanBrightness(page);

  const okMill = await page.evaluate(
    () => window.__renderPreview?.({ shallow: true, rotary: true }) === true,
  );
  expect(okMill, "rotary mill baseline must render without throwing").toBe(true);
  const millBrightness = await meanBrightness(page);

  expect(laserBrightness).toBeGreaterThan(0); // guard: something actually rendered
  expect(millBrightness).toBeGreaterThan(0);
  expect(laserBrightness).toBeLessThan(millBrightness);
  expect(millBrightness - laserBrightness).toBeGreaterThan(3);
});
