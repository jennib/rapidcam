import { expect, test } from "@playwright/test";

/**
 * Laser on a rotary, driven in a real browser. The generator math is unit-covered
 * in test/laserRotary.test.ts; this guards the wiring that only exists in the DOM
 * — that picking the machine type really gives you cylinder stock, and that the
 * rotary rows which mean nothing to a beam (rotary axis word, Z0 reference, arc
 * tolerance) are actually hidden rather than merely irrelevant.
 */

/* biome-ignore-all lint/suspicious/noExplicitAny: page-context handles are untyped. */

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
  await expect
    .poll(() =>
      page.evaluate(() => "__app" in window && Boolean((window as { __app?: unknown }).__app)),
    )
    .toBe(true);

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
  await page.locator("#analytics-consent-banner").getByRole("button", { name: "No thanks" }).click();

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

  // And the posted program substitutes the axis instead of wrapping it.
  const program = await page.evaluate(async () => {
    const app = (window as any).__app;
    const ents = await import("/src/model/entities.ts");
    const klein = await import("/src/cam/klein.ts");
    const c = app.doc.add(new ents.CircleEntity({ x: 100, y: app.doc.canvas.height / 2 }, 25));
    app.doc.operations = [
      {
        id: "op1",
        name: "cut",
        type: "profile",
        side: "outside",
        entityIds: [c.id],
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
    return klein.generateRotaryProgram(app.doc).program;
  });
  const motion = program
    .split("\n")
    .map((l: string) => l.trim())
    .filter((l: string) => /^G[0-3]\b/.test(l));
  expect(motion.length).toBeGreaterThan(1);
  expect(motion.some((l: string) => /\b[AB]-?[\d.]/.test(l))).toBe(false); // no 4th-axis word
  expect(motion.some((l: string) => /\bZ-?[\d.]/.test(l))).toBe(false); // no Z on a beam
  expect(program).toMatch(/axis substitution/i);
  expect(program).toMatch(/one revolution = /);
  expect(program).toMatch(/^M4 S\d+/m); // beam commanded
});
