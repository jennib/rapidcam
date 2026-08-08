/**
 * Dimensioning FROM the stock's edges — the reported bug was that clicking near
 * the stock boundary with the Dimension tool produced a real-looking dimension
 * whose number was fiction, because the stock rectangle had no pickable points
 * at all: the click silently landed on whatever OTHER geometry happened to be
 * nearest. Model-level correctness (the anchor resolves, the solver drives
 * through it, deleting unrelated geometry doesn't orphan-prune it) is covered
 * in test/stockRefDimension.test.ts; this drives the actual Dimension tool with
 * real clicks, which is the only way to prove the click-to-pick path in
 * dimensionTool.ts itself reaches the fix.
 */
import { test, expect, waitForApp, APP_URL } from "./appFixture";
import type { Page } from "@playwright/test";

async function newProject(page: Page): Promise<void> {
  const welcome = page.locator(".welcome-backdrop");
  await welcome.locator(".welcome-card", { hasText: "New Project" }).click();
  await page.locator("#npd-backdrop .tp-apply-btn").click();
  await expect(welcome).toHaveCount(0);
}

/**
 * Position the blank away from the canvas origin.
 *
 * This offset is what gives the spec its teeth, and it must not be left to the
 * New Project default. The bug guarded here measured from canvas (0,0) instead
 * of the stock's own corner — so if the stock sat AT the origin, the wrong
 * answer and the right one would be numerically identical and every assertion
 * below would pass on the broken code. New Project now places the blank at the
 * origin (drawing coords match blank coords), so the offset is set here
 * explicitly rather than inherited.
 */
async function placeStockAt(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(
    ([px, py]) => {
      const app = (
        window as unknown as {
          __app: {
            doc: {
              stockRect: { x: number; y: number; width: number; height: number };
              emitChange(): void;
            };
          };
        }
      ).__app;
      app.doc.stockRect = { ...app.doc.stockRect, x: px, y: py };
      app.doc.emitChange();
    },
    [x, y],
  );
}

/** Model millimetres -> viewport pixels, through the app's own viewport. */
async function toPx(page: Page, mm: [number, number]): Promise<{ x: number; y: number }> {
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

async function pickTool(page: Page, label: string): Promise<void> {
  await page.locator(`button.tool-btn[data-tip^="${label}"]`).click();
}

async function click(page: Page, mm: [number, number]): Promise<void> {
  const p = await toPx(page, mm);
  await page.mouse.click(p.x, p.y);
}

interface DimSnapshot {
  id: string;
  points: { entityId: string; key: string }[];
  value: number;
  driving: boolean;
}

function dims(page: Page): Promise<DimSnapshot[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __app: { doc: { dimensions: DimSnapshot[] } } }).__app.doc
        .dimensions,
  );
}

function circleCenter(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const doc = (
      window as unknown as {
        __app: { doc: { entities: { id: string; center?: { x: number; y: number } }[] } };
      }
    ).__app.doc;
    const c = doc.entities.find((e) => e.center);
    return c!.center!;
  });
}

function stockRect(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __app: { doc: { stockRect: { x: number; y: number; width: number; height: number } } };
        }
      ).__app.doc.stockRect,
  );
}

test("dimensioning from the stock's left edge measures against the ACTUAL stock corner, not fiction", async ({
  page,
}) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page); // default 200×150 stock on a 300×250 sheet
  await placeStockAt(page, 50, 50); // deliberately off the origin — see the helper

  const stock = await stockRect(page);
  expect(stock).toEqual({ x: 50, y: 50, width: 200, height: 150 });

  // A circle well clear of any stock point, so drawing it can't accidentally
  // snap its centre onto the stock and confound what the test is checking.
  await pickTool(page, "Circle");
  await click(page, [180, 100]); // centre
  await click(page, [195, 100]); // radius point (r=15)

  const center = await circleCenter(page);
  expect(center.x).toBeCloseTo(180, 3);

  // Dimension: first point on the stock's LEFT edge (its mid-left point, world
  // 50,125 — same edge as the field report's screenshot), second point the
  // circle centre, third click places it in open space (well above/below, so
  // it resolves to a HORIZONTAL dimension — an X-distance from that edge).
  await pickTool(page, "Dimension");
  await click(page, [50, 125]); // stock's left edge
  await click(page, [180, 100]); // circle centre
  await click(page, [115, 235]); // place — open space, clear of both

  const created = await dims(page);
  expect(created).toHaveLength(1);
  const dim = created[0];

  // The whole point: the dimension is REALLY anchored to the stock, not to
  // some coincidentally-nearby entity.
  const stockPoint = dim.points.find((p) => p.entityId === "__stock__");
  expect(stockPoint).toBeDefined();
  expect(stockPoint!.key).toBe("mid_l");

  // And the number is real: |circle.x(180) − stock-left-edge.x(50)| = 130.
  // The bug this closes would have measured from canvas (0,0) instead of the
  // stock's actual corner — a 50mm difference, not a rounding error.
  expect(dim.value).toBeCloseTo(130, 3);
});

test("editing a stock-anchored dimension moves the geometry, and the stock itself never moves", async ({
  page,
}) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);
  await placeStockAt(page, 50, 50); // deliberately off the origin — see the helper

  await pickTool(page, "Circle");
  await click(page, [180, 100]);
  await click(page, [195, 100]);

  await pickTool(page, "Dimension");
  await click(page, [50, 125]);
  await click(page, [180, 100]);
  await click(page, [115, 235]);

  // A driving dimension on otherwise-free geometry opens its value editor
  // immediately (see finaliseDim in dimensionTool.ts) — same as dim-retry.e2e.ts.
  const input = page.locator("input.dim-edit");
  await expect(input).toBeVisible();
  await input.fill("80");
  await input.press("Enter");
  await expect(input).toHaveCount(0);

  const center = await circleCenter(page);
  // stock left edge x=50, dimension value 80 → circle centre lands at x=130.
  expect(center.x).toBeCloseTo(130, 2);

  const stock = await stockRect(page);
  expect(stock).toEqual({ x: 50, y: 50, width: 200, height: 150 });
});
