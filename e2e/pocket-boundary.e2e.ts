import { expect, openDoc, test } from "./appFixture";
import { CADDocument } from "../src/model/document";
import { RectEntity, CircleEntity } from "../src/model/entities";
import { serializeDoc } from "../src/io/fileio";

/**
 * A Pocket in "explicit entities" mode must machine the shape you picked, and
 * record it as `entityIds` rather than falling back to region flood-fill.
 *
 * The document is a square with a circular island inside it, so the two modes
 * disagree: flood-fill from a seed would find the ring-shaped region between
 * them, while an explicit pick is the square alone.
 */

/** The square-with-an-island document, plus the id of the square to machine. */
function docWithNestedSlot(): { text: string; rectId: string } {
  const doc = new CADDocument({ width: 300, height: 200 }, "mm");
  const rect = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 100, y: 100 }));
  doc.add(new CircleEntity({ x: 50, y: 50 }, 20)); // inner island, not selected
  return { text: JSON.stringify(serializeDoc(doc, "pocket-boundary")), rectId: rect.id };
}

test("Pocket boundary mode respects explicit entities over region flood-fill", async ({ page }) => {
  // Apply bails when checkOpSelection rejects the picks, and says why in a
  // toast (role=status). Capture that below so the failure reports the actual
  // reason instead of an opaque timeout on the dialog-closed assertion.
  //
  // The native-dialog handler stays as a regression guard: Apply used to
  // alert() here, and Playwright auto-dismisses unhandled dialogs, so a
  // reintroduced alert() would otherwise vanish silently. It must be
  // registered before any click — a handler attached afterwards never sees the
  // dialog it was meant to catch. NB: on its own this assertion is vacuous now
  // that nothing on this path alerts; the toast check is what has teeth.
  const nativeAlerts: string[] = [];
  page.on("dialog", async (d) => {
    nativeAlerts.push(d.message());
    await d.dismiss();
  });

  const { text, rectId } = docWithNestedSlot();
  await openDoc(page, text);

  // Select the square by id. Indexing entities[] would have worked only by
  // accident of CADDocument keeping an implicit origin point at [0] — and if
  // that ever shifted, the circle would be picked instead and every assertion
  // below would still pass, silently testing the wrong shape.
  const selected = await page.evaluate((id) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const target = (window as any).__app.project.doc.entities.find(
      (e: { id: string }) => e.id === id,
    );
    if (!target) return false;
    target.selected = true;
    return true;
  }, rectId);
  expect(selected, "the rectangle must survive the save/load round trip").toBe(true);

  await page.locator(".rtab", { hasText: "Toolpaths" }).click();
  await page.locator(".cam-add-btn", { hasText: "+ Add Toolpath" }).click();

  const dialog = page.locator(".tp-dialog");
  await expect(dialog).toBeVisible();

  await dialog.locator('[data-testid="op-type-select"]').selectOption({ value: "pocket" });

  // Explicit entities, not region flood-fill. This is the path a user takes;
  // note it is not what the assertions below isolate — the dialog picks up the
  // document selection with or without this click, so removing it does not fail
  // the test. It is here to prove the button exists and does no harm.
  await dialog.locator(".tp-boundary-mode").selectOption("entities");
  await dialog.locator("button", { hasText: "+ From Selection" }).click();

  await dialog.locator("button.tp-apply-btn").click();
  // Read the refusal before asserting the dialog closed: a rejected Apply
  // leaves the dialog open, so the toast text is the informative failure.
  const refusals = await page.locator('[role="status"]').allTextContents();
  expect(refusals, "Apply refused to save the op").toEqual([]);
  expect(nativeAlerts, "Apply raised a native alert instead of saving the op").toEqual([]);
  await expect(dialog).toHaveCount(0);

  const op = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const saved = (window as any).__app.project.doc.operations[0];
    return {
      type: saved.type,
      entityIds: saved.entityIds ?? [],
      regionCount: saved.regions?.length ?? 0,
    };
  });

  expect(op.type).toBe("pocket");
  // The shape actually machined — not merely "one of something".
  expect(op.entityIds).toEqual([rectId]);
  expect(op.regionCount).toBe(0);
});
