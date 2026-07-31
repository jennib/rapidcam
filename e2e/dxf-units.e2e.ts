import { expect, test, waitForApp } from "./appFixture";
import { ORIGIN_ENTITY_ID } from "../src/model/document";
import type { Page } from "@playwright/test";

/**
 * A DXF that declares no units must ask which it is, and honour the answer.
 *
 * $INSUNITS only arrived in R13, so a pre-R13 file (AC1009 — still what a lot
 * of hobby CNC drawings ship as) carries no units at all. Assuming millimetres
 * imported those 25.4× too small, and the only trace was a 6-second toast that
 * a repair message could push off the end.
 *
 * The whole flow only exists once the file picker, dialog and re-import are
 * wired together, which is why this is an e2e rather than a unit test: the unit
 * suite covers the parser and the dialog separately.
 */

/** Minimal headerless DXF: a 2 × 1 unit rectangle. No $INSUNITS anywhere. */
const UNITLESS_DXF = [
  0, "SECTION", 2, "ENTITIES",
  0, "LINE", 8, "0", 10, 0, 20, 0, 11, 2, 21, 0,
  0, "LINE", 8, "0", 10, 2, 20, 0, 11, 2, 21, 1,
  0, "LINE", 8, "0", 10, 2, 20, 1, 11, 0, 21, 1,
  0, "LINE", 8, "0", 10, 0, 20, 1, 11, 0, 21, 0,
  0, "ENDSEC", 0, "EOF",
].join("\n");

async function bootBlankProject(page: Page): Promise<void> {
  await page.goto("/");
  await waitForApp(page);
  const welcome = page.locator(".welcome-backdrop");
  await welcome.locator(".welcome-card", { hasText: "New Project" }).click();
  const npd = page.locator("#npd-backdrop");
  await npd.getByRole("button", { name: "Create Project" }).click();
  await expect(npd).toHaveCount(0);
}

/** Drive File → Import DXF and hand the picker the unitless fixture. */
async function importUnitlessDxf(page: Page): Promise<void> {
  await page.locator("#topbar").getByText("File", { exact: true }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByText("Import DXF", { exact: true }).click(),
  ]);
  await chooser.setFiles({
    name: "unitless.dxf",
    mimeType: "image/vnd.dxf",
    buffer: Buffer.from(UNITLESS_DXF, "utf8"),
  });
}

/** Width of the imported geometry in mm, ignoring the implicit WCS origin. */
function importedWidth(page: Page): Promise<number> {
  return page.evaluate((originId) => {
    const app = (window as any).__app;
    const ents = app.project.doc.entities.filter((e: { id: string }) => e.id !== originId);
    const xs = ents.flatMap((e: any) => [e.bounds().min.x, e.bounds().max.x]);
    return Math.max(...xs) - Math.min(...xs);
  }, ORIGIN_ENTITY_ID);
}

test("a unitless DXF asks for its units and imports at the chosen scale", async ({ page }) => {
  await bootBlankProject(page);
  await importUnitlessDxf(page);

  const dialog = page.locator(".tp-dialog", { hasText: "What units is this DXF in?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("unitless.dxf");

  // Both readings are spelled out in mm so the choice is answerable by eye.
  const inches = dialog.locator('button[data-unit="in"]');
  const mm = dialog.locator('button[data-unit="mm"]');
  await expect(inches).toContainText("50.8 × 25.4 mm");
  await expect(mm).toContainText("2 × 1 mm");
  // A 2-unit-wide drawing is far likelier inches, so that's the preselection.
  await expect(inches).toContainText("Recommended");

  await inches.click();
  await expect(dialog).toHaveCount(0);

  // The regression: this was 2 mm before the prompt existed.
  expect(await importedWidth(page)).toBeCloseTo(50.8, 6);
});

test("choosing millimetres keeps the drawing at face value", async ({ page }) => {
  await bootBlankProject(page);
  await importUnitlessDxf(page);

  await page.locator('.tp-dialog button[data-unit="mm"]').click();
  await expect(page.locator(".tp-dialog")).toHaveCount(0);
  expect(await importedWidth(page)).toBeCloseTo(2, 6);
});

test("dismissing the prompt imports nothing rather than guessing", async ({ page }) => {
  await bootBlankProject(page);
  await importUnitlessDxf(page);

  await expect(page.locator(".tp-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".tp-dialog")).toHaveCount(0);

  // Positive control: the same file DOES import 4 lines when a unit is chosen,
  // so "0 entities" here is the cancel taking effect, not a broken fixture.
  expect(
    await page.evaluate(
      (originId) =>
        (window as any).__app.project.doc.entities.filter(
          (e: { id: string }) => e.id !== originId,
        ).length,
      ORIGIN_ENTITY_ID,
    ),
  ).toBe(0);

  await importUnitlessDxf(page);
  await page.locator('.tp-dialog button[data-unit="mm"]').click();
  expect(
    await page.evaluate(
      (originId) =>
        (window as any).__app.project.doc.entities.filter(
          (e: { id: string }) => e.id !== originId,
        ).length,
      ORIGIN_ENTITY_ID,
    ),
  ).toBe(4);
});
