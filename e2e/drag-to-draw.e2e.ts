/**
 * Press-drag-release draws a shape, and click-then-click still does too.
 *
 * The threshold arithmetic is unit-tested; what only a browser can show is that
 * a real mouse drag over the real canvas reaches the tool at all — that the
 * app routes `pointerup` to drawing tools, that the release position is snapped
 * the way a click is, and that adding the drag path did not break the
 * click-then-click gesture the app has always had.
 *
 * That last one is the point of the change: nobody's muscle memory should
 * break. Both gestures are exercised here for exactly that reason.
 */
import { test, expect, waitForApp, APP_URL } from "./appFixture";
import type { Page } from "@playwright/test";

async function newProject(page: Page): Promise<void> {
  const welcome = page.locator(".welcome-backdrop");
  await welcome.locator(".welcome-card", { hasText: "New Project" }).click();
  await page.locator("#npd-backdrop .tp-apply-btn").click();
  await expect(welcome).toHaveCount(0);
}

/** Model millimetres -> viewport pixels, through the app's own viewport. */
async function toPx(page: Page, mm: [number, number]): Promise<{ x: number; y: number }> {
  return page.evaluate(([x, y]) => {
    const app = (
      window as unknown as {
        __app: { view: { worldToScreen(p: { x: number; y: number }): { x: number; y: number } }; canvas: HTMLElement };
      }
    ).__app;
    const p = app.view.worldToScreen({ x, y });
    const r = app.canvas.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, mm);
}

async function pickTool(page: Page, label: string): Promise<void> {
  // Tool buttons carry their label in data-tip; their textContent is an icon.
  await page.locator(`button.tool-btn[data-tip^="${label}"]`).click();
}

/** Entities the user drew, ignoring the document's implicit WCS origin point. */
async function drawn(page: Page): Promise<{ type: string; id: string }[]> {
  return page.evaluate(() =>
    (window as unknown as { __app: { doc: { entities: { id: string; constructor: { name: string } }[] } } })
      .__app.doc.entities.filter((e) => e.id !== "__origin__")
      .map((e) => ({ type: e.constructor.name, id: e.id })),
  );
}

test("press-drag-release draws a rectangle", async ({ page }) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);

  await pickTool(page, "Rectangle");
  const a = await toPx(page, [40, 40]);
  const b = await toPx(page, [140, 100]);

  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2);
  await page.mouse.move(b.x, b.y);
  await page.mouse.up();

  const ents = await drawn(page);
  expect(ents).toHaveLength(1);
  expect(ents[0].type).toBe("RectEntity");

  // It is the rectangle that was dragged, not a degenerate one at the anchor.
  const size = await page.evaluate(() => {
    const r = (
      window as unknown as {
        __app: { doc: { entities: { id: string; p0?: { x: number; y: number }; p1?: { x: number; y: number } }[] } };
      }
    ).__app.doc.entities.find((e) => e.id !== "__origin__") as {
      p0: { x: number; y: number };
      p1: { x: number; y: number };
    };
    return { w: Math.abs(r.p1.x - r.p0.x), h: Math.abs(r.p1.y - r.p0.y) };
  });
  expect(size.w).toBeGreaterThan(90);
  expect(size.h).toBeGreaterThan(50);
});

test("click-then-click still draws a rectangle — the old gesture is untouched", async ({
  page,
}) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);

  await pickTool(page, "Rectangle");
  const a = await toPx(page, [40, 40]);
  const b = await toPx(page, [140, 100]);

  await page.mouse.click(a.x, a.y);
  await page.mouse.move(b.x, b.y);
  await page.mouse.click(b.x, b.y);

  const ents = await drawn(page);
  expect(ents).toHaveLength(1);
  expect(ents[0].type).toBe("RectEntity");
});

test("a click that wobbles a pixel is still a click, not a zero-size shape", async ({ page }) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);

  await pickTool(page, "Rectangle");
  const a = await toPx(page, [40, 40]);
  const b = await toPx(page, [140, 100]);

  // Press and release two pixels apart — under the threshold, so this arms the
  // first corner rather than committing a rectangle two pixels across.
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 2, a.y + 1);
  await page.mouse.up();
  expect(await drawn(page)).toHaveLength(0);

  // The tool is still armed: a second click finishes it normally.
  await page.mouse.move(b.x, b.y);
  await page.mouse.click(b.x, b.y);
  expect(await drawn(page)).toHaveLength(1);
});

test("drag draws a circle and a line too", async ({ page }) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);

  const dragBetween = async (from: [number, number], to: [number, number]) => {
    const a = await toPx(page, from);
    const b = await toPx(page, to);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y);
    await page.mouse.up();
  };

  await pickTool(page, "Circle");
  await dragBetween([60, 60], [90, 60]); // centre -> a point on it
  await pickTool(page, "Line");
  await dragBetween([120, 40], [180, 90]);

  const ents = await drawn(page);
  expect(ents.map((e) => e.type).sort()).toEqual(["CircleEntity", "LineEntity"]);
});

test("a dragged endpoint snaps, exactly as a clicked one does", async ({ page }) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);

  // First line, drawn by clicking, ending at a known point.
  await pickTool(page, "Line");
  const p1 = await toPx(page, [40, 40]);
  const p2 = await toPx(page, [100, 40]);
  await page.mouse.click(p1.x, p1.y);
  await page.mouse.move(p2.x, p2.y);
  await page.mouse.click(p2.x, p2.y);

  // Second line, DRAGGED so it releases a couple of pixels off that endpoint.
  await pickTool(page, "Line");
  const start = await toPx(page, [100, 110]);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(p2.x + 3, p2.y - 2); // near, not on, the first line's end
  await page.mouse.up();

  const ends = await page.evaluate(() =>
    (
      window as unknown as {
        __app: { doc: { entities: { id: string; b?: { x: number; y: number } }[] } };
      }
    ).__app.doc.entities
      .filter((e) => e.id !== "__origin__" && e.b)
      .map((e) => e.b as { x: number; y: number }),
  );
  expect(ends).toHaveLength(2);
  // The dragged line released NEAR (100,40) and snapped ONTO it. Without
  // snapping on release it would land a fraction of a millimetre off.
  const dragged = ends[1];
  expect(dragged.x).toBeCloseTo(100, 3);
  expect(dragged.y).toBeCloseTo(40, 3);
});
