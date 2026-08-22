/**
 * A dimension anchors to an edge WHERE IT WAS CLICKED, not at that edge's
 * midpoint.
 *
 * The reported symptom: several dimensions measured to the same edge all
 * started from that edge's midpoint, so their extension lines ran along one
 * another — and moving a dimension could not separate them, because `offset`
 * slides the shaft and never the anchor.
 *
 * This has to be an e2e test. A unit ToolContext uses `toWorldLen: px => px`,
 * so its pick tolerance is 8 MILLIMETRES rather than 8 screen pixels; at that
 * size the corner and midpoint hotspots swallow most of a short edge and the
 * geometry of "clicked past the hotspot, on the edge" is a different shape
 * entirely. Only the running app has a real scale. (Unit coverage of the key
 * encoding and the slide rules lives in test/dimensionEdgeAnchor.test.ts.)
 */
import type { Page } from "@playwright/test";
import { APP_URL, expect, test, waitForApp } from "./appFixture";

async function newProject(page: Page): Promise<void> {
  const welcome = page.locator(".welcome-backdrop");
  await welcome.locator(".welcome-card", { hasText: "New Project" }).click();
  await page.locator("#npd-backdrop .tp-apply-btn").click();
  await expect(welcome).toHaveCount(0);
}

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

/** Every dimension's type, its operands, and where its two ends actually land. */
const dimFacts = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        __app: {
          doc: {
            dimensions: {
              type: string;
              value: number;
              entities: string[];
              points: { entityId: string; key: string }[];
            }[];
          };
        };
      }
    ).__app.doc.dimensions.map((d) => ({
      type: d.type,
      value: d.value,
      entities: d.entities,
      points: d.points.map((p) => `${p.entityId}:${p.key}`),
    })),
  );

/** Where each circle sits, so a foot on the edge can be checked against it. */
const circleCentres = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        __app: { doc: { entities: { center?: { x: number; y: number } }[] } };
      }
    ).__app.doc.entities.filter((e) => e.center).map((e) => e.center!),
  );

const stockOrigin = (page: Page) =>
  page.evaluate(() => {
    const r = (
      window as unknown as {
        __app: { doc: { stockRect: { x: number; y: number } | null } };
      }
    ).__app.doc.stockRect;
    return { x: r?.x ?? 0, y: r?.y ?? 0 };
  });

test("two dimensions to the same edge anchor at two different points on it", async ({ page }) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);

  const o = await stockOrigin(page);
  const x0 = o.x + 40;
  const y0 = o.y + 30;
  const W = 70;
  const H = 130; // tall, so its left edge has room for two well-separated anchors

  await page.locator('button.tool-btn[data-tip^="Rectangle"]').click();
  const a = await toPx(page, [x0, y0]);
  const b = await toPx(page, [x0 + W, y0 + H]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();

  // Two circles at clearly different heights inside it.
  const heights = [y0 + 30, y0 + 100];
  for (const cy of heights) {
    await page.locator('button.tool-btn[data-tip^="Circle"]').click();
    const c = await toPx(page, [x0 + 40, cy]);
    const rim = await toPx(page, [x0 + 48, cy]);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(rim.x, rim.y, { steps: 6 });
    await page.mouse.up();
  }

  // Dimension each circle's centre across to the rectangle's LEFT edge, at that
  // circle's own height — the gesture that used to collapse both onto mid_l.
  await page.locator('button.tool-btn[data-tip^="Dimension"]').click();
  for (const cy of heights) {
    const centre = await toPx(page, [x0 + 40, cy]);
    await page.mouse.click(centre.x, centre.y);
    const edge = await toPx(page, [x0, cy]);
    await page.mouse.click(edge.x, edge.y);
    const place = await toPx(page, [x0 + 20, cy - 12]);
    await page.mouse.move(place.x, place.y);
    await page.mouse.click(place.x, place.y);
    // The dim editor opens on a driving dimension; dismiss it before the next.
    await page.keyboard.press("Escape");
  }

  const facts = await dimFacts(page);
  expect(facts, "both dimensions should have been placed").toHaveLength(2);

  // A real point and an EDGE is a perpendicular distance: the rectangle's left
  // edge is named as a whole edge, and each dimension lands at the foot of its
  // own perpendicular — so two of them cannot share a point the way two
  // midpoint-anchored dimensions did.
  expect(facts.every((f) => f.type === "point-line-distance")).toBe(true);
  expect(facts.every((f) => f.entities.some((e) => e.endsWith("#mid_l")))).toBe(true);

  // The positive control: each measures the gap from ITS OWN circle across to
  // the edge, so the two values differ by however far apart the circles are in
  // x — which is zero here, so instead check they name different points.
  expect(facts[0].points[0]).not.toBe(facts[1].points[0]);
  const centres = await circleCentres(page);
  expect(centres).toHaveLength(2);
  for (const f of facts) {
    // x0 + 40 is each circle's x; the left edge is at x0 = 50 + stock origin.
    expect(f.value).toBeCloseTo(40, 1);
  }
});
