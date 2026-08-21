import { expect, test, waitForApp } from "./appFixture";

/**
 * End-to-end shakedown: one continuous session touching everything changed this
 * week — solver partitioning, .rcam v3, the settings split, sheet-from-stock,
 * and the hover render skip. Each step logs, so a break is obvious.
 */
test("a full workflow: draw, dimension, toolpath, export, save, reopen", async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });

  await page.setViewportSize({ width: 1500, height: 950 });
  await page.goto("/"); await waitForApp(page);
  await page.locator(".welcome-backdrop .welcome-card", { hasText: "New Project" }).click();
  const npd = page.locator("#npd-backdrop");
  await expect(npd).toBeVisible();
  await npd.getByRole("button", { name: "Create Project" }).click();
  await expect(npd).toHaveCount(0);
  console.log("STEP 1 new project: ok");

  // --- draw a rectangle with the REAL tool, by mouse -----------------------
  const rectBtn = page.locator(".tool-btn, .tbtn", { hasText: /^R$|Rect/i }).first();
  if (await rectBtn.count()) await rectBtn.click();
  else await page.keyboard.press("r");
  const cv = page.locator("canvas").first();
  const box = (await cv.boundingBox())!;
  await page.mouse.move(box.x + 300, box.y + 300);
  await page.mouse.down(); await page.mouse.up();
  await page.mouse.move(box.x + 600, box.y + 480);
  await page.mouse.down(); await page.mouse.up();
  await page.keyboard.press("Escape");
  // The rect tool must actually have produced geometry — the rest of the
  // workflow is meaningless if this silently drew nothing.
  const drawn = await page.evaluate(() => {
    const app = (window as any).__app;
    return app.doc.entities.filter((e: any) => e.type === "rectangle").length;
  });
  expect(drawn, "the rectangle tool drew nothing").toBe(1);

  // --- dimension it and drive the value ------------------------------------
  const dimResult = await page.evaluate(() => {
    const app = (window as any).__app;
    const r = app.doc.entities.find((e: any) => e.type === "rectangle");
    if (!r) return { ok: false, reason: "no rectangle drawn" };
    const before = Math.abs(r.p1.x - r.p0.x);
    const d = app.doc.snapshot();
    d.dimensions.push({ id: "dW", type: "horizontal", entities: [],
      points: [{ entityId: r.id, key: "bl" }, { entityId: r.id, key: "tr" }],
      value: 150, offset: 12, driving: true });
    app.doc.restore(d);
    app.runSolve();
    const after = app.doc.entities.find((e: any) => e.type === "rectangle");
    return { ok: true, before: +before.toFixed(1), after: +Math.abs(after.p1.x - after.p0.x).toFixed(2) };
  });
  if (dimResult.ok) expect(dimResult.after).toBeCloseTo(150, 1);

  // --- CAM: add a toolpath through the dialog ------------------------------
  await page.evaluate(() => {
    const app = (window as any).__app;
    for (const e of app.doc.entities) e.selected = e.type === "rectangle";
    app.doc.emitChange();
  });
  await page.locator(".rtab", { hasText: "Toolpaths" }).click();
  await page.locator(".cam-add-btn", { hasText: "+ Add Toolpath" }).click();
  const dlg = page.locator(".tp-dialog");
  await expect(dlg).toBeVisible();
  await dlg.locator('[data-testid="op-type-select"]').selectOption({ value: "profile-outside" });
  await dlg.locator("button.tp-apply-btn").click();
  await expect(dlg).toHaveCount(0);
  const ops = await page.evaluate(() => (window as any).__app.doc.operations.length);
  expect(ops).toBeGreaterThan(0);

  // --- export: the pre-flight / export preview -----------------------------
  await page.locator(".cam-gen-btn").click();
  const backdrop = page.locator(".tp-backdrop").first();
  await expect(backdrop).toBeVisible({ timeout: 20_000 });
  const preflight = (await backdrop.innerText()).replace(/\s+/g, " ");
  // The preview must show a real program summary, and the linter must have
  // actually looked: this geometry IS partly off the blank (the rectangle is
  // drawn at arbitrary screen coords, then driven to 150mm), so a clean
  // pre-flight here would mean the checks never ran.
  expect(preflight).toMatch(/Export preview/);
  expect(preflight).toMatch(/toolpath/);
  expect(preflight).toMatch(/outside the stock/);
  const cancel = backdrop.locator("button", { hasText: /Cancel/i }).first();
  if (await cancel.count()) await cancel.click();
  else await page.keyboard.press("Escape");

  // --- save to .rcam and reopen it -----------------------------------------
  const round = await page.evaluate(async () => {
    const app = (window as any).__app;
    const io = await import("/src/io/fileio.ts" as string);
    const file = io.serializeDoc(app.doc, "shakedown");
    const text = JSON.stringify(file);
    const before = { v: file.version, ents: app.doc.entities.length,
      ops: app.doc.operations.length, dims: app.doc.dimensions.length };
    const reparsed = io.parseRcam(text);
    io.applyFile(app.doc, reparsed);
    app.doc.emitChange();
    return { before, after: { v: reparsed.version, ents: app.doc.entities.length,
      ops: app.doc.operations.length, dims: app.doc.dimensions.length },
      carriesMachine: "postProcessor" in reparsed || "hasToolChanger" in reparsed };
  });
  expect(round.after).toEqual(round.before);
  expect(round.carriesMachine).toBe(false);

  expect(errors).toEqual([]);
});
