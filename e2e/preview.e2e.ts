import { expect, test } from "@playwright/test";

/**
 * 3D-preview wall-quality regression guard.
 *
 * Renders the real WebGL height-map preview (src/cam/webglPreview.ts) against a
 * synthetic worst-case pocket whose vertical walls run diagonally to the raster
 * grid — the exact case that used to stair-step ("crenellate") into a bright
 * zipper. The scene is deterministic (fixed stock, camera, and canvas size), so
 * a shader/rasterizer regression that brings the crenellation back shows up as a
 * screenshot diff.
 *
 * The screenshot baseline is GPU-/OS-specific (Playwright suffixes it per
 * platform). Regenerate after an intentional look change, or on a new platform:
 *   npx playwright test preview.e2e.ts --update-snapshots
 */
declare global {
  interface Window {
    __harnessReady?: boolean;
    __err?: string;
    __renderPreview?: (opts?: Record<string, number>) => boolean;
  }
}

test("3D preview renders cut walls cleanly (no crenellation)", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto("/e2e/fixtures/preview-harness.html");

  await expect.poll(() => page.evaluate(() => window.__harnessReady === true)).toBe(true);

  // Render, and surface a shader compile/link failure as a clear error.
  const ok = await page.evaluate(() => window.__renderPreview?.() === true);
  const err = await page.evaluate(() => window.__err ?? "");
  expect(err, "WebGL shader must compile and link").toBe("");
  expect(ok, "preview must render without throwing").toBe(true);

  // The harness captures the WebGL frame into a static <img> (see harness for
  // why); compare that to the golden image.
  const shot = page.locator("#preview-shot");
  await expect(shot).toBeVisible();
  await expect(shot).toHaveScreenshot("preview-walls.png", {
    // The baseline is per-GPU/OS (Playwright suffixes it), and same-GPU renders
    // are deterministic run-to-run, so the tolerance can be tight — enough to
    // absorb only trivial jitter while a crenellation regression (a bright
    // zipper along every cut-wall edge) trips the diff.
    maxDiffPixelRatio: 0.004,
    animations: "disabled",
  });
});
