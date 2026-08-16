/* biome-ignore-all lint/suspicious/noExplicitAny: reads untyped app internals */
import { test, expect, waitForApp, APP_URL } from "./appFixture";

/**
 * A feature you just inserted can be dragged.
 *
 * Reported as "cannot drag an inserted finger-joint box". Grouping was never the
 * problem — clicking selects all 9 entities correctly. The drag was REFUSED.
 *
 * `SolveCoordinator.dof` is read straight off the solver's last result, and the
 * generator dialog was the one commit path that never re-solved. So on a new
 * project the last result still described the empty document — `variables = 0`,
 * therefore `dof = 0` — and SelectTool's drag gate reported "Fully constrained —
 * edit a dimension or remove a constraint" on a document with NO constraints.
 *
 * Measured before the fix: dof 0, 0 of 9 entities moved; after a forced solve,
 * dof 136 and all 9 moved together. This drives the real Insert menu, because
 * calling `runGenerator` directly bypasses the very path that was broken.
 */
test("insert a box from the menu, then drag it", async ({ page }) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await page.locator(".welcome-backdrop .welcome-card", { hasText: "New Project" }).click();
  await page.locator("#npd-backdrop .tp-apply-btn").click();

  await page.getByRole("button", { name: "Insert" }).click();
  const item = page.locator(".fmenu-item", { hasText: /^Finger-Joint Box/ });
  await expect(item).toBeVisible();
  await item.click();
  const dialog = page.locator(".tp-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator(".tp-apply-btn").click();

  const state = await page.evaluate(() => {
    const app = (window as any).__app;
    return {
      entities: app.doc.entities.filter((e: any) => e.id !== "__origin__").length,
      dof: app.currentDof(),
      constraints: app.doc.constraints.length,
    };
  });
  console.log("AFTER INSERT:", JSON.stringify(state));
  expect(state.entities).toBeGreaterThan(1);
  // The regression, stated directly: a document with no constraints must not
  // report zero freedom. dof === 0 here is what made the box immovable.
  expect(state.dof, "the insert must re-solve, or the drag gate reads a stale result")
    .toBeGreaterThan(0);

  // Now actually drag it, from a point on real geometry.
  const grab = await page.evaluate(() => {
    const app = (window as any).__app;
    const e = app.doc.entities.find((x: any) => x.id !== "__origin__");
    const b = e.bounds();
    const p = { x: (b.min.x + b.max.x) / 2, y: b.min.y };
    const s = app.view.worldToScreen(p);
    const r = document.querySelector("canvas")!.getBoundingClientRect();
    return { x: s.x + r.left, y: s.y + r.top };
  });
  const before = await page.evaluate(() =>
    (window as any).__app.doc.entities
      .filter((e: any) => e.id !== "__origin__")
      .map((e: any) => JSON.stringify(e.bounds())),
  );

  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(grab.x + i * 4, grab.y + i * 3);
    await page.waitForTimeout(12);
  }
  await page.mouse.up();

  const after = await page.evaluate(() =>
    (window as any).__app.doc.entities
      .filter((e: any) => e.id !== "__origin__")
      .map((e: any) => JSON.stringify(e.bounds())),
  );
  const moved = before.filter((b: string, i: number) => b !== after[i]).length;
  console.log(`MOVED: ${moved} of ${before.length}`);
  // The whole assembly travels together — that is what "it's one box" means.
  expect(moved).toBe(before.length);
});
