/**
 * Every scalar/binding property field (Radius, Width, Length, ...) has an "ƒx"
 * badge: click it, pick a variable from the popup, and the field is driven by
 * that formula instead of typing the name blind. A dimension's own Value field
 * — what you edit when, say, a circle's Radius dimension is Tab-toggled to
 * Diameter — never got the same treatment, even though it already supported
 * typing a formula (Dimension.expr). Reported directly: "Circle diameter
 * property need autocomplete for variables."
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

interface DimSnapshot {
  type: string;
  value: number;
  expr?: string;
}

test("a circle's Diameter dimension gets an fx badge, and the picker drives it by a variable", async ({
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
    app.doc.variables.push({ id: "var1", name: "dia", expr: "30", value: 30 });
    app.doc.emitChange();
  });

  await pickTool(page, "Circle");
  await click(page, [150, 100]);
  await click(page, [170, 100]); // r=20

  // Click the RIM (not the centre — that would pick the centre DOF point and
  // route through a different tool phase) to hit the circle/arc radius-dim path,
  // then Tab to switch it to diameter.
  await pickTool(page, "Dimension");
  await click(page, [170, 100]);
  await page.keyboard.press("Tab");
  await click(page, [230, 100]); // place

  await page.evaluate(() => {
    const doc = (
      window as unknown as {
        __app: { doc: { dimensions: { id: string }[]; selectDimension(id: string): void } };
      }
    ).__app.doc;
    doc.selectDimension(doc.dimensions[0].id);
  });

  const dimSection = page.locator(".props-section", { hasText: "DIMENSION" });
  await expect(dimSection).toContainText("Diameter");
  const badge = dimSection.locator("span", { hasText: "ƒx" });
  await expect(badge).toBeVisible();

  await badge.click();
  await expect(page.locator(".fmenu-item", { hasText: "dia = 30" })).toBeVisible();
  await page.locator(".fmenu-item", { hasText: "dia" }).click();

  const dim = await page.evaluate(
    () =>
      (window as unknown as { __app: { doc: { dimensions: DimSnapshot[] } } }).__app.doc
        .dimensions[0],
  );
  expect(dim.expr).toBe("dia");
  expect(dim.value).toBeCloseTo(30, 3);

  // The field must show the FORMULA, not the resolved number — same
  // convention as every other ƒx-driven field.
  await expect(dimSection.locator("input").first()).toHaveValue("dia");
});
