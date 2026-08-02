/**
 * "Construction" used to be one control doing two jobs: with a selection, the
 * Properties panel's top button toggled the SELECTED entities' own
 * isConstruction — but it also silently overwrote doc.isConstructionMode (the
 * mode governing what NEW shapes get drawn as) as a side effect. Marking one
 * circle construction would quietly arm construction mode for the next thing
 * you drew, with no visible cause. Reported as actively disliked UX.
 *
 * Now: a selection shows its own "Construction" checkbox inside that entity's
 * property section (reads as a property of the shape, not a standing mode),
 * and toggling it never touches doc.isConstructionMode. The mode toggle only
 * reappears — and only means "what's drawn next" — when nothing is selected.
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

async function drawCircle(page: Page, center: [number, number], edge: [number, number]): Promise<void> {
  await pickTool(page, "Circle");
  const a = await toPx(page, center);
  const b = await toPx(page, edge);
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
}

interface DocState {
  isConstructionMode: boolean;
  entities: { id: string; isConstruction: boolean; type?: string }[];
}
function docState(page: Page): Promise<DocState> {
  return page.evaluate(() => {
    const doc = (
      window as unknown as {
        __app: {
          doc: {
            isConstructionMode: boolean;
            entities: { id: string; isConstruction: boolean; constructor: { name: string } }[];
          };
        };
      }
    ).__app.doc;
    return {
      isConstructionMode: doc.isConstructionMode,
      entities: doc.entities
        .filter((e) => e.id !== "__origin__")
        .map((e) => ({ id: e.id, isConstruction: e.isConstruction, type: e.constructor.name })),
    };
  });
}

test("toggling a selected entity's construction property leaves the draw mode untouched", async ({
  page,
}) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);

  await drawCircle(page, [150, 100], [170, 100]); // auto-selected after drawing

  const before = await docState(page);
  expect(before.isConstructionMode).toBe(false);
  expect(before.entities[0].isConstruction).toBe(false);

  // The circle's own "Construction" checkbox, inside its CIRCLE section.
  const section = page.locator(".props-section", { hasText: "CIRCLE" });
  const checkbox = section.locator(".props-row", { hasText: "Construction" }).locator("input");
  await expect(checkbox).toBeVisible();
  await checkbox.check();

  const after = await docState(page);
  expect(after.entities[0].isConstruction).toBe(true);
  // The whole point: the draw MODE must not have moved.
  expect(after.isConstructionMode).toBe(false);

  // Drawing something new confirms it in practice: NOT construction, because
  // marking the first circle didn't quietly arm the mode for the next shape.
  await drawCircle(page, [150, 50], [170, 50]);
  const afterSecond = await docState(page);
  expect(afterSecond.entities).toHaveLength(2);
  expect(afterSecond.entities[1].isConstruction).toBe(false);
});

test("the X hotkey, with a selection, also leaves the draw mode untouched", async ({ page }) => {
  // Same guarantee as the checkbox, through the OTHER path that reaches
  // toggleConstruction() with a selection (the checkbox added in this change
  // never touched isConstructionMode to begin with; this is the path that
  // used to couple the two).
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);

  await drawCircle(page, [150, 100], [170, 100]);
  await page.keyboard.press("x");

  const after = await docState(page);
  expect(after.entities[0].isConstruction).toBe(true);
  expect(after.isConstructionMode).toBe(false);
});

test("the top-of-panel Construction Mode button only appears with nothing selected", async ({
  page,
}) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);

  const modeBtn = page.locator(".props-construction-btn");

  // Nothing selected yet (fresh project): the mode toggle is there.
  await expect(modeBtn).toBeVisible();

  await drawCircle(page, [150, 100], [170, 100]);
  // A circle is now selected: the panel shows ITS property instead.
  await expect(modeBtn).toHaveCount(0);
  await expect(page.locator(".props-section", { hasText: "CIRCLE" })).toBeVisible();
});
