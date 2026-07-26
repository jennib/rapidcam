import { expect, test } from "@playwright/test";
import { CADDocument } from "../src/model/document";
import { RectEntity, CircleEntity } from "../src/model/entities";
import { serializeDoc } from "../src/io/fileio";
import { buildOpenUrl } from "../cli/open";

function docWithNestedSlot(): string {
  const doc = new CADDocument({ width: 300, height: 200 }, "mm");
  // Outer rectangle, pre-selected
  doc.add(new RectEntity({ x: 0, y: 0 }, { x: 100, y: 100 }));
  
  // Inner slot (island), not selected
  doc.add(new CircleEntity({ x: 50, y: 50 }, 20));

  return JSON.stringify(serializeDoc(doc, "pocket-boundary"));
}

test("Pocket boundary mode respects explicit entities over region flood-fill", async ({ page }) => {
  const url = await buildOpenUrl(docWithNestedSlot(), "http://localhost:5173/");
  await page.goto(url);

  // Wait for the app to finish loading the URL file
  await expect
    .poll(() =>
      page.evaluate(() => {
        const app = (window as any).__app;
        return app?.project?.doc?.entities?.length > 1;
      }),
    )
    .toBe(true);

  // Select the outer rectangle via evaluate
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = (window as any).__app;
    app.project.doc.entities[1].selected = true;
  });

  // Switch to CAM tab
  await page.locator('.rtab', { hasText: 'CAM' }).click();

  // Add a Toolpath
  await page.locator('.cam-add-btn', { hasText: '+ Add Toolpath' }).click();

  // Verify the dialog opened
  const dialog = page.locator('.tp-dialog');
  await expect(dialog).toBeVisible();

  // Select Pocket from the Type dropdown
  await dialog.locator('select.unit').first().selectOption({ value: 'pocket' });
  await expect(dialog).toBeVisible();

  // Remove analytics banner if present so it doesn't intercept clicks
  await page.evaluate(() => {
    const el = document.getElementById('analytics-consent-banner');
    if (el) el.remove();
  });

  // Switch to Explicit Entities mode
  await page.locator('.tp-boundary-mode').waitFor({ state: 'attached' });
  await page.locator('.tp-boundary-mode').selectOption('entities');

  // Click "+ From Selection" to add the pre-selected rectangle
  await dialog.locator('button', { hasText: '+ From Selection' }).click();

  page.on('dialog', async dialog => {
    console.log('Dialog opened: ', dialog.message());
    await dialog.accept();
  });

  // Click Apply
  await dialog.locator('button', { hasText: 'Apply' }).click();

  // Wait for dialog to close
  await expect(dialog).toHaveCount(0);

  // Verify the operation was saved as entity-based (regions is undefined/empty)
  const opSummary = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = (window as any).__app.project.doc;
    const op = doc.operations[0];
    return {
      type: op.type,
      entityIdsLength: op.entityIds ? op.entityIds.length : 0,
      hasRegions: op.regions && op.regions.length > 0
    };
  });

  expect(opSummary.type).toBe("pocket");
  // The operation should use entityIds, not regions
  expect(opSummary.entityIdsLength).toBe(1);
  expect(opSummary.hasRegions).toBeFalsy();
});
