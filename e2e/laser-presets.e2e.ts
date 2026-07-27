import { expect, openDoc, test } from "./appFixture";
import { CADDocument } from "../src/model/document";
import { RectEntity } from "../src/model/entities";
import { serializeDoc } from "../src/io/fileio";

/**
 * Laser material presets, driven in a real browser.
 *
 * Deliberately narrow: the picker's filtering, the apply-repopulates-inputs
 * contract and the empty state are all covered far more cheaply in
 * test/camBarDialog.test.ts. What only exists here is the bit a DOM test has to
 * stub — saving goes through a NATIVE `window.prompt` (matching the tool
 * library's "Save tool as:" next to it), and a native dialog is the one thing
 * that has previously masqueraded as a hang in headless Chrome. So this pins the
 * real prompt round-trip, plus the manager dialog it feeds.
 */

function laserDoc(): string {
  const doc = new CADDocument({ width: 300, height: 200 }, "mm");
  doc.machineKind = "laser";
  doc.add(new RectEntity({ x: 20, y: 20 }, { x: 120, y: 100 }));
  return JSON.stringify(serializeDoc(doc, "laser-presets"));
}

test("a preset saved through the native prompt loads back and reaches the manager", async ({
  page,
}) => {
  await openDoc(page, laserDoc());
  await page.locator(".rtab", { hasText: "CAM" }).click();

  await page.evaluate(() => {
    for (const e of (window as any).__app.project.doc.entities) e.selected = true;
  });
  await page.locator(".cam-add-btn", { hasText: "+ Add Toolpath" }).click();
  const dialog = page.locator(".tp-dialog");
  await expect(dialog).toBeVisible();

  // "Power (%)" must match exactly — the raster section also has "Min power (%)".
  const power = dialog
    .locator(".tp-field")
    .filter({ has: page.getByText("Power (%)", { exact: true }) })
    .locator("input");
  await power.fill("42");
  await power.dispatchEvent("change");

  // The native prompt: registered BEFORE the click that raises it, or the
  // handler never sees it and Playwright silently auto-dismisses instead.
  let promptMessage = "";
  page.once("dialog", async (d) => {
    promptMessage = d.message();
    await d.accept("3mm ply");
  });
  await dialog.locator(".tp-preset-save").click();
  await expect.poll(() => promptMessage).toMatch(/preset/i);

  // It comes back with the numbers it was saved with...
  await dialog.locator(".tp-preset-load").click();
  const item = dialog.locator(".tp-preset-item");
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("3mm ply");
  await expect(item).toContainText("42%");

  // ...and applying it repopulates the input, not just the state behind it.
  await power.fill("7");
  await power.dispatchEvent("change");
  await item.click();
  await expect(power).toHaveValue("42");

  // The manager reaches the same store and reports the job kind it was saved for.
  await dialog.locator(".tp-dialog-close").click();
  await page.locator(".cam-presets-btn").click();
  const mgr = page.locator(".lpre-dialog");
  await expect(mgr).toBeVisible();
  await expect(mgr.locator(".lpre-item")).toHaveCount(1);
  await expect(mgr.locator(".lpre-name")).toHaveValue("3mm ply");
  await expect(mgr.locator(".lpre-kind")).toHaveText("Cut");
});
