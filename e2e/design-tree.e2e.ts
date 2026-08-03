import { expect, openDoc, test } from "./appFixture";
import { CADDocument } from "../src/model/document";
import { CircleEntity, LineEntity, RectEntity } from "../src/model/entities";
import { serializeDoc } from "../src/io/fileio";

/**
 * The design tree's WIRING and its LAYOUT, neither of which the component tests
 * can reach.
 *
 * `test/designTree.test.ts` drives the same panel under happy-dom, which has no
 * layout engine: every assertion there passes just as happily if the flyout
 * renders at zero width, slides in under the canvas, or is never instantiated by
 * app.ts at all. That last one is not hypothetical — the panel shipped into the
 * working tree fully written and never constructed. So this spec asserts the
 * things only a browser knows: the button exists in the palette, the panel takes
 * real width on screen without pushing the canvas out, and a click in the tree
 * reaches the document the canvas is drawing.
 */
function threeShapes(): string {
  const doc = new CADDocument({ width: 200, height: 150 }, "mm");
  doc.add(new LineEntity({ x: 10, y: 10 }, { x: 90, y: 10 }));
  doc.add(new CircleEntity({ x: 50, y: 80 }, 17.5));
  doc.add(new RectEntity({ x: 120, y: 20 }, { x: 180, y: 60 }));
  return JSON.stringify(serializeDoc(doc, "three-shapes"));
}

/** Ids of the entities the document currently has selected. */
const selectedIds = (page: import("@playwright/test").Page): Promise<string[]> =>
  page.evaluate(() => {
    const doc = (
      window as unknown as { __app: { doc: { entities: { id: string; selected: boolean }[] } } }
    ).__app.doc;
    return doc.entities.filter((e) => e.selected).map((e) => e.id);
  });

test("live: the tree opens from the palette and lists the drawing", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openDoc(page, threeShapes());

  const panel = page.locator(".design-tree-panel");
  const toggle = page.locator("#design-tree-toggle");
  await expect(toggle).toBeVisible();

  // Closed: present in the DOM but occupying nothing.
  expect((await panel.boundingBox())?.width ?? 0).toBeLessThan(1);

  const canvasBefore = await page.locator("#canvas-host").boundingBox();
  await toggle.click();

  // `toBeVisible` is not enough — a 0px-wide flyout satisfies it. Assert real
  // width, and that the canvas gave the space up rather than being pushed off.
  await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBeGreaterThan(150);
  const canvasAfter = await page.locator("#canvas-host").boundingBox();
  if (!canvasBefore || !canvasAfter) throw new Error("canvas host has no box");
  expect(canvasAfter.width).toBeLessThan(canvasBefore.width);
  expect(canvasAfter.x + canvasAfter.width).toBeLessThanOrEqual(1400);

  await expect(page.locator(".design-tree-body .tree-label", { hasText: "Line 80.00 mm" })).toBeVisible();
  await expect(page.locator(".design-tree-body .tree-label", { hasText: "Circle ⌀35.00 mm" })).toBeVisible();
  await expect(
    page.locator(".design-tree-body .tree-label", { hasText: "Rectangle 60.00 mm × 40.00 mm" }),
  ).toBeVisible();
});

test("live: clicking a row selects that entity on the canvas", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openDoc(page, threeShapes());
  await page.locator("#design-tree-toggle").click();

  expect(await selectedIds(page)).toEqual([]);
  await page.locator(".tree-row", { hasText: "Circle ⌀35.00 mm" }).locator(".tree-label").click();

  const picked = await selectedIds(page);
  expect(picked).toHaveLength(1);
  await expect(page.locator(".tree-row.selected .tree-label")).toHaveText("Circle ⌀35.00 mm");

  // The properties bar is the other half of "selected": the click has to reach
  // the same document the rest of the UI reads, not just paint a row.
  await expect(page.locator("#propertiesbar")).toContainText(/radius/i);
});

test("live: hiding a row removes it from the canvas and from picking", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openDoc(page, threeShapes());
  await page.locator("#design-tree-toggle").click();

  const circleRow = page.locator(".tree-row", { hasText: "Circle ⌀35.00 mm" });
  await circleRow.locator("button[title='Hide']").click();

  await expect(circleRow).toHaveClass(/hidden-item/);
  const hitAfter = await page.evaluate(() => {
    const doc = (
      window as unknown as {
        __app: { doc: { hitTest: (p: { x: number; y: number }, t: number) => { id: string } | null } };
      }
    ).__app.doc;
    return doc.hitTest({ x: 67.5, y: 80 }, 1)?.id ?? null;
  });
  expect(hitAfter).toBeNull();

  // Positive control: unhiding brings it back, so the assertion above is about
  // the eye button and not about the coordinates being wrong.
  await circleRow.locator("button[title='Show']").click();
  const hitBack = await page.evaluate(() => {
    const doc = (
      window as unknown as {
        __app: { doc: { hitTest: (p: { x: number; y: number }, t: number) => { id: string } | null } };
      }
    ).__app.doc;
    return doc.hitTest({ x: 67.5, y: 80 }, 1)?.id ?? null;
  });
  expect(hitBack).not.toBeNull();
});

test("live: Ctrl+B toggles the panel", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openDoc(page, threeShapes());
  const panel = page.locator(".design-tree-panel");

  await page.locator("#scene").click({ position: { x: 5, y: 5 } }); // focus the app, not the URL bar
  await page.keyboard.press("Control+b");
  await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBeGreaterThan(150);

  await page.keyboard.press("Control+b");
  await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBeLessThan(1);
});
