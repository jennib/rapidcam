import { expect, test } from "@playwright/test";
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { serializeDoc } from "../src/io/fileio";
import { buildOpenUrl } from "../cli/open";

function makeInchDoc(): string {
  const doc = new CADDocument({ width: 300, height: 200 }, "in");
  doc.stockThickness = 19.05; // 0.75 in
  doc.add(new LineEntity({ x: 10, y: 10 }, { x: 50, y: 50 }));
  return JSON.stringify(serializeDoc(doc, "inch-cam-test"));
}

test("CAM Add-Toolpath dialog labels and inputs use displayUnit (in)", async ({ page }) => {
  const url = await buildOpenUrl(makeInchDoc(), "http://localhost:5173/");
  await page.goto(url);

  // Wait for window.__app
  await expect
    .poll(() => page.evaluate(() => Boolean((window as any).__app)))
    .toBe(true);

  // Dismiss consent if visible
  const consent = page.locator("#analytics-consent-banner");
  if (await consent.count()) await consent.getByRole("button", { name: "No thanks" }).click();

  // Select all entities in the document so checkOpSelection passes when saving
  await page.evaluate(() => {
    const app = (window as any).__app;
    for (const e of app.project.doc.entities) e.selected = true;
  });

  // Switch to CAM tab
  const camTab = page.locator(".rtab", { hasText: "CAM" });
  await camTab.click();
  await expect(camTab).toHaveClass(/active/);

  // Click "+ Add Toolpath" button
  const addBtn = page.locator("button.cam-add-btn", { hasText: "+ Add Toolpath" });
  await expect(addBtn).toBeVisible();
  await addBtn.click();

  // Verify dialog backdrop/class is visible
  const dialog = page.locator(".tp-dialog");
  await expect(dialog).toBeVisible();

  // Verify unit labels in the dialog
  await expect(dialog.getByText(/Depth \(in\)/).first()).toBeVisible();
  await expect(dialog.getByText(/Diameter \(in\)/).first()).toBeVisible();
  await expect(dialog.getByText(/Feed \(in\/min\)/).first()).toBeVisible();

  // Verify formatted values (no long float tail like 0.23622047244094488)
  // Default tool diameter is 6mm -> "0.236"
  const diamInput = dialog.locator(".tp-field", { hasText: "Diameter (in)" }).locator("input");
  await expect(diamInput).toHaveValue("0.236");

  // Default feedrate is 1000mm/min -> "39.4"
  const feedInput = dialog.locator(".tp-field", { hasText: "Feed (in/min)" }).first().locator("input");
  await expect(feedInput).toHaveValue("39.4");

  // Default depth is -3mm -> "-0.118"
  const depthInput = dialog.locator(".tp-field", { hasText: "Depth (in)" }).locator("input");
  await expect(depthInput).toHaveValue("-0.118");

  // Edit Depth to -0.75 in (which is -19.05 mm)
  await depthInput.fill("-0.75");
  await depthInput.dispatchEvent("change");

  // Save the operation (Apply button)
  await dialog.locator("button.tp-apply-btn").click();
  await expect(dialog).toHaveCount(0);

  // Verify the operation was saved in mm (-19.05 mm)
  const savedOpDepth = await page.evaluate(() => {
    const app = (window as any).__app;
    const ops = app.project.doc.operations;
    return ops[ops.length - 1].depth;
  });

  expect(savedOpDepth).toBeCloseTo(-19.05, 2);
});
