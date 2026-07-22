import { expect, test } from "@playwright/test";
import { CADDocument } from "../src/model/document";
import { PolylineEntity } from "../src/model/entities";
import { serializeDoc } from "../src/io/fileio";
import { buildOpenUrl } from "../cli/open";

function makeDoc(): string {
  const doc = new CADDocument({ width: 300, height: 200 }, "mm");
  doc.stockThickness = 10;
  
  // 6.35mm hole (hairline fit for a 6mm tool)
  const c1 = new PolylineEntity(
    Array.from({ length: 32 }, (_, i) => {
      const a = (i / 32) * Math.PI * 2;
      return { x: 50 + Math.cos(a) * 3.175, y: 50 + Math.sin(a) * 3.175 };
    }),
    true,
  );
  doc.add(c1);
  doc.operations.push({
    id: "op1",
    name: "Hairline Pocket",
    type: "pocket",
    entityIds: [c1.id],
    diameter: 6,
    feedrate: 1000,
    plungeRate: 300,
    spindleSpeed: 18000,
    depth: -5,
    safeZ: 5,
    stepdown: 5,
    regions: [],
    selected: true,
  });

  // 6.0mm hole (completely unreachable for a 6mm tool)
  const c2 = new PolylineEntity(
    Array.from({ length: 32 }, (_, i) => {
      const a = (i / 32) * Math.PI * 2;
      return { x: 100 + Math.cos(a) * 3.0, y: 50 + Math.sin(a) * 3.0 };
    }),
    true,
  );
  doc.add(c2);
  doc.operations.push({
    id: "op2",
    name: "Unreachable Pocket",
    type: "pocket",
    entityIds: [c2.id],
    diameter: 6,
    feedrate: 1000,
    plungeRate: 300,
    spindleSpeed: 18000,
    depth: -5,
    safeZ: 5,
    stepdown: 5,
    regions: [],
    selected: true,
  });

  // 8.0mm hole (clean fit for a 6mm tool)
  const c3 = new PolylineEntity(
    Array.from({ length: 32 }, (_, i) => {
      const a = (i / 32) * Math.PI * 2;
      return { x: 150 + Math.cos(a) * 4.0, y: 50 + Math.sin(a) * 4.0 };
    }),
    true,
  );
  doc.add(c3);
  doc.operations.push({
    id: "op3",
    name: "Standard Pocket",
    type: "pocket",
    entityIds: [c3.id],
    diameter: 6,
    feedrate: 1000,
    plungeRate: 300,
    spindleSpeed: 18000,
    depth: -5,
    safeZ: 5,
    stepdown: 5,
    regions: [],
    selected: true,
  });

  return JSON.stringify(serializeDoc(doc, "machinability-test"));
}

test("machinability linter correctly flags unreachable and hairline pockets", async ({ page }) => {
  const url = await buildOpenUrl(makeDoc(), "http://localhost:5173/");
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

  // Select the operations in the UI for combined export
  const selects = page.locator(".tp-select");
  // Ensure the operations have loaded
  await expect(selects).toHaveCount(3);
  await selects.nth(0).check();
  await selects.nth(1).check();
  await selects.nth(2).check();

  // Click Export Selected button
  const exportSelBtn = page.locator(".cam-export-sel-btn");
  // Ensure the UI updates to show the button
  await expect(exportSelBtn).toBeVisible();
  await exportSelBtn.click();

  // The confirm dialog should pop up with the warnings
  const modal = page.locator(".tp-backdrop .tp-dialog");
  await expect(modal).toBeVisible();

  const text = await modal.textContent();
  expect(text).toContain(`"Hairline Pocket": 1 feature region is a 'hairline' fit`);
  expect(text).toContain(`"Unreachable Pocket": no part of its geometry is reachable`);
  expect(text).not.toContain(`"Standard Pocket"`); // Should pass clean
});
