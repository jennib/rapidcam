/**
 * Importing an STL, through the real menu, the real file picker and the real
 * dialog.
 *
 * Unit tests cover the parser, the rasteriser and the encoding resolver
 * separately, and all of them can pass while the wiring between them is wrong —
 * that is the failure this project keeps meeting. So this drives the path a user
 * drives: File → Import 3D Model, choose a file, press Place, and then check that
 * what landed in the document carves the model rather than a tone-curved
 * photograph of it.
 */
import { binarySTL, hemisphere, steppedBlock } from "../test/stlFixtures";
import { APP_URL, expect, test, waitForApp } from "./appFixture";
import type { Page } from "@playwright/test";

async function freshProject(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(APP_URL);
  await waitForApp(page);
  const welcome = page.locator(".welcome-backdrop");
  await welcome.locator(".welcome-card", { hasText: "New Project" }).click();
  const npd = page.locator("#npd-backdrop");
  await npd.getByRole("button", { name: "Create Project" }).click();
  await expect(npd).toHaveCount(0);
}

/** Drive File → Import 3D Model (STL)… and hand the picker `buffer`. */
async function importSTL(page: Page, buffer: Buffer, name: string): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#topbar").getByText("File", { exact: true }).click();
  await page.getByText("Import 3D Model (STL)…").click();
  await (await chooser).setFiles({ name, mimeType: "model/stl", buffer });
}

test("an imported model lands at true size and is read as a height map", async ({ page }) => {
  test.setTimeout(120_000);
  await freshProject(page);

  // A 40mm dome, 20mm tall. Every figure below is one this model determines.
  await importSTL(page, Buffer.from(binarySTL(hemisphere(20, 32, 64))), "dome.stl");

  const dialog = page.locator("#stl-backdrop");
  await expect(dialog).toBeVisible();
  // The dialog states the size and the true-scale carve depth before committing.
  await expect(dialog).toContainText("40.0 × 40.0 mm");
  await expect(dialog).toContainText("20.0 mm deep");

  // The preview is a real render of the buffer that will be registered.
  const preview = dialog.locator("canvas");
  await expect(preview).toBeVisible();
  const previewDims = await preview.evaluate((c: HTMLCanvasElement) => [c.width, c.height]);
  expect(previewDims[0]).toBeGreaterThan(16);

  await dialog.getByRole("button", { name: "Place" }).click();
  await expect(dialog).toHaveCount(0);

  const placed = await page.evaluate(async () => {
    const doc = (window as any).__app.project.doc;
    const img = doc.entities.find((e: any) => e.type === "image");
    // Specifier held in a variable so tsc treats the import as dynamic: these
    // URLs exist only at runtime, served by the dev server (page.evaluate bodies
    // never go through Vite).
    const imgUrl = "/src/core/imageManager.ts";
    const { heightfieldMeta, getImageGrid } = (await import(imgUrl)) as {
      heightfieldMeta: (id: string) => { zRangeMM: number } | null;
      getImageGrid: (id: string) => { width: number; height: number; data: Float32Array };
    };
    const grid = getImageGrid(img.imageId);
    // Sample the centre of the dome and a bounding-box corner.
    const mid = Math.floor(grid.height / 2) * grid.width + Math.floor(grid.width / 2);
    return {
      widthMM: img.widthMM,
      heightMM: img.heightMM,
      zRangeMM: heightfieldMeta(img.imageId)?.zRangeMM ?? null,
      centreByte: Math.round(grid.data[mid] * 255),
      cornerByte: Math.round(grid.data[0] * 255),
    };
  });

  // Placed at the model's own size — a model has one, unlike a photograph.
  expect(placed.widthMM).toBeCloseTo(40, 3);
  expect(placed.heightMM).toBeCloseTo(40, 3);
  // The marker survived the real registration path, carrying the carve depth.
  expect(placed.zRangeMM).toBeCloseTo(20, 3);
  // Top of the dome = no cut; a bbox corner the dome never reaches = full depth.
  expect(placed.centreByte).toBe(255);
  expect(placed.cornerByte).toBe(0);
});

test("the height map is not tone-curved, and the top of the model survives", async ({ page }) => {
  test.setTimeout(120_000);
  await freshProject(page);

  // A staircase whose top tread is 10mm — the byte-255 band that a photograph's
  // 0.96 white threshold discards. On a 25mm model that is ~1mm of lost height.
  await importSTL(page, Buffer.from(binarySTL(steppedBlock(40, 40, 5, 5))), "steps.stl");
  await page.locator("#stl-backdrop").getByRole("button", { name: "Place" }).click();
  await expect(page.locator("#stl-backdrop")).toHaveCount(0);

  const result = await page.evaluate(async () => {
    const doc = (window as any).__app.project.doc;
    const img = doc.entities.find((e: any) => e.type === "image");
    // Specifiers held in variables — see the note in the spec above.
    const encUrl = "/src/cam/reliefEncoding.ts";
    const rasUrl = "/src/cam/rasterEngrave.ts";
    const imgUrl = "/src/core/imageManager.ts";
    const [{ reliefEncodingFor }, { rasterField }, { getImageGrid }] = (await Promise.all([
      import(encUrl),
      import(rasUrl),
      import(imgUrl),
    ])) as [
      {
        reliefEncodingFor: (
          e: unknown,
          o: unknown,
        ) => {
          op: { halftone?: boolean };
          field: (li: number, dp?: number, tone?: string) => Record<string, unknown>;
        };
      },
      { rasterField: (g: unknown, p: unknown) => { rows: { levels: Float32Array }[] } },
      { getImageGrid: (id: string) => unknown },
    ];
    // A relief op with a tone curve dialled in, which a height map must ignore.
    const op = {
      id: "o",
      name: "relief",
      type: "engrave",
      entityIds: [img.id],
      side: "outside",
      toolType: "ball-nose",
      toolNumber: 1,
      diameter: 3,
      feedrate: 1500,
      plungeRate: 300,
      spindleSpeed: 18000,
      safeZ: 5,
      depth: -25,
      stepdown: 25,
      stepover: 0.4,
      reliefGamma: 2.2,
      halftone: true,
      vAngle: 60,
    };
    const enc = reliefEncodingFor(img, op as any);
    const params = enc.field(0.5, 0.5, "linear");
    const field = rasterField(getImageGrid(img.imageId), params);
    const levels: number[] = field.rows.flatMap((r) => Array.from(r.levels));
    return {
      gamma: params.gamma as number,
      tone: params.tone as string,
      whiteThreshold: params.whiteThreshold as number,
      halftone: enc.op.halftone,
      distinctLevels: new Set(levels.map((v: number) => Math.round(v * 255))).size,
      shallowest: Math.min(...levels.filter((v: number) => v > 0)),
    };
  });

  // The three flags that are silent when wrong.
  expect(result.gamma).toBe(1);
  expect(result.tone).toBe("encoded");
  expect(result.whiteThreshold).toBeGreaterThan(1);
  // Halftoning would reinterpret the field as a V-groove screen — and would also
  // switch off the tool-footprint gouge correction the model needs most.
  expect(result.halftone).toBe(false);
  // Five treads, and the shallowest is a real cut rather than a blanked 0.
  expect(result.distinctLevels).toBe(5);
  expect(result.shallowest).toBeGreaterThan(0);
});
