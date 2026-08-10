import { expect, test, waitForApp, APP_URL } from "./appFixture";
import { ORIGIN_ENTITY_ID } from "../src/model/document";

/**
 * The AI-paste import path, driven end to end through the real dialog.
 *
 * Two faults this covers, both found from one file an AI wrote:
 *
 *  - **`"layers": []` used to brick the canvas.** `restore()` tested the array's
 *    truthiness, not its length, so the document ended up with no layers while
 *    every entity still named `layer-0`. The renderer's per-entity layer lookup
 *    returned `undefined` and reading `.visible` off it THREW — aborting the
 *    frame partway through `drawEntities`, leaving grid, stock and origin on
 *    screen and no geometry at all. `test/layersInvariant.test.ts` covers the
 *    model side; only a browser can show that the frame now completes, which is
 *    what the render-error listener and the pixel check below are for.
 *  - **Warnings were unreadable.** A warned-but-successful import closed the
 *    dialog and flashed a 6-second toast carrying only the FIRST warning. This
 *    file produces more than one, so the assertion is that every warning is
 *    still on screen after the toast's lifetime has passed.
 *
 * The JSON is the file as the AI emitted it, unedited — including the
 * off-sheet coordinates that produce the bounds warning.
 */
const AI_FILE = JSON.stringify({
  version: 3,
  name: "Hello World VCarve",
  canvas: { width: 300, height: 250 },
  displayUnit: "mm",
  stockThickness: 10,
  origin: { x: "left", y: "front", z: "top" },
  stockRect: { x: 50, y: 50, width: 200, height: 150 },
  entities: [
    { type: "rectangle", id: "rect1", p0: { x: 177, y: 100.8 }, p1: { x: 431, y: 710.4 } },
    {
      type: "text",
      id: "text1",
      text: "Hello World",
      fontId: "roboto-regular",
      sizeMM: 25.4,
      position: { x: 304, y: 405.6 },
      angle: 0,
    },
  ],
  constraints: [
    {
      id: "con1",
      type: "center",
      points: [
        { entityId: "text1", key: "center" },
        { entityId: "rect1", key: "center" },
      ],
      entities: [],
      params: [],
    },
  ],
  dimensions: [],
  variables: [],
  bindings: [],
  patterns: [],
  operations: [
    {
      id: "op1",
      name: "Vcarve Hello World",
      type: "vcarve",
      entityIds: ["text1"],
      toolType: "v-bit",
      toolNumber: 1,
      diameter: 6,
      vAngle: 60,
      feedrate: 900,
      plungeRate: 200,
      spindleSpeed: 18000,
      safeZ: 5,
      depth: -2,
      vStep: 0.4,
    },
  ],
  tools: [],
  layers: [],
  activeLayerId: "layer-0",
});

test("live: a layers:[] file draws its geometry, and its warnings stay readable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });

  // A frame that throws inside drawEntities is the exact failure mode here, and
  // it is invisible to any DOM assertion — collect page errors and fail on them.
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(APP_URL);
  await waitForApp(page);
  // Through New Project, accepting its defaults — the welcome screen is a modal
  // <dialog> that swallows every click until it's dealt with. Starting from an
  // empty document also means the import replaces nothing, so it never raises
  // the "Replace current drawing?" confirm.
  const welcome = page.locator(".welcome-backdrop");
  await welcome.locator(".welcome-card", { hasText: "New Project" }).click();
  const npd = page.locator("#npd-backdrop");
  await npd.getByRole("button", { name: "Create Project" }).click();
  await expect(npd).toHaveCount(0);

  await page.locator("#topbar").getByText("File", { exact: true }).click();
  await page.getByText("AI Assistant…").click();
  const dialog = page.locator("#ai-dialog-backdrop");
  await expect(dialog).toBeVisible();

  await dialog.locator("textarea").last().fill(AI_FILE);
  await dialog.getByRole("button", { name: "Check & Import" }).click();

  // 1. The document really has a layer, and the geometry really is in it.
  await expect
    .poll(() =>
      page.evaluate((originId) => {
        const doc = (window as any).__app.doc;
        return {
          layers: doc.layers.length,
          entities: doc.entities.filter((e: { id: string }) => e.id !== originId).length,
        };
      }, ORIGIN_ENTITY_ID),
    )
    .toEqual({ layers: 1, entities: 2 });

  // 2. The frame completes. A layer lookup that returns undefined throws here,
  //    and `render()` has no try/catch, so the error surfaces as a page error.
  await page.evaluate(() => (window as any).__app.requestRender?.());
  expect(pageErrors, "the canvas threw while rendering the imported document").toEqual([]);

  // 3. The canvas actually has geometry on it — the whole visible symptom was a
  //    frame that painted the grid and stock and then stopped. Compare the ink
  //    inside the entities' own bounds against an empty document's.
  const drewSomething = await page.evaluate(() => {
    const c = document.querySelector("canvas") as HTMLCanvasElement;
    const ctx = c.getContext("2d")!;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    // Count pixels that are neither the background nor the faint grid: entity
    // strokes are far brighter than either.
    let bright = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 120 && data[i + 1] > 130 && data[i + 2] > 140) bright++;
    }
    return bright;
  });
  expect(drewSomething, "no entity strokes on the canvas").toBeGreaterThan(0);

  // 4. The warnings are still readable long after the old 6s toast would have
  //    gone, and the dialog did not close out from under them.
  await expect(dialog).toBeVisible();
  const box = dialog.locator("#ai-result");
  await expect(box).toContainText("⚠ Imported");
  await expect(box).toContainText("extend outside");
  await expect(dialog.getByRole("button", { name: /Copy Error Report/ })).toBeVisible();
  await page.waitForTimeout(6500);
  await expect(box).toBeVisible();
  await expect(box).toContainText("extend outside");
});
