/**
 * See test/circleEdgeQuadrantSnap.test.ts for the underlying fix (circleEdgePick
 * now snaps to the nearest quadrant within tolerance). This drives it through
 * the real Dimension tool with a realistic imprecise click, the only way to
 * prove the tool actually reaches the fix end to end. Reported live as "still
 * getting weird looking dimensions" after an earlier, different fix
 * (avoidDimensionCollision) — reproduced separately: a circle-rim dimension
 * anchor used to capture whatever exact angle the mouse was at, so a click
 * aimed at "the top of the circle" rendered a visibly crooked leader even
 * though the measured value (always exactly the radius) looked perfectly clean.
 */
import { test, expect, waitForApp, APP_URL } from "./appFixture";
import type { Page } from "@playwright/test";

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

async function pickTool(page: Page, label: string): Promise<void> {
  await page.locator(`button.tool-btn[data-tip^="${label}"]`).click();
}

async function click(page: Page, mm: [number, number]): Promise<void> {
  const p = await toPx(page, mm);
  await page.mouse.click(p.x, p.y);
}

test("a click near the top of a circle, not pixel-perfect, still anchors to the true top", async ({
  page,
}) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);

  // Circle radius 40, centre (150,120) -> true top quadrant is (150,160).
  await pickTool(page, "Circle");
  await click(page, [150, 120]);
  await click(page, [190, 120]);

  await pickTool(page, "Dimension");
  await click(page, [150, 120]); // centre (exact)
  await click(page, [151, 159.9]); // ~1.4deg off true top -- realistic mouse wobble
  await click(page, [190, 175]); // diagonal placement -> "distance" (aligned) type

  const input = page.locator("input.dim-edit");
  if (await input.count()) await input.press("Enter");

  const dim = await page.evaluate(
    () =>
      (
        window as unknown as {
          __app: { doc: { dimensions: { points: { key: string }[]; value: number }[] } };
        }
      ).__app.doc.dimensions[0],
  );
  // The exact top-quadrant angle (pi/2), not the raw imprecise click angle.
  expect(dim.points.some((p) => p.key === `edge@${Math.PI / 2}`)).toBe(true);
  expect(dim.value).toBeCloseTo(40, 6);
});
