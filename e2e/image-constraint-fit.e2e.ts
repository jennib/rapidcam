import { expect, test } from "@playwright/test";

/**
 * Calibrating a placed image through the constraint engine, driven in a real
 * browser: the Properties "Constraints" control writes `constraintFit`, and a
 * driving dimension across the image then scales it.
 *
 * Worth doing live even though test/imageResizeConstraints.test.ts covers the
 * engine: the solver decides an image's freedom with `instanceof
 * RasterImageEntity`, so it only behaves in the app if the entity really is the
 * app's own class. The dynamic `import()` below resolves to the very module the
 * app loaded (same dev-server URL, same module instance), which is what makes
 * that check meaningful — importing a second copy would silently pass.
 */

/* biome-ignore-all lint/suspicious/noExplicitAny: page-context handles are untyped. */

test("image: 'Scale to fit' + a driving dimension calibrates the image", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
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

  // Place an 80×40 image and select it.
  await page.evaluate(async () => {
    const app = (window as any).__app;
    const ents = await import("/src/model/entities.ts");
    const img = new ents.RasterImageEntity("img-live", { x: 20, y: 20 }, 80, 40, 0);
    app.doc.add(img);
    for (const e of app.doc.entities) e.selected = e === img;
    app.doc.emitChange();
  });

  const fitSelect = page.locator(".props-row", { hasText: "Constraints" }).locator("select");
  await expect(fitSelect).toBeVisible();
  await expect(fitSelect).toHaveValue("rigid"); // images stay rigid until asked
  await expect(fitSelect.locator("option")).toHaveText([
    "Move only",
    "Scale to fit",
    "Rotate to fit",
    "Scale + rotate",
    "Stretch to fit",
  ]);

  await fitSelect.selectOption("scale");
  expect(
    await page.evaluate(
      () => (window as any).__app.doc.entities.find((e: any) => e.type === "image").constraintFit,
    ),
  ).toBe("scale");

  // Hold the anchor corner, then declare the bottom edge to be 100mm — the
  // calibrate gesture (the Dimension tool builds exactly this from an edge click).
  const after = await page.evaluate(async () => {
    const app = (window as any).__app;
    const dims = await import("/src/model/dimensions.ts");
    const cons = await import("/src/model/constraints.ts");
    const img = app.doc.entities.find((e: any) => e.type === "image");
    app.doc.addConstraint(
      cons.makeConstraint("fixedPoint", {
        points: [{ entityId: img.id, key: "c0" }],
        params: [20, 20],
      }),
    );
    app.doc.dimensions.push(
      dims.makeDimension("horizontal", {
        points: [
          { entityId: img.id, key: "c0" },
          { entityId: img.id, key: "c1" },
        ],
        value: 100,
        offset: 12,
        driving: true,
      }),
    );
    app.runSolve();
    return { w: img.widthMM, h: img.heightMM, angle: img.angle, x: img.position.x };
  });

  expect(after.w).toBeCloseTo(100, 3); // scaled to the declared size …
  expect(after.h).toBeCloseTo(50, 3); // … with the 2:1 aspect intact
  expect(after.angle).toBeCloseTo(0, 6); // scaled, not tilted
  expect(after.x).toBeCloseTo(20, 3); // pivoted about the held corner
});
