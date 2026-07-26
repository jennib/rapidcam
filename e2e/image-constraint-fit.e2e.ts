import { expect, test } from "@playwright/test";
import { StorageKeys } from "../src/core/storageKeys";

/**
 * Calibrating a placed image through the constraint engine, driven in a real
 * browser: the Properties "Constraints may" checkboxes write the image's
 * permissions, and a driving dimension across the image then scales it.
 *
 * Worth doing live even though test/imageResizeConstraints.test.ts covers the
 * engine, because the solver decides an image's freedom with `instanceof
 * RasterImageEntity` — it only behaves if the entity really is the class the
 * app's own modules closed over.
 *
 * Which is exactly why the geometry is injected through `doc.restore()` rather
 * than by constructing entities from a dynamic `import()`. Vite serves an
 * HMR-invalidated module under a versioned URL, so a second import can hand back
 * a DIFFERENT class object than the running app holds; entities built from it
 * fail every `instanceof` and silently vanish from the Properties panel and the
 * toolpaths. `restore` builds them with the app's own constructors from plain
 * JSON, so what this test drives is unambiguously what a user would have.
 */

/* biome-ignore-all lint/suspicious/noExplicitAny: page-context handles are untyped. */

/** A snapshot entity for an 80×40 image, selected, with no pixels registered. */
const IMAGE_SNAP = {
  type: "image",
  id: "img-live",
  imageId: "img-none",
  position: { x: 20, y: 20 },
  widthMM: 80,
  heightMM: 40,
  angle: 0,
  flipX: false,
  flipY: false,
  aspectLocked: true,
  selected: true,
  isConstruction: false,
  layerId: "layer-0",
};

test("image: allowing resize + a driving dimension calibrates the image", async ({ page }) => {
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
  await page.locator(".welcome-backdrop .welcome-card", { hasText: "New Project" }).click();
  const npd = page.locator("#npd-backdrop");
  await expect(npd).toBeVisible();
  await npd.getByRole("button", { name: "Create Project" }).click();
  await expect(npd).toHaveCount(0);

  // Place the image and select it, via the app's own entity constructors.
  await page.evaluate((snap) => {
    const app = (window as any).__app;
    const doc = app.doc.snapshot();
    doc.entities.push(snap);
    app.doc.restore(doc);
    app.doc.emitChange();
  }, IMAGE_SNAP);
  expect(
    await page.evaluate(() => (window as any).__app.doc.selected.map((e: any) => e.type)),
  ).toEqual(["image"]);

  const fitRow = page.locator(".props-row", { hasText: "Constraints may" });
  await expect(fitRow).toBeVisible();
  await expect(fitRow.locator("label")).toHaveText(["resize", "rotate"]);
  const resize = fitRow.locator("label", { hasText: "resize" }).locator("input");
  const rotate = fitRow.locator("label", { hasText: "rotate" }).locator("input");
  await expect(resize).not.toBeChecked(); // images stay rigid until asked
  await expect(rotate).not.toBeChecked();

  await resize.check();
  expect(
    await page.evaluate(() => {
      const img = (window as any).__app.doc.entities.find((e: any) => e.type === "image");
      return [img.constraintResize, img.constraintRotate, img.aspectLocked];
    }),
  ).toEqual([true, false, true]); // resize allowed, uniform, rotation still held

  // Hold the anchor corner, then declare the bottom edge to be 100mm — the
  // calibrate gesture (the Dimension tool builds exactly this from an edge click).
  const after = await page.evaluate(() => {
    const app = (window as any).__app;
    const img = app.doc.entities.find((e: any) => e.type === "image");
    const doc = app.doc.snapshot();
    doc.constraints.push({
      id: "c-pin",
      type: "fixedPoint",
      points: [{ entityId: img.id, key: "c0" }],
      entities: [],
      params: [20, 20],
    });
    doc.dimensions.push({
      id: "d-cal",
      type: "horizontal",
      points: [
        { entityId: img.id, key: "c0" },
        { entityId: img.id, key: "c1" },
      ],
      entities: [],
      value: 100,
      offset: 12,
      driving: true,
    });
    app.doc.restore(doc);
    app.runSolve();
    const out = app.doc.entities.find((e: any) => e.type === "image");
    return { w: out.widthMM, h: out.heightMM, angle: out.angle, x: out.position.x };
  });

  expect(after.w).toBeCloseTo(100, 3); // scaled to the declared size …
  expect(after.h).toBeCloseTo(50, 3); // … with the 2:1 aspect intact
  expect(after.angle).toBeCloseTo(0, 6); // scaled, not tilted
  expect(after.x).toBeCloseTo(20, 3); // pivoted about the held corner
});
