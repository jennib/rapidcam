import { expect, openDoc, test } from "./appFixture";
import { CADDocument } from "../src/model/document";
import { PolylineEntity } from "../src/model/entities";
import { serializeDoc } from "../src/io/fileio";

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
    stepover: 0.4,
    side: "outside",
    toolType: "end-mill",
    toolNumber: 1,
    stepdown: 5,
    regions: [],
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
    stepover: 0.4,
    side: "outside",
    toolType: "end-mill",
    toolNumber: 1,
    stepdown: 5,
    regions: [],
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
    stepover: 0.4,
    side: "outside",
    toolType: "end-mill",
    toolNumber: 1,
    stepdown: 5,
    regions: [],
  });

  return JSON.stringify(serializeDoc(doc, "machinability-test"));
}

test("machinability linter correctly flags unreachable and hairline pockets", async ({ page }) => {
  await openDoc(page, makeDoc());

  // Switch to CAM tab
  const camTab = page.locator(".rtab", { hasText: "Toolpaths" });
  await camTab.click();
  await expect(camTab).toHaveClass(/active/);

  // Every operation goes into the combined export. Which op sits at which index
  // is not part of what this test asserts, so select them all rather than naming
  // positions — the count assertion is what proves they loaded.
  const selects = page.locator(".tp-select");
  await expect(selects).toHaveCount(3);
  for (const box of await selects.all()) await box.check();

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
