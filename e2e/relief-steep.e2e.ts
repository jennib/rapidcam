/**
 * The steep/shallow split, driven through the real dialog.
 *
 * Three things live outside anything a unit test sees: the checkbox's own
 * visibility (happy-dom has no layout), whether the flag reaches the DOCUMENT,
 * and whether the posted program changes as a result. The last is the one that
 * matters — a persisted field that never reaches the emitter is the failure mode
 * this project has shipped before.
 */
import { test, expect, openDoc } from "./appFixture";

/** A cone height map: a 63° flank, which is unambiguously steep. */
function coneDoc(): string {
  const W = 48;
  const DEPTH = 6;
  const px: number[] = [];
  for (let py = 0; py < W; py++)
    for (let x = 0; x < W; x++) {
      const h = Math.max(0, DEPTH - 2 * Math.hypot(x + 0.5 - W / 2, W - py - 0.5 - W / 2));
      px.push(Math.round((255 * Math.min(1, h / DEPTH)) | 0));
    }
  const data = Buffer.from(Uint8Array.from(px)).toString("base64");
  return JSON.stringify({
    version: 3,
    name: "Relief steep",
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
        imageId: "img-cone",
        position: { x: 10, y: 10 },
        widthMM: 48,
        heightMM: 48,
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
    images: [{ id: "img-cone", name: "cone", width: W, height: W, data, zRangeMM: DEPTH }],
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

test("ticking the steep pass persists it and posts contour passes", async ({ page }) => {
  await openDoc(page, coneDoc());
  await openToolpathDialog(page);
  await page.locator(".tp-dialog select").first().selectOption("engrave");

  const row = fieldRow(page, "Contour the steep areas");
  await expect(row).toBeVisible();
  const stepover = fieldRow(page, "Relief stepover").locator("input").first();
  await stepover.fill("0.5");
  await stepover.blur();
  await row.locator("input[type=checkbox]").check();
  await page.locator(".tp-dialog button", { hasText: /^Apply$/ }).first().click();
  await expect(page.locator(".tp-dialog")).toHaveCount(0);

  const saved = await page.evaluate(() => {
    const doc = (
      window as unknown as {
        __app: { doc: { operations: { type: string; reliefSteepPass?: boolean }[] } };
      }
    ).__app.doc;
    return doc.operations.find((o) => o.type === "engrave")?.reliefSteepPass ?? null;
  });
  expect(saved).toBe(true);

  // And it reaches the emitter. Posting runs the app's own generator over the
  // app's own document — the seam a unit test cannot reach.
  //
  // Importing the generator into the page is normally the module-identity trap
  // (a second copy of the module breaks `instanceof` on the app's entities), and
  // here it is fail-SAFE rather than fail-silent: a relief only posts at all
  // through a `RasterImageEntity` check, so a split module identity makes the
  // assertions below fail rather than pass. The specifier is held in a variable
  // so the app's own module graph resolves it, not the type-checker's.
  const gcode = await page.evaluate(async () => {
    const w = window as unknown as { __app: { doc: unknown } };
    const spec = "/src/cam/gcode.ts";
    const { generateGCode } = (await import(/* @vite-ignore */ spec)) as {
      generateGCode: (ops: unknown[], doc: unknown) => string;
    };
    const doc = w.__app.doc as { operations: unknown[] };
    return generateGCode(doc.operations, doc);
  });
  expect(gcode).toContain("steep/shallow split:");
  // The signature of a constant-Z pass: XY feed moves with no Z word at all.
  expect(gcode).toMatch(/\nG1 X-?[\d.]+ Y-?[\d.]+( F\d+)?\n/);
});

test("the steep row goes away for a halftone, which has no surface to contour", async ({
  page,
}) => {
  await openDoc(page, coneDoc());
  await openToolpathDialog(page);
  await page.locator(".tp-dialog select").first().selectOption("engrave");
  await expect(fieldRow(page, "Contour the steep areas")).toBeVisible();
  await fieldRow(page, "Tool Type").locator("select").selectOption("v-bit");
  await fieldRow(page, "V-carve halftone").locator("input[type=checkbox]").check();
  await expect(fieldRow(page, "Contour the steep areas")).toBeHidden();
});
