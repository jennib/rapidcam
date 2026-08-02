/**
 * Every SIZE/shape formula field (Radius, Length, W/H, Width/Height/Angle)
 * has the ƒx variable picker; POSITION fields (Cx/Cy, line endpoints, image
 * X/Y) didn't, because a point's X/Y isn't a scalar DOF the ScalarBinding
 * channel drives. Fixed by reusing hiddenDimRow's existing mechanism — a
 * formula parks in a hidden horizontal/vertical dimension — anchored to the
 * WCS origin (always world (0,0)) instead of another point on the same
 * entity, since Cx literally IS "horizontal distance from world zero".
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

interface CenterEntity {
  id: string;
  center?: { x: number; y: number };
}

test("a circle's Cx gets an fx picker, drives the centre by a variable, and leaves Cy alone", async ({
  page,
}) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);

  await page.evaluate(() => {
    const app = (
      window as unknown as {
        __app: {
          doc: {
            variables: { id: string; name: string; expr: string; value: number }[];
            emitChange(): void;
          };
        };
      }
    ).__app;
    app.doc.variables.push({ id: "var1", name: "spacing", expr: "220", value: 220 });
    app.doc.emitChange();
  });

  await pickTool(page, "Circle");
  const a = await toPx(page, [150, 100]);
  const b = await toPx(page, [170, 100]);
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);

  const sec = page.locator(".props-section", { hasText: "CIRCLE" });
  const cxRow = sec.locator(".props-row", { hasText: "Cx" });
  const cyRow = sec.locator(".props-row", { hasText: "Cy" });
  // Cx and Cy are independent fields, each with its OWN badge — not the old
  // combined "Cx [·] Cy [·]" row, which could only commit both together.
  await expect(cxRow.locator("span", { hasText: "ƒx" })).toBeVisible();
  await expect(cyRow.locator("span", { hasText: "ƒx" })).toBeVisible();

  await cxRow.locator("span", { hasText: "ƒx" }).click();
  await expect(page.locator(".fmenu-item", { hasText: "spacing = 220" })).toBeVisible();
  await page.locator(".fmenu-item", { hasText: "spacing" }).click();

  const center = await page.evaluate(
    () =>
      (window as unknown as { __app: { doc: { entities: CenterEntity[] } } }).__app.doc.entities.find(
        (e) => e.center,
      )!.center!,
  );
  expect(center.x).toBeCloseTo(220, 3);
  expect(center.y).toBeCloseTo(100, 3); // Cy untouched by driving Cx

  // The Cx field shows the FORMULA, matching every other ƒx-driven field.
  await expect(cxRow.locator("input")).toHaveValue("spacing");
});
