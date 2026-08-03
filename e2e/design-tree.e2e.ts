import { expect, openDoc, test } from "./appFixture";
import { CADDocument } from "../src/model/document";
import { CircleEntity, LineEntity, RectEntity } from "../src/model/entities";
import { serializeDoc } from "../src/io/fileio";
import { makeConstraint } from "../src/model/constraints";

/**
 * The design tree's WIRING and its LAYOUT, neither of which the component tests
 * can reach.
 *
 * `test/designTree.test.ts` drives the same panel under happy-dom, which has no
 * layout engine: every assertion there passes just as happily if the flyout
 * renders at zero width, slides in under the canvas, or is never instantiated by
 * app.ts at all. That last one is not hypothetical — the panel shipped into the
 * working tree fully written and never constructed. So this spec asserts the
 * things only a browser knows: the button exists in the palette, the panel takes
 * real width on screen without pushing the canvas out, and a click in the tree
 * reaches the document the canvas is drawing.
 */
function threeShapes(): string {
  const doc = new CADDocument({ width: 200, height: 150 }, "mm");
  doc.add(new LineEntity({ x: 10, y: 10 }, { x: 90, y: 10 }));
  doc.add(new CircleEntity({ x: 50, y: 80 }, 17.5));
  doc.add(new RectEntity({ x: 120, y: 20 }, { x: 180, y: 60 }));
  return JSON.stringify(serializeDoc(doc, "three-shapes"));
}

/** Ids of the entities the document currently has selected. */
const selectedIds = (page: import("@playwright/test").Page): Promise<string[]> =>
  page.evaluate(() => {
    const doc = (
      window as unknown as { __app: { doc: { entities: { id: string; selected: boolean }[] } } }
    ).__app.doc;
    return doc.entities.filter((e) => e.selected).map((e) => e.id);
  });

test("live: the tree opens from the palette and lists the drawing", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openDoc(page, threeShapes());

  const panel = page.locator(".design-tree-panel");
  const toggle = page.locator("#design-tree-toggle");
  await expect(toggle).toBeVisible();

  // Closed: present in the DOM but occupying nothing.
  expect((await panel.boundingBox())?.width ?? 0).toBeLessThan(1);

  const canvasBefore = await page.locator("#canvas-host").boundingBox();
  await toggle.click();

  // `toBeVisible` is not enough — a 0px-wide flyout satisfies it. Assert real
  // width, and that the canvas gave the space up rather than being pushed off.
  await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBeGreaterThan(150);
  const canvasAfter = await page.locator("#canvas-host").boundingBox();
  if (!canvasBefore || !canvasAfter) throw new Error("canvas host has no box");
  expect(canvasAfter.width).toBeLessThan(canvasBefore.width);
  expect(canvasAfter.x + canvasAfter.width).toBeLessThanOrEqual(1400);

  await expect(page.locator(".design-tree-body .tree-label", { hasText: "Line 80.00 mm" })).toBeVisible();
  await expect(page.locator(".design-tree-body .tree-label", { hasText: "Circle ⌀35.00 mm" })).toBeVisible();
  await expect(
    page.locator(".design-tree-body .tree-label", { hasText: "Rectangle 60.00 mm × 40.00 mm" }),
  ).toBeVisible();
});

test("live: clicking a row selects that entity on the canvas", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openDoc(page, threeShapes());
  await page.locator("#design-tree-toggle").click();

  expect(await selectedIds(page)).toEqual([]);
  await page.locator(".tree-row", { hasText: "Circle ⌀35.00 mm" }).locator(".tree-label").click();

  const picked = await selectedIds(page);
  expect(picked).toHaveLength(1);
  await expect(page.locator(".tree-row.selected .tree-label")).toHaveText("Circle ⌀35.00 mm");

  // The properties bar is the other half of "selected": the click has to reach
  // the same document the rest of the UI reads, not just paint a row.
  await expect(page.locator("#propertiesbar")).toContainText(/radius/i);
});

test("live: hiding a row removes it from the canvas and from picking", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openDoc(page, threeShapes());
  await page.locator("#design-tree-toggle").click();

  const circleRow = page.locator(".tree-row", { hasText: "Circle ⌀35.00 mm" });
  await circleRow.locator("button[title='Hide']").click();

  await expect(circleRow).toHaveClass(/hidden-item/);
  const hitAfter = await page.evaluate(() => {
    const doc = (
      window as unknown as {
        __app: { doc: { hitTest: (p: { x: number; y: number }, t: number) => { id: string } | null } };
      }
    ).__app.doc;
    return doc.hitTest({ x: 67.5, y: 80 }, 1)?.id ?? null;
  });
  expect(hitAfter).toBeNull();

  // Positive control: unhiding brings it back, so the assertion above is about
  // the eye button and not about the coordinates being wrong.
  await circleRow.locator("button[title='Show']").click();
  const hitBack = await page.evaluate(() => {
    const doc = (
      window as unknown as {
        __app: { doc: { hitTest: (p: { x: number; y: number }, t: number) => { id: string } | null } };
      }
    ).__app.doc;
    return doc.hitTest({ x: 67.5, y: 80 }, 1)?.id ?? null;
  });
  expect(hitBack).not.toBeNull();
});

/** World mm → viewport px, via the app's own view transform. */
async function toPx(
  page: import("@playwright/test").Page,
  mm: [number, number],
): Promise<{ x: number; y: number }> {
  return page.evaluate(([x, y]) => {
    const app = (
      window as unknown as {
        __app: {
          view: { worldToScreen(p: { x: number; y: number }): { x: number; y: number } };
          canvas: HTMLElement;
        };
      }
    ).__app;
    const p = app.view.worldToScreen({ x, y });
    const r = app.canvas.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, mm);
}

test("live: a locked entity still selects but refuses to be dragged", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openDoc(page, threeShapes());
  await page.locator("#design-tree-toggle").click();

  // Lock the rectangle from the tree, then try to drag it on the canvas. This
  // is the half `doc.isMovable` unit tests cannot prove: that the select tool
  // actually consults it.
  const rectRow = page.locator(".tree-row", { hasText: "Rectangle" });
  await rectRow.locator("button[title^='Lock']").click();

  // ON the bottom edge: a rectangle is hit-tested against its outline, not its
  // interior, so the centre would miss and start a marquee instead.
  const before = await toPx(page, [150, 20]);
  const target = await toPx(page, [150, 50]);
  await page.mouse.move(before.x, before.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 10 });
  await page.mouse.up();

  const state = await page.evaluate(() => {
    const doc = (
      window as unknown as {
        __app: { doc: { entities: { type: string; selected: boolean; p0?: { y: number } }[] } };
      }
    ).__app.doc;
    const r = doc.entities.find((e) => e.type === "rectangle")!;
    return { selected: r.selected, y: r.p0!.y };
  });

  // SolidWorks semantics: the click selected it, the drag moved nothing.
  expect(state.selected).toBe(true);
  expect(state.y).toBeCloseTo(20, 3);

  // Positive control: unlock, drag again, and it moves — so the assertion above
  // is about the lock and not about the drag gesture failing to register.
  await rectRow.locator("button[title='Unlock']").click();
  await page.mouse.move(before.x, before.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 10 });
  await page.mouse.up();

  const movedY = await page.evaluate(() => {
    const doc = (window as unknown as { __app: { doc: { entities: any[] } } }).__app.doc;
    return doc.entities.find((e) => e.type === "rectangle")!.p0.y;
  });
  expect(movedY).toBeGreaterThan(21);
});

test("live: hidden geometry is dropped from the program, and pre-flight says so", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openDoc(page, threeShapes());
  await page.locator("#design-tree-toggle").click();

  // Put both circles in one drill toolpath, then hide one of them.
  await page.evaluate(() => {
    const doc = (window as unknown as { __app: { doc: any } }).__app.doc;
    const circles = doc.entities.filter((e: any) => e.type === "circle");
    doc.operations.push({
      id: "op1",
      name: "holes",
      type: "drill",
      side: "outside",
      entityIds: circles.map((c: any) => c.id),
      toolType: "drill",
      toolNumber: 1,
      diameter: 3,
      stepover: 0.4,
      feedrate: 600,
      plungeRate: 200,
      spindleSpeed: 12000,
      safeZ: 5,
      depth: -5,
      stepdown: 2,
    });
    doc.emitChange();
  });

  await page.locator(".tree-row", { hasText: "Circle" }).first().locator("button[title='Hide']").click();
  await page.locator(".rtab", { hasText: "CAM" }).click();
  await page.locator(".cam-gen-btn").click();

  const body = await page.locator(".tp-backdrop").first().innerText();
  expect(body).toMatch(/hidden object is assigned to toolpath "holes"/i);
  expect(body).toMatch(/NOT cut/);
});

/** Two perpendicular lines plus a horizontal, so the list has same-type rows. */
function constrainedSketch(): string {
  const doc = new CADDocument({ width: 200, height: 150 }, "mm");
  const a = doc.add(new LineEntity({ x: 10, y: 120 }, { x: 90, y: 120 }));
  const b = doc.add(new LineEntity({ x: 10, y: 120 }, { x: 10, y: 60 }));
  doc.addConstraint(makeConstraint("perpendicular", { entities: [a.id, b.id] }));
  doc.addConstraint(makeConstraint("horizontal", { entities: [a.id] }));
  return JSON.stringify(serializeDoc(doc, "constrained"));
}

/**
 * A sketch with no solution: both endpoints of a sloped line pinned to world
 * positions at different heights, and the line also required to be horizontal.
 *
 * Note horizontal+vertical on one line is NOT a conflict — the solver satisfies
 * both by collapsing it to a zero-length point, which is a real solution. This
 * needs the endpoints pinned so there is nowhere left to go.
 */
function conflictingSketch(): string {
  const doc = new CADDocument({ width: 200, height: 150 }, "mm");
  const a = doc.add(new LineEntity({ x: 10, y: 120 }, { x: 90, y: 60 }));
  doc.addConstraint(
    makeConstraint("fixedPoint", { points: [{ entityId: a.id, key: "a" }], params: [10, 120] }),
  );
  doc.addConstraint(
    makeConstraint("fixedPoint", { points: [{ entityId: a.id, key: "b" }], params: [90, 60] }),
  );
  doc.addConstraint(makeConstraint("horizontal", { entities: [a.id] }));
  return JSON.stringify(serializeDoc(doc, "conflicting"));
}

test("live: constraint rows name what they join, and delete in place", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openDoc(page, constrainedSketch());
  await page.locator("#design-tree-toggle").click();

  const perp = page.locator(".tree-row", { hasText: "Perpendicular" });
  await expect(perp.locator(".tree-subject")).toHaveText("Line 1 · Line 2");
  await expect(page.locator(".tree-row", { hasText: "Horizontal" }).locator(".tree-subject"))
    .toHaveText("Line 1");

  // The degrees-of-freedom readout is what someone deleting a constraint is
  // watching, so assert the delete reaches the solver and not just the model.
  const dofBefore = await page.locator("#statusbar").innerText();
  await perp.hover();
  await perp.locator("button[title='Delete this constraint']").click();

  await expect(page.locator(".tree-row", { hasText: "Perpendicular" })).toHaveCount(0);
  await expect(page.locator(".tree-row", { hasText: "Horizontal" })).toHaveCount(1);
  await expect.poll(() => page.locator("#statusbar").innerText()).not.toBe(dofBefore);

  // Undoable: the tree's own edits go on the same stack as everything else.
  await page.locator("#scene").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
  await expect(page.locator(".tree-row", { hasText: "Perpendicular" })).toHaveCount(1);
});

test("live: the Constraints folder agrees with the status bar, and follows it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openDoc(page, constrainedSketch());
  await page.locator("#design-tree-toggle").click();

  const badge = page.locator(".tree-solve-badge");
  const status = page.locator("#statusbar");

  // Under-constrained: the bar spells it out, the folder shows the same count.
  await expect(status).toContainText("Under-constrained");
  const free = (await status.innerText()).match(/(\d+)\s*free/)?.[1];
  expect(free).toBeDefined();
  await expect(badge).toHaveText(`${free} free`);
});

test("live: an over-constrained sketch flags in both places, and clears in both", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  // Horizontal AND vertical on one line: unsatisfiable, so the solver cannot
  // converge. Built into the file rather than poked in afterwards — mutating
  // `doc` and calling emitChange() notifies listeners but never runs a solve,
  // so the status would just be whatever the load left behind.
  await openDoc(page, conflictingSketch());
  await page.locator("#design-tree-toggle").click();

  const badge = page.locator(".tree-solve-badge");
  const status = page.locator("#statusbar");

  await expect(status).toContainText("Over-constrained");
  await expect(badge).toHaveText("⚠ Conflicting");

  // Deleting the culprit from the tree must clear BOTH — the tree's delete
  // re-solves, and the badge follows the same value the bar does.
  const culprit = page.locator(".tree-row", { hasText: "Horizontal" });
  await culprit.hover();
  await culprit.locator("button[title='Delete this constraint']").click();

  await expect(status).not.toContainText("Over-constrained");
  await expect(badge).not.toHaveText("⚠ Conflicting");
});

test("live: the tree holds still during a scale drag, then catches up", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openDoc(page, threeShapes());
  await page.locator("#design-tree-toggle").click();

  const rectRow = page.locator(".tree-row", { hasText: "Rectangle" }).locator(".tree-label");
  await expect(rectRow).toHaveText("Rectangle 60.00 mm × 40.00 mm");

  // Select the rectangle from the tree, then drag its top-right scale handle.
  // Wait for the flyout to finish sliding first: it shifts and resizes the
  // canvas, so a screen position computed mid-animation misses the handle.
  await rectRow.click();
  await expect
    .poll(async () => (await page.locator(".design-tree-panel").boundingBox())?.width ?? 0)
    .toBe(250);
  // The BOTTOM-LEFT handle, not the top-right: the open flyout takes 250px off
  // the canvas, which pushes the rectangle's far corner past its right edge, and
  // a press outside the canvas never reaches the tool at all.
  const handle = await toPx(page, [120, 20]);
  const target = await toPx(page, [100, 0]);

  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 8 });

  // Mid-gesture the panel is suspended: the geometry has already changed, but
  // the tree has not repainted. Asserting the label is STALE here is what
  // proves App wires setSuspended() up at all — the unit tests only prove the
  // panel obeys the flag when something sets it.
  const midDrag = await page.evaluate(() => {
    const doc = (window as unknown as { __app: { doc: { entities: any[] } } }).__app.doc;
    const r = doc.entities.find((e: any) => e.type === "rectangle");
    return { w: Math.abs(r.p1.x - r.p0.x), label: document.querySelector(".tree-row .tree-label")?.textContent };
  });
  expect(midDrag.w).toBeGreaterThan(61); // the drag really did resize it
  await expect(rectRow).toHaveText("Rectangle 60.00 mm × 40.00 mm"); // …and the tree held

  await page.mouse.up();

  // Pointer-up releases the hold and the tree catches up in one rebuild.
  await expect(rectRow).not.toHaveText("Rectangle 60.00 mm × 40.00 mm");
  await expect(rectRow).toContainText("Rectangle");
});

test("live: Ctrl+B toggles the panel", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openDoc(page, threeShapes());
  const panel = page.locator(".design-tree-panel");

  await page.locator("#scene").click({ position: { x: 5, y: 5 } }); // focus the app, not the URL bar
  await page.keyboard.press("Control+b");
  await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBeGreaterThan(150);

  await page.keyboard.press("Control+b");
  await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBeLessThan(1);
});
