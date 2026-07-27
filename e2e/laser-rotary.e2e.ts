import { expect, test, waitForApp } from "./appFixture";

/**
 * Laser on a rotary, driven in a real browser. The generator math is unit-covered
 * in test/laserRotary.test.ts; this guards the wiring that only exists in the DOM
 * — that picking the machine type really gives you cylinder stock, and that the
 * rotary rows which mean nothing to a beam (rotary axis word, Z0 reference, arc
 * tolerance) are actually hidden rather than merely irrelevant.
 */

/** Row labels actually on screen — `display:none` rows excluded. */
async function visibleRows(scope: import("@playwright/test").Locator, sel: string) {
  const rows = scope.locator(sel);
  const out: string[] = [];
  for (let i = 0; i < (await rows.count()); i++) {
    const r = rows.nth(i);
    if (await r.isVisible()) out.push(((await r.textContent()) ?? "").trim());
  }
  return out;
}
const hasRow = (rows: string[], label: string) => rows.some((r) => r.startsWith(label));

test("laser rotary: cylinder stock, beam-only settings, substituted-axis program", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/");
  await waitForApp(page);

  await page.locator(".welcome-backdrop .welcome-card", { hasText: "New Project" }).click();
  const npd = page.locator("#npd-backdrop");
  await expect(npd).toBeVisible();
  const npdKind = npd.locator(".tp-field", { hasText: "Machine type" }).locator("select");
  await expect(npdKind.locator("option")).toHaveText([
    "CNC Mill / Router",
    "CNC Mill — Rotary / 4th axis",
    "Laser",
    "Laser — Rotary (cylinder)",
  ]);

  // Rotary stock (Length × Diameter) for both rotary heads; the Z0 reference is
  // mill-only, because a beam emits no Z to zero.
  await npdKind.selectOption("laser-rotary");
  let rows = await visibleRows(npd, ".tp-field");
  expect(hasRow(rows, "Length")).toBe(true);
  expect(hasRow(rows, "Diameter")).toBe(true);
  expect(hasRow(rows, "Rotary Z0")).toBe(false);
  await npdKind.selectOption("mill-rotary");
  rows = await visibleRows(npd, ".tp-field");
  expect(hasRow(rows, "Rotary Z0")).toBe(true);
  await npdKind.selectOption("laser-rotary");

  await npd.getByRole("button", { name: "Create Project" }).click();
  await expect(npd).toHaveCount(0);

  // The document is a beam AND a cylinder, with the canvas locked to π·⌀.
  const doc = await page.evaluate(() => {
    const d = (window as any).__app.doc;
    return {
      machineKind: d.machineKind,
      isLaser: d.isLaser,
      isRotary: d.isRotary,
      stock: d.stock,
      canvasH: d.canvas.height,
      post: d.postProcessor,
    };
  });
  expect(doc).toMatchObject({ machineKind: "laser-rotary", isLaser: true, isRotary: true });
  expect(doc.stock.kind).toBe("cylinder");
  expect(doc.canvasH).toBeCloseTo(Math.PI * doc.stock.diameter, 6);
  expect(doc.post).toMatch(/grbl|marlin|smoothie|linuxcnc-laser/); // a laser controller

  // Machine Settings: the cylinder rows show, the mill-only rotary rows don't.
  await page.locator("#topbar").getByRole("button", { name: "Settings" }).click();
  const settings = page.locator(".post-settings-dialog");
  await expect(settings).toBeVisible();
  rows = await visibleRows(settings, ".post-settings-field");
  expect(hasRow(rows, "Wrap axis")).toBe(true);
  expect(hasRow(rows, "Cylinder diameter")).toBe(true);
  expect(hasRow(rows, "Rotary axis word")).toBe(false);
  expect(hasRow(rows, "Zero reference")).toBe(false);
  expect(hasRow(rows, "Arc tolerance")).toBe(false);
  const settingsKind = settings
    .locator(".post-settings-field", { hasText: "Machine type" })
    .locator("select");
  await settingsKind.selectOption("mill-rotary");
  rows = await visibleRows(settings, ".post-settings-field");
  expect(hasRow(rows, "Rotary axis word")).toBe(true);
  expect(hasRow(rows, "Zero reference")).toBe(true);
  await settingsKind.selectOption("laser-rotary");
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(settings).toHaveCount(0);

  // And the posted program substitutes the axis instead of wrapping it. Geometry
  // and the op go in through `doc.restore()` so they're built by the app's own
  // constructors: a dynamic import() can resolve to a different module instance
  // once Vite has HMR-invalidated the file, and entities from a duplicate class
  // fail every `instanceof` in the generator — producing an empty program that
  // would quietly satisfy the "no A word" assertion below.
  const program = await page.evaluate(async () => {
    const app = (window as any).__app;
    const doc = app.doc.snapshot();
    doc.entities.push({
      type: "circle",
      id: "c-live",
      center: { x: 100, y: app.doc.canvas.height / 2 },
      radius: 25,
      selected: false,
      isConstruction: false,
      layerId: "layer-0",
    });
    doc.operations = [
      {
        id: "op1",
        name: "cut",
        type: "profile",
        side: "outside",
        entityIds: ["c-live"],
        toolType: "end-mill",
        toolNumber: 1,
        diameter: 0,
        feedrate: 1200,
        plungeRate: 300,
        spindleSpeed: 0,
        safeZ: 5,
        depth: -1,
        stepdown: 1,
        stepover: 0.4,
        laserPower: 70,
        laserPasses: 1,
      },
    ];
    app.doc.restore(doc);
    // The specifier is a browser URL that Vite resolves at runtime, not a path
    // tsc can follow — holding it in a variable keeps the literal away from the
    // compiler while the annotation still types the module from the real source.
    const kleinUrl = "/src/cam/klein.ts";
    const klein: typeof import("../src/cam/klein") = await import(kleinUrl);
    return klein.generateRotaryProgram(app.doc).program;
  });
  const motion = program
    .split("\n")
    .map((l: string) => l.trim())
    .filter((l: string) => /^G[0-3]\b/.test(l));
  // Guard the guard: an empty program would pass every negative assertion below.
  expect(motion.length).toBeGreaterThan(1);
  expect(motion.some((l: string) => /^G[23]\b/.test(l))).toBe(true); // the circle really posted
  expect(motion.some((l: string) => /\b[AB]-?[\d.]/.test(l))).toBe(false); // no 4th-axis word
  expect(motion.some((l: string) => /\bZ-?[\d.]/.test(l))).toBe(false); // no Z on a beam
  expect(program).toMatch(/axis substitution/i);
  expect(program).toMatch(/one revolution = /);
  expect(program).toMatch(/^M4 S\d+/m); // beam commanded
});
