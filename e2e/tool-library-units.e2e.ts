import { expect, openDoc, test } from "./appFixture";
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { serializeDoc } from "../src/io/fileio";

function makeInchDoc(): string {
  const doc = new CADDocument({ width: 300, height: 200 }, "in");
  doc.stockThickness = 19.05; // 0.75 in
  doc.add(new LineEntity({ x: 10, y: 10 }, { x: 50, y: 50 }));
  return JSON.stringify(serializeDoc(doc, "inch-tlib-test"));
}

test("Tool Library dialog labels and inputs use displayUnit (in)", async ({ page }) => {
  await openDoc(page, makeInchDoc());

  // Switch to CAM tab
  const camTab = page.locator(".rtab", { hasText: "Toolpaths" });
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

  // The sidebar summary carries the diameter in inches, e.g. "⌀0.250in End Mill".
  // Matched as a shape, not as the substring "in " — that would also be satisfied
  // by any tool name containing the letters, which is most of them.
  const firstToolDesc = dialog.locator(".tlib-list-item div").nth(1);
  await expect(firstToolDesc).toHaveText(/⌀\d+\.\d+in\b/);

  // Verify unit labels in the right side form
  await expect(dialog.getByText(/Diameter \(in\)/).first()).toBeVisible();
  await expect(dialog.getByText(/Feed \(in\/min\)/).first()).toBeVisible();

  // The default diameter must arrive already converted and rounded — the bug this
  // guards is a raw float tail like "0.24999999999999997". Asserted as the shape
  // formatLength produces for inches (3 decimals, e.g. "0.250" from 6.35mm) rather
  // than by string length, which "abcde" also satisfies.
  const diamInput = dialog.locator(".tp-field", { hasText: "Diameter (in)" }).locator("input");
  await expect(diamInput).toHaveValue(/^\d+\.\d{3}$/);

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
