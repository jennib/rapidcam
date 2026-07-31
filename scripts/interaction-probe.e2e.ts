import { test, expect, waitForApp } from "./appFixture";

/** Perforated plate: every hole pinned except hole 0, which stays draggable. */
function plate(holes: number) {
  const cols = Math.ceil(Math.sqrt(holes)), pitch = 12;
  const W = cols * pitch + 40, H = Math.ceil(holes / cols) * pitch + 40;
  const entities: any[] = [];
  const constraints: any[] = [];
  for (let i = 0; i < holes; i++) {
    const cx = 20 + (i % cols) * pitch, cy = 20 + Math.floor(i / cols) * pitch;
    entities.push({ type: "circle", id: `h${i}`, center: { x: cx, y: cy }, radius: 4,
      selected: false, isConstruction: false, layerId: "layer-0" });
    if (i > 0) constraints.push({ id: `c${i}`, type: "fixedPoint", entities: [],
      points: [{ entityId: `h${i}`, key: "c" }], params: [cx, cy] });
  }
  return { canvas: { width: W, height: H }, displayUnit: "mm", stockThickness: 6, entities, constraints,
    dimensions: [], groups: [], features: [],
    layers: [{ id: "layer-0", name: "L", color: "#8ab4f8", visible: true, locked: false }],
    activeLayerId: "layer-0", tools: [], operations: [] };
}

for (const n of [500, 2000]) {
  test(`real mouse drag on a ${n}-hole plate`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto("/"); await waitForApp(page);
    await page.locator(".welcome-backdrop .welcome-card", { hasText: "New Project" }).click();
    const npd = page.locator("#npd-backdrop");
    await npd.getByRole("button", { name: "Create Project" }).click();
    await expect(npd).toHaveCount(0);

    await page.evaluate((s: any) => {
      const app = (window as any).__app;
      app.doc.restore({ ...app.doc.snapshot(), ...s });
      app.doc.emitChange();
      app.fitView?.();
    }, plate(n));
    await page.waitForTimeout(400);

    // Screen position of hole 0, and start counting frames.
    const start = await page.evaluate(() => {
      const app = (window as any).__app;
      const h = app.doc.entities.find((e: any) => e.id === "h0");
      const p = app.view.worldToScreen(h.center);
      const cv = document.querySelector("canvas") as HTMLCanvasElement;
      const r = cv.getBoundingClientRect();
      (window as any).__frames = 0;
      const tick = () => { (window as any).__frames++; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      return { x: r.left + p.x, y: r.top + p.y };
    });

    // Select it first, then drag — a click-to-select model means a bare
    // press-and-move is a rubber band, not a grab.
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.up();
    const selected = await page.evaluate(() => (window as any).__app.doc.selected.length);
    console.log(`  selected after click: ${selected}`);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    const t0 = Date.now();
    const MOVES = 20;
    for (let i = 1; i <= MOVES; i++) await page.mouse.move(start.x + i * 2, start.y + i);
    const elapsed = Date.now() - t0;
    await page.mouse.up();

    const frames = await page.evaluate(() => (window as any).__frames as number);
    const moved = await page.evaluate(() => {
      const h = (window as any).__app.doc.entities.find((e: any) => e.id === "h0");
      return { x: +h.center.x.toFixed(2), y: +h.center.y.toFixed(2) };
    });
    console.log(`FEEL ${n} >> ${MOVES} moves in ${elapsed}ms = ${(elapsed / MOVES).toFixed(0)}ms/move, ~${(1000 / (elapsed / MOVES)).toFixed(0)}fps, frames=${frames}, hole0=${JSON.stringify(moved)}`);
  });
}
