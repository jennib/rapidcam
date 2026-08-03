import { test, expect, waitForApp } from "../e2e/appFixture";

/**
 * The COUPLED case: a chain of lines joined end-to-end by coincident
 * constraints, so the whole sketch is ONE connected component by construction
 * and cannot be decomposed. This is the case that tells us whether partitioning
 * is the whole fix or only half of it.
 */
function chain(n: number) {
  const entities: any[] = [];
  const constraints: any[] = [];
  for (let i = 0; i < n; i++) {
    const x = i * 8;
    entities.push({ type: "line", id: `l${i}`, a: { x, y: 20 + (i % 2) * 6 },
      b: { x: x + 8, y: 20 + ((i + 1) % 2) * 6 }, selected: false, isConstruction: false, layerId: "layer-0" });
    if (i > 0) {
      constraints.push({ id: `k${i}`, type: "coincident", entities: [],
        points: [{ entityId: `l${i - 1}`, key: "b" }, { entityId: `l${i}`, key: "a" }] });
    }
  }
  // Pin one end so the chain isn't free-floating — realistic and typical.
  constraints.push({ id: "pin", type: "fixedPoint", entities: [],
    points: [{ entityId: "l0", key: "a" }], params: [0, 20] });
  return { canvas: { width: n * 8 + 40, height: 120 }, displayUnit: "mm", stockThickness: 6,
    entities, constraints, dimensions: [], groups: [], features: [],
    layers: [{ id: "layer-0", name: "Layer 1", color: "#8ab4f8", visible: true, locked: false }],
    activeLayerId: "layer-0", tools: [], operations: [] };
}

for (const n of [25, 50, 100, 200]) {
  test(`coupled chain: ${n} lines`, async ({ page }) => {
    test.setTimeout(600_000);
    await page.goto("/");
    await waitForApp(page);
    await page.locator(".welcome-backdrop .welcome-card", { hasText: "New Project" }).click();
    const npd = page.locator("#npd-backdrop");
    await npd.getByRole("button", { name: "Create Project" }).click();
    await expect(npd).toHaveCount(0);

    const m = await page.evaluate(async (s: any) => {
      const app = (window as any).__app;
      const base = app.doc.snapshot();
      app.doc.restore({ ...base, ...s });
      app.doc.emitChange();
      const first = app.doc.entities.find((e: any) => e.type === "line");
      const t0 = performance.now();
      first.a.x += 0.5;
      app.runSolve?.();
      const solve = +(performance.now() - t0).toFixed(1);
      return { entities: app.doc.entities.length, constraints: app.doc.constraints.length, solve };
    }, chain(n));
    console.log(`COUPLED ${n} >> ${JSON.stringify(m)}`);
  });
}
