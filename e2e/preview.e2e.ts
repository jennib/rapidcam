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
    __renderPreview?: (opts?: Record<string, unknown>) => boolean;
    /** Mean-free frame pixels (RGBA) captured on the last render, for pixel checks. */
    __px?: Uint8ClampedArray | null;
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

test("rotary 3D preview wraps the height map onto a cylinder", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto("/e2e/fixtures/preview-harness.html");

  await expect.poll(() => page.evaluate(() => window.__harnessReady === true)).toBe(true);

  // Render through the cylinder (rotary) path — catches a shader compile/link
  // failure in VERT_CYL/FRAG_CYL.
  const ok = await page.evaluate(() => window.__renderPreview?.({ rotary: true }) === true);
  const err = await page.evaluate(() => window.__err ?? "");
  expect(err, "cylinder shader must compile and link").toBe("");
  expect(ok, "rotary preview must render without throwing").toBe(true);
  await expect(page.locator("#preview-shot")).toBeVisible();

  // Mirror-orientation guard, baseline-free (so it needs no per-GPU/OS snapshot).
  // A shallow cut placed at HIGH v wraps — correctly — onto the visible top of the
  // cylinder. We render it, and a plain uncut cylinder, and count pixels that
  // differ: the cut is a big visible change (~5% of the frame). If the wrap
  // regresses to a mirror image (v not flipped), that cut lands on the hidden
  // underside and the two frames are nearly identical (<0.5%). Comparing two live
  // renders on the same GPU avoids any stored baseline. Threshold 2% sits well
  // between the measured correct (~5%) and mirrored (~0.4%) cases.
  const diffFrac = await page.evaluate(() => {
    const w = window;
    w.__renderPreview?.({ rotary: true, mark: true });
    const A = w.__px?.slice();
    w.__renderPreview?.({ rotary: true, noCuts: true });
    const B = w.__px;
    if (!A || !B) return -1;
    let diff = 0;
    for (let i = 0; i < A.length; i += 4) if (Math.abs(A[i] - B[i]) > 25) diff++;
    return diff / (A.length / 4);
  });
  expect(diffFrac, "a high-v cut must be visible on the cylinder top (not mirrored under)").toBeGreaterThan(0.02);

  // The swapped wrap axis (X wraps, Y = length) exercises the mirrored JS
  // branches (viewMetrics, caps, uniforms) and the uWrapX shader path.
  const okX = await page.evaluate(
    () => window.__renderPreview?.({ rotary: true, wrapAxis: "x" }) === true,
  );
  const errX = await page.evaluate(() => window.__err ?? "");
  expect(errX, "wrapAxis 'x' must render without error").toBe("");
  expect(okX).toBe(true);
});
