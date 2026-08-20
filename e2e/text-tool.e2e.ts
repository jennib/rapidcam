/**
 * The Text tool's place-first flow (Fusion / SolidWorks / LightBurn).
 *
 * The piece a unit test cannot cover is focus. The Place Text dialog opens from
 * a canvas pointerdown, whose default action moves focus to <body> after the
 * handler returns — so a focus() called synchronously there is undone before the
 * user can type. The dialog re-asserts focus on the next tick, and this spec
 * types into the just-placed dialog without ever clicking it: the regression a
 * plain `textInp.focus()` would fail. It also pins the rest of the flow the
 * dialog changed — pick the tool, click the canvas to place, the side-docked
 * (peek) dialog appears, and the text lands at the click.
 */
import { test, expect, waitForApp, APP_URL } from "./appFixture";
import type { Page } from "@playwright/test";

async function newProject(page: Page): Promise<void> {
  const welcome = page.locator(".welcome-backdrop");
  await welcome.locator(".welcome-card", { hasText: "New Project" }).click();
  await page.locator("#npd-backdrop .tp-apply-btn").click();
  await expect(welcome).toHaveCount(0);
}

/** World millimetres → viewport pixels, through the app's own viewport. */
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

test("click to place, then type straight into the dialog", async ({ page }) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);

  // Pick the Text tool from the palette (it has no single-key shortcut).
  await page.locator('button.tool-btn[data-tip^="Text"]').click();

  // Click the canvas to set the anchor — this opens the Place Text dialog
  // docked to the side (the --peek variant).
  const anchor = await toPx(page, [60, 60]);
  await page.mouse.click(anchor.x, anchor.y);

  const dialog = page.locator(".tp-backdrop.tp-backdrop--peek .tp-dialog");
  await expect(dialog).toBeVisible();

  // The fix under test: focus survives the pointerdown, so the user can type
  // immediately without first clicking into the Text field.
  const textField = dialog.locator("input").first();
  await expect(textField).toBeFocused();
  await page.keyboard.type("HELLO");
  await expect(textField).toHaveValue("HELLO");
});
