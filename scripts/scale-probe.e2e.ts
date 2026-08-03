import { test, expect, waitForApp } from "../e2e/appFixture";

/**
 * Scale probe. Generates a realistic complex part — a perforated mounting plate
 * with a drilled hole grid, each hole's centre pinned by a constraint — and times
 * the things a user actually feels.
 */

/** Plain-JSON snapshot: plate + N pinned holes + a drill op and an outside profile. */
function bigPlate(holes: number) {
  const cols = Math.ceil(Math.sqrt(holes));
  const pitch = 12;
  const W = cols * pitch + 40;
  const H = Math.ceil(holes / cols) * pitch + 40;
  const entities: any[] = [
    { type: "rectangle", id: "plate", p0: { x: 0, y: 0 }, p1: { x: W, y: H },
      selected: false, isConstruction: false, layerId: "layer-0" },
  ];
  const constraints: any[] = [];
  const ids: string[] = [];
  for (let i = 0; i < holes; i++) {
    const cx = 20 + (i % cols) * pitch;
    const cy = 20 + Math.floor(i / cols) * pitch;
    const id = `h${i}`;
    ids.push(id);
    entities.push({ type: "circle", id, center: { x: cx, y: cy }, radius: 2.5,
      selected: false, isConstruction: false, layerId: "layer-0" });
    // Drilled positions are defined, so pin each centre — realistic, and it is
    // what actually loads the solver.
    constraints.push({ id: `c${i}`, type: "fixedPoint", entities: [],
      points: [{ entityId: id, key: "c" }], params: [cx, cy] });
  }
  const op = (o: any) => ({ toolType: "end-mill", toolNumber: 1, diameter: 4, feedrate: 900,
    plungeRate: 250, spindleSpeed: 18000, safeZ: 5, depth: -6, stepdown: 3, stepover: 0.4, ...o });
  return {
    canvas: { width: W, height: H }, displayUnit: "mm", stockThickness: 6,
    entities, constraints, dimensions: [], groups: [], features: [],
    layers: [{ id: "layer-0", name: "Layer 1", color: "#8ab4f8", visible: true, locked: false }],
    activeLayerId: "layer-0", tools: [],
    operations: [
      op({ id: "drill", name: "holes", type: "drill", side: "outside", entityIds: ids, diameter: 5 }),
      op({ id: "prof", name: "outline", type: "profile", side: "outside", entityIds: ["plate"] }),
    ],
  };
}

for (const holes of [100, 500, 2000]) {
  test(`scale probe: ${holes} holes`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto("/");
    await waitForApp(page);
    await page.locator(".welcome-backdrop .welcome-card", { hasText: "New Project" }).click();
    const npd = page.locator("#npd-backdrop");
    await npd.getByRole("button", { name: "Create Project" }).click();
    await expect(npd).toHaveCount(0);

    const snap = bigPlate(holes);
    const m = await page.evaluate(async (s: any) => {
      const app = (window as any).__app;
      const t = (fn: () => unknown) => { const a = performance.now(); fn(); return +(performance.now() - a).toFixed(1); };
      const base = app.doc.snapshot();
      const merged = { ...base, ...s };

      const load = t(() => { app.doc.restore(merged); app.doc.emitChange(); });

      // One frame, measured after a change — what a redraw costs.
      const frame = await new Promise<number>((res) => {
        const a = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => res(+(performance.now() - a).toFixed(1))));
      });

      // Drag one hole: the edit a user makes constantly.
      const first = app.doc.entities.find((e: any) => e.type === "circle");
      const solve = t(() => { first.center.x += 0.5; app.runSolve?.(); });

      const g = await import("/src/cam/gcode.ts" as string);
      let gcode = "";
      const post = t(() => { gcode = g.generateGCode(app.doc.operations, app.doc, {}); });

      const r = await import("/src/cam/stockRasterizer.ts" as string);
      let preview = -1;
      try { preview = t(() => r.rasterizeStock(app.doc.operations, app.doc)); } catch { preview = -1; }

      return { entities: app.doc.entities.length, constraints: app.doc.constraints.length,
               load, frame, solve, post, preview, gcodeKB: Math.round(gcode.length / 1024) };
    }, snap);
    console.log(`SCALE ${holes} >> ${JSON.stringify(m)}`);
  });
}
