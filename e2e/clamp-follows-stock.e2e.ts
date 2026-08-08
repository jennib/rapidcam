import { test, expect, waitForApp } from "./appFixture";

/**
 * Drives the Clamp generator through the real UI: insert one on the blank's left
 * edge, then resize the blank in Settings and check the clamp followed.
 *
 * The follow-the-stock behaviour is the whole point of the feature and it is
 * invisible to unit tests — it depends on settingsBar's commit calling back into
 * the solve coordinator, which is wiring no unit test sees (the same gap that
 * once let "changing stock thickness never re-solves" ship green).
 *
 * The progress screenshots go through `testInfo.outputPath`, NOT a bare
 * filename: a bare path is relative to the CWD, so these used to drop three
 * untracked `scratch-clamp-*.png` files into the repo root on every run.
 * outputPath puts them in this test's folder under test-results/, which is
 * gitignored and cleaned between runs — and the HTML report picks them up.
 */
test("a clamp lands on the blank's edge and follows a stock resize", async ({ page }, testInfo) => {
  await page.goto("/");
  await waitForApp(page);

  // Dismiss the welcome screen through New Project, accepting its defaults.
  const welcome = page.locator(".welcome-backdrop");
  await welcome.locator(".welcome-card", { hasText: "New Project" }).click();
  await page.locator("#npd-backdrop .tp-apply-btn").click();
  await expect(welcome).toHaveCount(0);

  const stockBefore = await page.evaluate(() => (window as any).__app.doc.stockRect);
  console.log("stock before:", JSON.stringify(stockBefore));

  // --- Insert → Clamp -----------------------------------------------------
  await page.getByRole("button", { name: "Insert" }).click();
  // Menu items are rendered as "<name>…", so anchor the start only.
  const clampItem = page.locator(".fmenu-item", { hasText: /^Clamp/ });
  await expect(clampItem).toBeVisible();
  await clampItem.click();

  const dialog = page.locator(".tp-dialog");
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("clamp-dialog.png") });

  // The edge parameter must render as a DROPDOWN, not a number spinner — the
  // reason ParamSpec.choices exists.
  const edgeSelect = dialog.locator("select");
  await expect(edgeSelect).toHaveCount(1);
  const options = await edgeSelect.locator("option").allTextContents();
  console.log("edge options:", options.join(" | "));
  expect(options).toEqual(["Left", "Right", "Front (bottom)", "Back (top)"]);

  // The RIGHT edge specifically. Widening the blank moves the right face and
  // leaves the left one alone, so a left-edge clamp is expected NOT to move —
  // its "after" position is identical whether the panel re-drives the document
  // or does nothing at all, and the test would pass on completely dead wiring.
  await edgeSelect.selectOption({ label: "Right" });
  await dialog.getByRole("button", { name: /insert/i }).click();
  await expect(dialog).toBeHidden();

  const after = await page.evaluate(() => {
    const doc = (window as any).__app.doc;
    const layer = doc.layers.find((l: any) => l.name === "Workholding");
    const ent = doc.entities.find((e: any) => e.layerId === layer?.id);
    const b = ent.bounds();
    return {
      layerIsFixture: layer?.fixture === true,
      layerHeight: layer?.fixtureHeight ?? null,
      entHeight: ent.fixtureHeight,
      entId: ent.id,
      minX: b.min.x,
      maxX: b.max.x,
      stockX: doc.stockRect.x,
      stockW: doc.stockRect.width,
      features: doc.features.length,
    };
  });
  console.log("after insert:", JSON.stringify(after));
  expect(after.layerIsFixture).toBe(true);
  expect(after.layerHeight).toBeNull(); // height lives on the clamp, not the layer
  expect(after.entHeight).toBe(20);
  // Default reach 40 with 12mm onto the material: the clamp spans from 12mm
  // inboard of the right face to 28mm outboard of it.
  const faceBefore = after.stockX + after.stockW;
  expect(after.minX).toBeCloseTo(faceBefore - 12, 1);
  expect(after.maxX).toBeCloseTo(faceBefore + 28, 1);
  await page.screenshot({ path: testInfo.outputPath("clamp-inserted.png") });

  // --- Resize the blank in Settings ---------------------------------------
  // Open the settings panel and widen the stock. This is the path that used to
  // repaint and nothing else.
  // The settings panel lives inside the CAM tab and starts collapsed, so both
  // have to be opened — as a user would, via the tab button and the panel's own
  // toggle. (Reaching in to strip the `collapsed` class leaves the panel still
  // inside a hidden tab, which is what made this look like a selector problem.)
  await page.locator('.rtab[data-tab="cam"]').click();
  const settings = page.locator("#settingsbar");
  await expect(settings).toBeVisible();
  if (await settings.evaluate((el) => el.classList.contains("collapsed"))) {
    await settings.locator(".settings-toggle").click();
  }

  const stockSection = page
    .locator("#settingsbar .settings-section")
    .filter({ has: page.locator(".settings-section-title", { hasText: /^Stock$/ }) });
  const widthField = stockSection
    .locator(".settings-field-group", { hasText: /^Width$/ })
    .locator("input");
  await widthField.fill("260");
  await widthField.press("Enter");
  await widthField.blur();

  const moved = await page.evaluate(() => {
    const doc = (window as any).__app.doc;
    const layer = doc.layers.find((l: any) => l.name === "Workholding");
    const ent = doc.entities.find((e: any) => e.layerId === layer?.id);
    const b = ent.bounds();
    return { minX: b.min.x, maxX: b.max.x, stock: doc.stockRect, entId: ent.id };
  });
  console.log("after resize:", JSON.stringify(moved));
  await page.screenshot({ path: testInfo.outputPath("clamp-after-resize.png") });

  // The blank is 60mm wider, so its right face moved 60mm and the clamp must
  // have moved with it. Asserting the DELTA as well as the absolute position:
  // the delta is the half that dies if the settings panel stops re-driving the
  // document, which is the wiring this spec exists to protect.
  expect(moved.stock.width).toBe(260);
  const faceAfter = moved.stock.x + moved.stock.width;
  expect(faceAfter - faceBefore).toBeCloseTo(60, 1);
  expect(moved.maxX - after.maxX).toBeCloseTo(60, 1);
  expect(moved.minX).toBeCloseTo(faceAfter - 12, 1);
  expect(moved.maxX).toBeCloseTo(faceAfter + 28, 1);

  // Same entity throughout: a rebuild that replaced the clamp with a new id
  // would break every op, constraint and dimension attached to it.
  expect(moved.entId).toBe(after.entId);
});
