import { test, expect, waitForApp } from "../e2e/appFixture";

/**
 * What the Design Tree costs when it is open.
 *
 * The panel rebuilds its whole DOM on every document change. That is coalesced
 * onto an animation frame and skipped entirely while closed, but a solve runs on
 * every frame of a drag, so an OPEN panel on a big document rebuilds hundreds of
 * rows per frame. This repo has already fought a hard ~500-entity interaction
 * ceiling once (see the solver partitioning work), so "probably fine" is not an
 * answer — measure the real drag, panel closed vs open, and compare.
 *
 * Run:  npx playwright test scripts/design-tree-probe.e2e.ts --reporter=list
 */
function plate(holes: number) {
  const cols = Math.ceil(Math.sqrt(holes));
  const pitch = 12;
  const W = cols * pitch + 40;
  const H = Math.ceil(holes / cols) * pitch + 40;
  const entities: any[] = [];
  for (let i = 0; i < holes; i++) {
    const cx = 20 + (i % cols) * pitch;
    const cy = 20 + Math.floor(i / cols) * pitch;
    entities.push({
      type: "circle",
      id: `h${i}`,
      center: { x: cx, y: cy },
      radius: 4,
      selected: false,
      isConstruction: false,
      layerId: "layer-0",
    });
  }
  return {
    canvas: { width: W, height: H },
    displayUnit: "mm",
    stockThickness: 6,
    entities,
    constraints: [],
    dimensions: [],
    groups: [],
    features: [],
    layers: [{ id: "layer-0", name: "L", color: "#8ab4f8", visible: true, locked: false }],
    activeLayerId: "layer-0",
    tools: [],
    operations: [],
  };
}

/**
 * The case the panel's docstring actually worries about.
 *
 * A plain entity drag never calls `emitChange()` — selectTool translates, solves
 * and repaints — so it cannot make the tree rebuild at all. A SCALE drag does:
 * it restores a snapshot per pointer move, and `restore()` emits. This is the
 * only interaction that can force a rebuild-per-frame, so it is the one worth
 * measuring, and the mutation count proves the rebuilds really happened rather
 * than being coalesced away to nothing.
 */
for (const n of [500, 2000]) {
  test(`design tree open vs closed: SCALE drag on a ${n}-hole plate`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto("/");
    await waitForApp(page);
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

    // Count tree rebuilds without touching the source: the panel replaces the
    // body's children wholesale, so one childList mutation is one rebuild.
    await page.evaluate(() => {
      (window as any).__rebuilds = 0;
      const body = document.querySelector(".design-tree-body");
      if (!body) return;
      new MutationObserver((recs) => {
        for (const r of recs) if (r.type === "childList") (window as any).__rebuilds++;
      }).observe(body, { childList: true });
    });

    // Baseline geometry. Each scale drag GROWS the plate, so without restoring
    // this between runs the transform handle walks off-canvas and later drags
    // grab nothing at all — which reads as a spectacular speed-up.
    const baseline = await page.evaluate(() => JSON.stringify((window as any).__app.doc.snapshot()));

    /** Select everything, grab the transform box's top-right handle, scale it. */
    const scaleDrag = async (): Promise<{ ms: number; rebuilds: number }> => {
      const at = await page.evaluate((snapJson: string) => {
        const app = (window as any).__app;
        app.doc.restore(JSON.parse(snapJson));
        for (const e of app.doc.entities) e.selected = e.id !== "__origin__";
        app.doc.emitChange();
        const b = app.doc.bounds();
        const p = app.view.worldToScreen({ x: b.max.x, y: b.max.y });
        const r = (document.querySelector("canvas") as HTMLCanvasElement).getBoundingClientRect();
        (window as any).__rebuilds = 0;
        return { x: r.left + p.x, y: r.top + p.y };
      }, baseline);
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      const t0 = Date.now();
      for (let i = 1; i <= 10; i++) await page.mouse.move(at.x + i * 2, at.y + i * 2);
      const ms = (Date.now() - t0) / 10;
      await page.mouse.up();
      const rebuilds = await page.evaluate(() => (window as any).__rebuilds as number);
      return { ms, rebuilds };
    };

    const toggle = page.locator("#design-tree-toggle");
    const setPanel = async (open: boolean): Promise<void> => {
      await toggle.click();
      await expect
        .poll(async () => (await page.locator(".design-tree-panel").boundingBox())?.width ?? 0)
        .toBe(open ? 250 : 0);
    };

    await scaleDrag(); // warm up
    const closed = await scaleDrag();
    await setPanel(true);
    const open = await scaleDrag();

    console.log(
      `SCALE ${n} >> closed ${closed.ms.toFixed(0)}ms/move (${closed.rebuilds} rebuilds) · ` +
        `open ${open.ms.toFixed(0)}ms/move (${open.rebuilds} rebuilds) ` +
        `= ${(open.ms / closed.ms).toFixed(2)}×`,
    );
  });
}

for (const n of [500, 2000]) {
  test(`design tree open vs closed: drag on a ${n}-hole plate`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto("/");
    await waitForApp(page);
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

    const start = await page.evaluate(() => {
      const app = (window as any).__app;
      const h = app.doc.entities.find((e: any) => e.id === "h0");
      const p = app.view.worldToScreen(h.center);
      const cv = document.querySelector("canvas") as HTMLCanvasElement;
      const r = cv.getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    });

    /** Select hole 0, drag it 20 steps, return ms/move. */
    const dragOnce = async (): Promise<number> => {
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.up();
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      const t0 = Date.now();
      for (let i = 1; i <= 20; i++) await page.mouse.move(start.x + i * 2, start.y + i);
      const ms = (Date.now() - t0) / 20;
      await page.mouse.up();
      // Put it back so the second run starts from the same place.
      await page.evaluate((p: { x: number; y: number }) => {
        const app = (window as any).__app;
        const h = app.doc.entities.find((e: any) => e.id === "h0");
        h.center = { ...p };
        app.doc.clearSelection();
        app.doc.emitChange();
      }, { x: 20, y: 20 });
      return ms;
    };

    const toggle = page.locator("#design-tree-toggle");
    const setPanel = async (open: boolean): Promise<void> => {
      await toggle.click();
      await expect
        .poll(async () => (await page.locator(".design-tree-panel").boundingBox())?.width ?? 0)
        .toBe(open ? 250 : 0);
    };

    // One throwaway drag first. The very first drag of a session pays JIT and
    // first-paint costs big enough to swamp the thing being measured — without
    // this the probe reported the OPEN panel as nearly twice as FAST as the
    // closed one, purely because closed happened to run first.
    await dragOnce();

    // Alternate conditions and take the median of three, so any residual drift
    // (GC, thermal) lands on both rather than on whichever went first.
    const closed: number[] = [];
    const open: number[] = [];
    for (let i = 0; i < 3; i++) {
      closed.push(await dragOnce());
      await setPanel(true);
      open.push(await dragOnce());
      await setPanel(false);
    }
    const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[1];

    await setPanel(true);
    const rows = await page.locator(".design-tree-body .tree-row").count();
    await setPanel(false);

    const c = median(closed);
    const o = median(open);
    console.log(
      `TREE ${n} >> closed ${c.toFixed(0)}ms/move · open ${o.toFixed(0)}ms/move ` +
        `(${(o / c).toFixed(2)}× , ${rows} rows) closed=[${closed.map((x) => x.toFixed(0))}] ` +
        `open=[${open.map((x) => x.toFixed(0))}]`,
    );
  });
}
