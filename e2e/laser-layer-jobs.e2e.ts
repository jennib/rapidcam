/**
 * Layer-driven laser jobs, across the machine kinds they run on.
 *
 * The engine rules are unit-tested (test/laserJob.test.ts). What only a browser
 * can show is the wiring: that the action is offered on the machines it works
 * on and absent on the ones it doesn't, that clicking it really populates the
 * CAM panel, and — the part that had no permanent cover at all — that a job
 * built this way survives the ROTARY wrap with its per-layer power and feed
 * intact.
 *
 * Documents are built by mutating a real `doc.snapshot()` and restoring it,
 * never by `await import("/src/model/entities.ts")`: Vite serves HMR-versioned
 * URLs, so an imported class can be a DIFFERENT class from the app's, every
 * `instanceof` silently fails, and `hasCuttablePath` would find no targets while
 * the spec reported a cheerful zero-operation pass.
 */
import { test, expect, waitForApp, APP_URL } from "./appFixture";
import type { Page } from "@playwright/test";

interface LaserRecipe {
  kind?: "cut" | "score" | "engrave" | "fill";
  feedrate: number;
  laserPower: number;
  laserPasses: number;
  kerfWidth?: number;
}
interface LayerSpec {
  id: string;
  name: string;
  visible?: boolean;
  laser?: LaserRecipe;
}
interface Shape {
  kind: "rect" | "circle" | "line";
  id: string;
  layerId: string;
  a?: [number, number];
  b?: [number, number];
  c?: [number, number];
  r?: number;
}

/**
 * Get past the welcome screen into an empty project.
 *
 * It is a modal `<dialog>`, so it swallows clicks on the panels underneath —
 * `page.evaluate` still works, which is why a spec that only reads state passes
 * without this and one that clicks a button does not.
 */
async function newProject(page: Page): Promise<void> {
  const welcome = page.locator(".welcome-backdrop");
  await welcome.locator(".welcome-card", { hasText: "New Project" }).click();
  await page.locator("#npd-backdrop .tp-apply-btn").click();
  await expect(welcome).toHaveCount(0);
}

/** Replace the open document with one built from plain data. */
async function loadDoc(
  page: Page,
  spec: {
    machineKind: string;
    layers: LayerSpec[];
    shapes: Shape[];
    rotary?: { diameter: number; wrapAxis: string; zero: string };
  },
): Promise<void> {
  await page.evaluate((s) => {
    const app = (window as unknown as { __app: { doc: Record<string, unknown> } }).__app;
    const doc = app.doc as unknown as {
      snapshot(): Record<string, unknown>;
      restore(x: Record<string, unknown>): void;
      emitChange(): void;
    };
    // Start from a real snapshot so every required field is already present.
    const snap = doc.snapshot();
    snap.machineKind = s.machineKind;
    snap.rotary = s.rotary ?? null;
    snap.layers = s.layers.map((l) => ({
      id: l.id,
      name: l.name,
      color: "#888888",
      visible: l.visible !== false,
      locked: false,
      ...(l.laser ? { laser: l.laser } : {}),
    }));
    snap.activeLayerId = s.layers[0].id;
    const origin = (snap.entities as { id: string }[]).filter((e) => e.id === "__origin__");
    snap.entities = [
      ...origin,
      ...s.shapes.map((sh) => {
        const base = { id: sh.id, selected: false, isConstruction: false, layerId: sh.layerId };
        if (sh.kind === "rect")
          return { ...base, type: "rectangle", p0: { x: sh.a![0], y: sh.a![1] }, p1: { x: sh.b![0], y: sh.b![1] } };
        if (sh.kind === "circle")
          return { ...base, type: "circle", center: { x: sh.c![0], y: sh.c![1] }, radius: sh.r };
        return { ...base, type: "line", a: { x: sh.a![0], y: sh.a![1] }, b: { x: sh.b![0], y: sh.b![1] } };
      }),
    ];
    snap.operations = [];
    doc.restore(snap);
    doc.emitChange();
  }, spec);
}

/** Whether a CAM-panel button matching `label` is on screen. */
async function btnShown(page: Page, label: RegExp): Promise<boolean[]> {
  return page.evaluate((src) => {
    const re = new RegExp(src, "i");
    return [...document.querySelectorAll<HTMLButtonElement>("button.cam-add-btn")]
      .filter((b) => re.test(b.textContent ?? ""))
      .map((b) => getComputedStyle(b).display !== "none");
  }, label.source);
}

async function openCamTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    const t = [...document.querySelectorAll(".rtab")].find((x) => /Toolpaths/i.test(x.textContent ?? ""));
    (t as HTMLElement | undefined)?.click();
  });
}

/** A sign: outline + two holes to cut, a fold to score, a hidden draft layer. */
const SIGN = {
  machineKind: "laser",
  layers: [
    {
      id: "l-cut",
      name: "Cut",
      laser: { kind: "cut" as const, feedrate: 300, laserPower: 100, laserPasses: 2, kerfWidth: 0.2 },
    },
    {
      id: "l-score",
      name: "Score",
      laser: { kind: "score" as const, feedrate: 1800, laserPower: 15, laserPasses: 1 },
    },
    {
      id: "l-draft",
      name: "Draft notes",
      visible: false,
      laser: { kind: "engrave" as const, feedrate: 1000, laserPower: 20, laserPasses: 1 },
    },
  ],
  shapes: [
    { kind: "rect" as const, id: "outline", layerId: "l-cut", a: [20, 20] as [number, number], b: [160, 100] as [number, number] },
    { kind: "circle" as const, id: "hole1", layerId: "l-cut", c: [35, 60] as [number, number], r: 4 },
    { kind: "circle" as const, id: "hole2", layerId: "l-cut", c: [145, 60] as [number, number], r: 4 },
    { kind: "line" as const, id: "fold", layerId: "l-score", a: [90, 20] as [number, number], b: [90, 100] as [number, number] },
    { kind: "line" as const, id: "note", layerId: "l-draft", a: [30, 110] as [number, number], b: [150, 110] as [number, number] },
  ],
};

test("a flat laser job builds from the layers, splits the kerf, and skips hidden layers", async ({
  page,
}) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);
  await loadDoc(page, SIGN);
  await openCamTab(page);

  await page.locator(".cam-from-layers-btn").click();

  // Three operations: the cut splits into holes + outline because a kerf is set,
  // plus the score. The hidden "Draft notes" layer contributes nothing.
  await expect(page.locator(".tp-op-item")).toHaveCount(3);

  const ops = await page.evaluate(() =>
    (
      window as unknown as {
        __app: { doc: { operations: { name: string; type: string; side: string; entityIds: string[] }[] } };
      }
    ).__app.doc.operations.map((o) => ({ name: o.name, type: o.type, side: o.side, ids: o.entityIds })),
  );
  expect(ops.map((o) => o.name)).toEqual(["Cut (holes)", "Cut", "Score"]);
  // The kind drives the operation TYPE, not just the name — a score built as a
  // profile would be kerf-compensated and closed instead of a centreline pass.
  expect(ops.map((o) => o.type)).toEqual(["profile", "profile", "score"]);
  // Holes first, compensated inward; the outline outward. Cutting both the same
  // way leaves every hole a full kerf oversize.
  expect(ops[0].side).toBe("inside");
  expect(ops[0].ids.sort()).toEqual(["hole1", "hole2"]);
  expect(ops[1].side).toBe("outside");
  expect(ops[1].ids).toEqual(["outline"]);

  // The user is told what was left out, by name.
  await expect(page.locator('[role="status"]')).toContainText(/hidden/i);
  await expect(page.locator('[role="status"]')).toContainText("Draft notes");
});

test("each layer's power and feed reach the posted program", async ({ page }) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);
  await loadDoc(page, SIGN);
  await openCamTab(page);
  await page.locator(".cam-from-layers-btn").click();
  await expect(page.locator(".tp-op-item")).toHaveCount(3);

  const g = await page.evaluate(async () => {
    const doc = (window as unknown as { __app: { doc: unknown } }).__app.doc;
    const { generateGCode } = await import("/src/cam/gcode.ts" as string);
    return generateGCode(
      (doc as { operations: unknown[] }).operations,
      doc,
      {},
    ) as unknown as string;
  });

  // Cut at 100% / 300mm/min, score at 15% / 1800 — both present, from the layers.
  expect(g).toContain("S1000");
  expect(g).toContain("S150");
  expect(g).toMatch(/F300\b/);
  expect(g).toMatch(/F1800\b/);
  // The hidden layer's 20% is absent — paired with the positives above, so this
  // means "not cut" rather than "nothing was generated".
  expect(g).not.toContain("S200");
  expect(g).toContain("M30");
});

test("re-tuning a layer after building re-tunes the program, without rebuilding", async ({
  page,
}) => {
  // The point of the recipe being LIVE. Building copies the numbers onto each
  // operation, so a program can look right even with resolution broken — which
  // is exactly what happened: removing resolveOpLaser from the generator left
  // the test above passing. This drives the path the copy masks.
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);
  await loadDoc(page, SIGN);
  await openCamTab(page);
  await page.locator(".cam-from-layers-btn").click();
  await expect(page.locator(".tp-op-item")).toHaveCount(3);

  const post = async () =>
    page.evaluate(async () => {
      const doc = (window as unknown as { __app: { doc: unknown } }).__app.doc;
      const { generateGCode } = await import("/src/cam/gcode.ts" as string);
      return generateGCode((doc as { operations: unknown[] }).operations, doc, {}) as string;
    });

  expect(await post()).toContain("S150"); // control: the score's 15% is in there

  // The user runs a test cut and drops the score to 8%. No rebuild.
  await page.evaluate(() => {
    const doc = (
      window as unknown as {
        __app: { doc: { layers: { id: string; laser?: { laserPower: number } }[]; emitChange(): void } };
      }
    ).__app.doc;
    const score = doc.layers.find((l) => l.id === "l-score");
    if (!score?.laser) throw new Error("score layer has no recipe");
    score.laser.laserPower = 8;
    doc.emitChange();
  });

  const after = await post();
  expect(after).toContain("S80"); // 8% of the 1000 default max
  expect(after).not.toContain("S150");
  // And the CAM list shows the new number, attributed to the layer it came from.
  await expect(page.locator(".tp-op-item", { hasText: "Score" })).toContainText("8%");
  await expect(page.locator(".tp-op-item", { hasText: "Score" })).toContainText("⚡Score");
});

test("a rotary laser job wraps with its per-layer settings intact", async ({ page }) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);
  await loadDoc(page, {
    machineKind: "laser-rotary",
    rotary: { diameter: 80, wrapAxis: "y", zero: "surface" },
    layers: [
      {
        id: "l-eng",
        name: "Engrave",
        laser: { kind: "engrave", feedrate: 1200, laserPower: 35, laserPasses: 1 },
      },
      {
        id: "l-cut",
        name: "Cut",
        laser: { kind: "cut", feedrate: 400, laserPower: 100, laserPasses: 2 },
      },
    ],
    shapes: [
      { kind: "line", id: "band", layerId: "l-eng", a: [10, 20], b: [200, 20] },
      { kind: "rect", id: "ring", layerId: "l-cut", a: [10, 40], b: [200, 70] },
    ],
  });
  await openCamTab(page);

  // A rotary laser is still a laser: the action is offered.
  expect(await btnShown(page, /Toolpaths from Layers/)).toEqual([true]);
  await page.locator(".cam-from-layers-btn").click();
  await expect(page.locator(".tp-op-item")).toHaveCount(2);

  // Export a rotary document through the path the export button uses — the
  // wrap lives there, not in generateGCode.
  const prog = await page.evaluate(async () => {
    const doc = (window as unknown as { __app: { doc: unknown } }).__app.doc;
    const { generateRotaryProgram } = await import("/src/cam/klein.ts" as string);
    return generateRotaryProgram(doc, {}) as unknown as { program: string; warnings: string[] };
  });

  expect(prog.warnings).toEqual([]);
  expect(prog.program).toContain("Rotary");
  expect(prog.program.toLowerCase()).toContain("cylinder dia");
  // Both layers survive the wrap at their own settings.
  expect(prog.program).toContain("S350");
  expect(prog.program).toContain("S1000");
  expect(prog.program).toMatch(/F1200\b/);
  expect(prog.program).toMatch(/F400\b/);
  // A laser rotary SUBSTITUTES the wrapped axis (GRBL has no 4th axis), so the
  // program carries no A word — and no laser program ever moves in Z.
  expect(prog.program).not.toMatch(/(^|\s)A-?\d/m);
  for (const line of prog.program.split("\n"))
    expect(line, `Z move in a laser program: ${line}`).not.toMatch(/^G[0-3].*\sZ-?\d/);
});

test("each machine kind offers only the actions that work on it", async ({ page }) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);

  const survey = async () => ({
    fromLayers: await btnShown(page, /Toolpaths from Layers/),
    tile: await btnShown(page, /Tile/),
    twoSided: await btnShown(page, /Two-sided/),
    materialTest: await btnShown(page, /Material Test/),
    manageTools: await btnShown(page, /Manage Tools/),
    beam: await page.locator("#layersbar .layer-beam-toggle").count(),
  });

  const oneLayer = [{ id: "l", name: "L" }];
  const oneShape: Shape[] = [
    { kind: "rect", id: "r", layerId: "l", a: [0, 0], b: [50, 50] },
  ];

  await loadDoc(page, { machineKind: "mill", layers: oneLayer, shapes: oneShape });
  await openCamTab(page);
  const mill = await survey();
  expect(mill.fromLayers).toEqual([false]);
  expect(mill.beam).toBe(0);
  expect(mill.manageTools).toEqual([true]);
  expect(mill.materialTest).toEqual([false]);
  // Tile and Two-sided need a flat mill — this is where they belong.
  expect(mill.tile).toEqual([true]);
  expect(mill.twoSided).toEqual([true]);

  await loadDoc(page, { machineKind: "laser", layers: oneLayer, shapes: oneShape });
  const laser = await survey();
  expect(laser.fromLayers).toEqual([true]);
  expect(laser.beam).toBe(1);
  expect(laser.manageTools).toEqual([false]); // a beam has no tool library
  expect(laser.materialTest).toEqual([true]);
  // Both refuse with a toast unless the machine is a flat mill, so offering
  // them here was an enabled button that never worked.
  expect(laser.tile).toEqual([false]);
  expect(laser.twoSided).toEqual([false]);

  await loadDoc(page, {
    machineKind: "mill-rotary",
    rotary: { diameter: 50, wrapAxis: "y", zero: "surface" },
    layers: oneLayer,
    shapes: oneShape,
  });
  const millRotary = await survey();
  expect(millRotary.fromLayers).toEqual([false]); // not a laser
  expect(millRotary.beam).toBe(0);
  expect(millRotary.tile).toEqual([false]);
  expect(millRotary.twoSided).toEqual([false]);
});
