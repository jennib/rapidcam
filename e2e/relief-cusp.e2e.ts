/**
 * The cusp calculator on a relief finish pass, through the real dialog.
 *
 * The two rows are one number read in both directions, and nothing about that
 * link is visible to a unit test: happy-dom can drive the inputs but cannot tell
 * a laid-out row from one pushed off the panel, and a G-code test never opens a
 * dialog at all. What has to hold in the app is that typing a surface finish
 * lands a stepover in the DOCUMENT — the field that is actually persisted.
 */
import { test, expect, openDoc } from "./appFixture";

/** A height map (`zRangeMM` present), which is what a relief finish targets. */
function reliefDoc(): string {
  const W = 32;
  const px: number[] = [];
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) px.push(Math.round((255 * x) / (W - 1)));
  const data = Buffer.from(Uint8Array.from(px)).toString("base64");
  return JSON.stringify({
    version: 3,
    name: "Relief cusp",
    canvas: { width: 100, height: 100 },
    displayUnit: "mm",
    stockThickness: 12,
    origin: { x: "left", y: "front", z: "top" },
    groups: [],
    layers: [{ id: "layer-0", name: "Layer 0", visible: true, locked: false }],
    activeLayerId: "layer-0",
    entities: [
      {
        type: "image",
        id: "img-ent-1",
        imageId: "img-relief1",
        position: { x: 10, y: 10 },
        widthMM: 32,
        heightMM: 32,
        angle: 0,
      },
    ],
    constraints: [],
    dimensions: [],
    variables: [],
    bindings: [],
    patterns: [],
    operations: [],
    tools: [],
    images: [{ id: "img-relief1", name: "relief", width: W, height: W, data, zRangeMM: 10 }],
  });
}

async function openToolpathDialog(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const doc = (
      window as unknown as {
        __app: { doc: { entities: { selected: boolean; type: string }[]; emitChange: () => void } };
      }
    ).__app.doc;
    for (const e of doc.entities) e.selected = e.type === "image";
    doc.emitChange();
    (document.querySelector(".cam-add-btn") as HTMLElement | null)?.click();
  });
  await expect(page.locator(".tp-dialog")).toBeVisible();
}

const fieldRow = (page: import("@playwright/test").Page, label: string) =>
  page.locator(".tp-dialog .tp-field").filter({ hasText: label });

test("a cusp typed on a relief finish lands as a stepover in the document", async ({ page }) => {
  await openDoc(page, reliefDoc());
  await openToolpathDialog(page);
  await page.locator(".tp-dialog select").first().selectOption("engrave");

  // The bit the cusp is computed against, set through the dialog like a user.
  const dia = fieldRow(page, "Diameter").locator("input").first();
  await dia.fill("6");
  await dia.blur();

  const cusp = fieldRow(page, "Cusp height").locator("input").first();
  const stepover = fieldRow(page, "Relief stepover").locator("input").first();
  await expect(cusp).toBeVisible();
  // Seeded at 10% of the bit → 0.6mm rows → a 15µm ridge.
  await expect(stepover).toHaveValue("0.60");
  await expect(cusp).toHaveValue("0.015");

  await cusp.fill("0.005");
  await cusp.blur();
  // 2·√(R² − (R−h)²) for R=3, h=0.005 → 0.346mm.
  await expect(stepover).toHaveValue("0.35");

  await page.locator(".tp-dialog button", { hasText: /^Apply$/ }).first().click();
  await expect(page.locator(".tp-dialog")).toHaveCount(0);

  const saved = await page.evaluate(() => {
    const doc = (
      window as unknown as {
        __app: { doc: { operations: { type: string; rasterLineInterval?: number }[] } };
      }
    ).__app.doc;
    const op = doc.operations.find((o) => o.type === "engrave");
    return op?.rasterLineInterval ?? null;
  });
  // The row displays 2dp but stores what it was given, so this is the derived
  // number rather than the rounded one on screen.
  expect(saved).toBeGreaterThan(0.34);
  expect(saved).toBeLessThan(0.35);
});

test("the cusp row is laid out inside the dialog, not below its scroll", async ({ page }) => {
  await openDoc(page, reliefDoc());
  await openToolpathDialog(page);
  await page.locator(".tp-dialog select").first().selectOption("engrave");
  const row = fieldRow(page, "Cusp height");
  await row.scrollIntoViewIfNeeded();
  const box = await row.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(100);
  // Its mirror: a halftone derives the row pitch, so both ends of the calculator
  // go away. Without this the assertion above passes for a row always present.
  await fieldRow(page, "Tool Type").locator("select").selectOption("v-bit");
  await fieldRow(page, "V-carve halftone").locator("input[type=checkbox]").check();
  await expect(row).toBeHidden();
});

test("screenshot: the relief cut section", async ({ page }) => {
  await openDoc(page, reliefDoc());
  await openToolpathDialog(page);
  await page.locator(".tp-dialog select").first().selectOption("engrave");
  await page.locator(".tp-dialog").screenshot({ path: "test-results/relief-cusp-dialog.png" });
  expect(await page.locator(".tp-dialog").isVisible()).toBe(true);
});
