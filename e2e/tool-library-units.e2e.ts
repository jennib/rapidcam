import { expect, test } from "@playwright/test";
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { serializeDoc } from "../src/io/fileio";
import { buildOpenUrl } from "../cli/open";

function makeInchDoc(): string {
  const doc = new CADDocument({ width: 300, height: 200 }, "in");
  doc.stockThickness = 19.05; // 0.75 in
  doc.add(new LineEntity({ x: 10, y: 10 }, { x: 50, y: 50 }));
  return JSON.stringify(serializeDoc(doc, "inch-tlib-test"));
}

test("Tool Library dialog labels and inputs use displayUnit (in)", async ({ page }) => {
  const url = await buildOpenUrl(makeInchDoc(), "http://localhost:5173/");
  await page.goto(url);

  // Wait for window.__app
  await expect
    .poll(() => page.evaluate(() => Boolean((window as any).__app)))
    .toBe(true);

  // Dismiss consent if visible
  const consent = page.locator("#analytics-consent-banner");
  if (await consent.count()) await consent.getByRole("button", { name: "No thanks" }).click();

  // Switch to CAM tab
  const camTab = page.locator(".rtab", { hasText: "CAM" });
  await camTab.click();
  await expect(camTab).toHaveClass(/active/);

  // Click "Manage Tools" button
  const libBtn = page.locator("button.cam-add-btn", { hasText: "Manage Tools" });
  await expect(libBtn).toBeVisible();
  await libBtn.click();

  // Verify dialog backdrop/class is visible
  const dialog = page.locator(".tlib-dialog");
  await expect(dialog).toBeVisible();

  // Wait for the tool list to populate
  await expect(dialog.locator(".tlib-list-item").first()).toBeVisible();

  // Check the first tool's summary label in the sidebar (e.g. ⌀0.25in end-mill)
  const firstToolDesc = dialog.locator(".tlib-list-item div").nth(1);
  await expect(firstToolDesc).toContainText("in "); // e.g. ⌀0.250in End Mill

  // Verify unit labels in the right side form
  await expect(dialog.getByText(/Diameter \(in\)/).first()).toBeVisible();
  await expect(dialog.getByText(/Feed \(in\/min\)/).first()).toBeVisible();

  // Default tool diameter is usually 6mm or 6.35mm. Check the input value is a short formatted string
  // If it's 6.35mm, in inches it should be "0.250"
  const diamInput = dialog.locator(".tp-field", { hasText: "Diameter (in)" }).locator("input");
  // Just ensure it doesn't have a massive float tail
  const diamValue = await diamInput.inputValue();
  expect(diamValue.length).toBeLessThanOrEqual(5); // e.g. "0.250" or "0.236"

  // Edit Diameter to 0.5 in (which is 12.7 mm)
  await diamInput.fill("0.5");
  await diamInput.dispatchEvent("change");

  // Edit feedrate to 20 in/min (which is 508 mm/min)
  const feedInput = dialog.locator(".tp-field", { hasText: "Feed (in/min)" }).first().locator("input");
  await feedInput.fill("20");
  await feedInput.dispatchEvent("change");

  // Close and reopen the dialog to see if the value roundtripped correctly
  const closeBtn = dialog.locator(".tp-dialog-close");
  await closeBtn.click();

  await libBtn.click();
  const dialogReopened = page.locator(".tlib-dialog");
  await expect(dialogReopened).toBeVisible();

  const diamInputReopened = dialogReopened.locator(".tp-field", { hasText: "Diameter (in)" }).locator("input");
  await expect(diamInputReopened).toHaveValue("0.500"); // padded out to precision by formatLength

  const feedInputReopened = dialogReopened.locator(".tp-field", { hasText: "Feed (in/min)" }).first().locator("input");
  await expect(feedInputReopened).toHaveValue("20.0"); // feedrate format uses 1 decimal place for in
});
