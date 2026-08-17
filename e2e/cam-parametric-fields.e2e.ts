/**
 * Parametric CAM operation fields, driven through the real dialog.
 *
 * Two things only a running app proves:
 *
 *  - **One clamp table.** A field's bounds live in `OP_PARAMS`
 *    (model/variables.ts). The dialog row clamps through it on commit and
 *    `applyOpParam` clamps through it on every solve. They used to be separate
 *    tables that had already drifted on five fields, so a typed value and an
 *    expression-driven one could settle on different numbers for the same field.
 *  - **`stock` actually re-drives.** Changing stock thickness only called
 *    `emitChange()`, which repaints but never solves — so a `depth: "-stock"`
 *    operation kept the OLD thickness until some unrelated edit happened to
 *    trigger a solve. That is the entire point of the "⊥ stock" button, and it
 *    silently did not work. SettingsBar now runs the same path a variable edit
 *    does (which also regenerates features sized to the material).
 */
import { FINISH_FIELD, expect, openDoc, test } from "./appFixture";
import { CADDocument } from "../src/model/document";
import { RectEntity } from "../src/model/entities";
import { serializeDoc } from "../src/io/fileio";

function makeDoc(): string {
  const doc = new CADDocument({ width: 300, height: 200 }, "mm");
  doc.stockThickness = 12;
  doc.add(new RectEntity({ x: 20, y: 20 }, { x: 120, y: 90 }));
  return JSON.stringify(serializeDoc(doc, "cam-parametric"));
}

/** The last operation on the document, as the app currently holds it. */
function lastOp(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const doc = (
      window as unknown as {
        __app: { project: { doc: { operations: Record<string, unknown>[] } } };
      }
    ).__app.project.doc;
    const o = doc.operations[doc.operations.length - 1];
    return {
      depth: o.depth as number,
      stepover: o.stepover as number,
      paramExprs: o.paramExprs as Record<string, string> | undefined,
    };
  });
}

test("a CAM field clamps identically whether typed or driven, and tracks the stock", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  await openDoc(page, makeDoc());
  // checkOpSelection needs geometry selected before an op can be saved.
  await page.evaluate(() => {
    const doc = (
      window as unknown as { __app: { project: { doc: { entities: { selected: boolean }[] } } } }
    ).__app.project.doc;
    for (const e of doc.entities) e.selected = true;
  });

  await page.locator(".rtab", { hasText: "CAM" }).click();
  await page.locator("button.cam-add-btn", { hasText: "+ Add Toolpath" }).click();
  const dialog = page.locator(".tp-dialog");
  await expect(dialog).toBeVisible();

  // --- The shared clamp table, through the real input ---------------------
  await page.locator('[data-testid="op-type-select"]').selectOption("pocket");
  // "Stepover (0–1)" — the "Relief stepover (mm)" row also contains "stepover".
  const stepover = dialog.locator(FINISH_FIELD, { hasText: "Stepover (0" }).locator("input");
  await stepover.fill("5"); // above the 0..1 range
  await stepover.dispatchEvent("change");
  await expect(stepover).toHaveValue("1");

  await stepover.fill("-3");
  await stepover.dispatchEvent("change");
  await expect(stepover).toHaveValue("0.01");

  // --- A formula typed straight into the field ----------------------------
  const depthRow = dialog.locator(FINISH_FIELD, { hasText: "Depth (mm)" });
  const depth = depthRow.locator("input");
  await depth.fill("-stock");
  await depth.dispatchEvent("change");
  // The row keeps showing the FORMULA, and its ƒx badge reads bound, not broken
  // (a "⚠" here means the expression failed to resolve).
  await expect(depth).toHaveValue("-stock");
  await expect(depthRow.locator(".tp-fx-badge")).toHaveText("ƒx");

  await dialog.locator("button.tp-apply-btn").click();
  await expect(dialog).toHaveCount(0);

  const op = await lastOp(page);
  expect(op.paramExprs?.depth).toBe("-stock");
  expect(op.depth).toBe(-12); // resolved against the current stock
  expect(op.stepover).toBe(0.01); // the clamped value, not the -3 that was typed

  // --- Changing the stock re-drives the operation -------------------------
  await page.locator("button.settings-toggle").click(); // the panel starts collapsed
  const stockInput = page
    .locator(".settings-field-group", { hasText: "Stock thickness" })
    .locator("input");
  await stockInput.fill("25");
  await stockInput.dispatchEvent("change");

  expect((await lastOp(page)).depth, "depth should follow the stock it is bound to").toBe(-25);
  expect(errors, "console errors during the run").toEqual([]);
});
