/**
 * Dimensioning FROM a line: the click picks a point on that line where it
 * landed, so a line-to-line dimension does not have to start at a midpoint.
 *
 * The reported bug: "I can only attach a distance dimension from the midpoint
 * of a line... three dimensions all on the midpoint of the lines and they
 * overlap." A click on a line's BODY used to commit to dimensioning that whole
 * line's LENGTH on the spot, so the only way to start a dimension *from* a line
 * was to hit one of its three point hotspots — its two ends or its midpoint.
 * The midpoint is the one anybody aims for, so every line-to-line dimension
 * started at the same point and they stacked on top of each other.
 *
 * This has to run in the real app: a unit ToolContext uses `toWorldLen: px =>
 * px`, making the hotspot tolerance 8 MILLIMETRES rather than 8 screen pixels,
 * which is most of a short line — so "clicked the body, clear of every hotspot"
 * is a different geometry there than the one a user actually produces.
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

const dims = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        __app: {
          doc: {
            dimensions: {
              type: string;
              value: number;
              anchors?: number[];
              points: { key: string }[];
            }[];
          };
        };
      }
    ).__app.doc.dimensions.map((d) => ({
      type: d.type,
      value: Math.round(d.value * 1000) / 1000,
      anchors: d.anchors,
      keys: d.points.map((p) => p.key),
    })),
  );

async function drawLine(page: Page, a: [number, number], b: [number, number]) {
  await page.locator('button.tool-btn[data-tip^="Line"]').click();
  const pa = await toPx(page, a);
  const pb = await toPx(page, b);
  await page.mouse.move(pa.x, pa.y);
  await page.mouse.down();
  await page.mouse.move(pb.x, pb.y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press("Escape");
}

async function origin(page: Page) {
  return page.evaluate(() => {
    const r = (
      window as unknown as { __app: { doc: { stockRect: { x: number; y: number } | null } } }
    ).__app.doc.stockRect;
    return { x: r?.x ?? 0, y: r?.y ?? 0 };
  });
}

test("line to line: the dimension starts where the line was clicked", async ({ page }) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);

  const o = await origin(page);
  const x0 = o.x + 40;
  const yA = o.y + 180;
  const yB = o.y + 90;
  // Two parallel horizontal lines, fully overlapping so nothing gets clamped
  // to an end and the anchor is purely a function of where it was clicked.
  await drawLine(page, [x0, yA], [x0 + 180, yA]);
  await drawLine(page, [x0, yB], [x0 + 180, yB]);

  await page.locator('button.tool-btn[data-tip^="Dimension"]').click();

  // Two gaps between the SAME pair of lines, started at two different places.
  // Before the fix neither click could name a point on a line at all: a body
  // click dimensioned that line's whole length instead.
  for (const startX of [x0 + 25, x0 + 150]) {
    const a = await toPx(page, [startX, yA]);
    await page.mouse.click(a.x, a.y);
    const b = await toPx(page, [startX, yB]);
    await page.mouse.click(b.x, b.y);
    const place = await toPx(page, [startX, (yA + yB) / 2]);
    await page.mouse.move(place.x, place.y);
    await page.mouse.click(place.x, place.y);
    await page.keyboard.press("Escape");
  }

  const d = await dims(page);
  expect(d, "two gap dimensions should exist").toHaveLength(2);
  // Positive control: they measure the 90mm gap, not either line's 180mm length.
  expect(d.every((x) => x.type === "line-distance")).toBe(true);
  expect(d.map((x) => x.value)).toEqual([90, 90]);
  // The point of the fix: two different start clicks, two different anchors.
  // 25/180 and 150/180 — neither is the midpoint, 0.5.
  expect(d[0].anchors![0]).toBeCloseTo(25 / 180, 3);
  expect(d[1].anchors![0]).toBeCloseTo(150 / 180, 3);
});

test("clicking the same line twice still dimensions that line's length", async ({ page }) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);

  const o = await origin(page);
  const x0 = o.x + 40;
  const y = o.y + 120;
  await drawLine(page, [x0, y], [x0 + 180, y]);

  await page.locator('button.tool-btn[data-tip^="Dimension"]').click();
  // Two clicks on the line's own body, both clear of its end and mid hotspots.
  const p1 = await toPx(page, [x0 + 25, y]);
  await page.mouse.click(p1.x, p1.y);
  const p2 = await toPx(page, [x0 + 150, y]);
  await page.mouse.click(p2.x, p2.y);
  const place = await toPx(page, [x0 + 90, y - 30]);
  await page.mouse.move(place.x, place.y);
  await page.mouse.click(place.x, place.y);
  await page.keyboard.press("Escape");

  const d = await dims(page);
  expect(d).toHaveLength(1);
  // The whole line, witnessed at its own two ENDS — not the 125mm between the
  // two clicks, and not a midpoint anywhere.
  expect(d[0].value).toBeCloseTo(180, 3);
  expect(d[0].keys.sort()).toEqual(["a", "b"]);
});

test("a line to a circle's centre is the perpendicular distance to that line", async ({ page }) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);

  const o = await origin(page);
  const x0 = o.x + 40;
  const yA = o.y + 180;
  await drawLine(page, [x0, yA], [x0 + 180, yA]);

  await page.locator('button.tool-btn[data-tip^="Circle"]').click();
  const c = await toPx(page, [x0 + 60, yA - 70]);
  const rim = await toPx(page, [x0 + 70, yA - 70]);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(rim.x, rim.y, { steps: 6 });
  await page.mouse.up();

  await page.locator('button.tool-btn[data-tip^="Dimension"]').click();
  const onLine = await toPx(page, [x0 + 30, yA]);
  await page.mouse.click(onLine.x, onLine.y);
  await page.mouse.click(c.x, c.y);
  const place = await toPx(page, [x0 + 100, yA - 35]);
  await page.mouse.move(place.x, place.y);
  await page.mouse.click(place.x, place.y);
  await page.keyboard.press("Escape");

  const d = await dims(page);
  expect(d).toHaveLength(1);
  // A real point and a LINE is the perpendicular distance to that line — not
  // the gap to whichever point on it happened to be clicked, which would move
  // with the click and mean nothing.
  expect(d[0].type).toBe("point-line-distance");
  expect(d[0].value).toBeCloseTo(70, 3); // the drop from the centre to the line
  expect(d[0].keys).toEqual(["c"]); // the circle's centre is the only POINT
});
