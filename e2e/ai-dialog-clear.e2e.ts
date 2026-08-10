import { expect, test, waitForApp, APP_URL } from "./appFixture";
import type { Page } from "@playwright/test";

/**
 * The Clear control on the AI Assistant's paste box — the half of it that only
 * a browser knows.
 *
 * `test/aiAssistantDialogClear.test.ts` covers the wiring under happy-dom,
 * which has no layout engine and was perfectly green while the button it had
 * just added pushed "Check & Import" into wrapping its own label across two
 * lines. Three buttons (Check & Import · Copy Error Report for AI · Clear)
 * exceed the 560px dialog's content width, and flex's default is to shrink
 * them rather than wrap the row. So the assertion here is a measured one: with
 * all three showing, no button is taller than a single line of text.
 */
async function openAiDialog(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(APP_URL);
  await waitForApp(page);
  const welcome = page.locator(".welcome-backdrop");
  await welcome.locator(".welcome-card", { hasText: "New Project" }).click();
  const npd = page.locator("#npd-backdrop");
  await npd.getByRole("button", { name: "Create Project" }).click();
  await expect(npd).toHaveCount(0);
  await page.locator("#topbar").getByText("File", { exact: true }).click();
  await page.getByText("AI Assistant…").click();
  const dialog = page.locator("#ai-dialog-backdrop");
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Tallest button in the action row. A wrapped label roughly doubles it. */
async function tallestActionButton(dialog: ReturnType<Page["locator"]>): Promise<number> {
  const names = ["Check & Import", "Copy Error Report for AI", "Clear"];
  const heights = await Promise.all(
    names.map(async (n) => {
      const b = dialog.getByRole("button", { name: n, exact: true });
      return (await b.count()) && (await b.isVisible()) ? ((await b.boundingBox())?.height ?? 0) : 0;
    }),
  );
  return Math.max(...heights);
}

test("live: Clear empties the paste box and takes its report down with it", async ({ page }) => {
  const dialog = await openAiDialog(page);
  const paste = dialog.locator("textarea").last();
  const clear = dialog.getByRole("button", { name: "Clear", exact: true });

  await expect(clear).toBeHidden();

  // A file that parses but fails the schema, so the error panel and the Copy
  // Report button are both up when Clear is pressed.
  await paste.fill('{"version": 3, "name": "test", "entities": []}');
  await expect(clear).toBeVisible();
  await dialog.getByRole("button", { name: "Check & Import" }).click();
  await expect(dialog.locator("#ai-result")).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Copy Error Report/ })).toBeVisible();

  await clear.click();

  await expect(paste).toHaveValue("");
  await expect(dialog.locator("#ai-result")).toBeHidden();
  await expect(dialog.getByRole("button", { name: /Copy Error Report/ })).toBeHidden();
  await expect(clear).toBeHidden();
  // Focus lands back in the box, so the next paste needs no click.
  await expect(paste).toBeFocused();
});

test("live: the action row keeps every button label on one line", async ({ page }) => {
  const dialog = await openAiDialog(page);
  const paste = dialog.locator("textarea").last();

  await paste.fill('{"version": 3}');
  const twoButtons = await tallestActionButton(dialog);
  expect(twoButtons).toBeGreaterThan(0);

  // Reveal the third button — the state that broke the row.
  await dialog.getByRole("button", { name: "Check & Import" }).click();
  await expect(dialog.getByRole("button", { name: /Copy Error Report/ })).toBeVisible();

  const threeButtons = await tallestActionButton(dialog);
  expect(
    threeButtons,
    "a button grew taller once the third appeared — its label is wrapping",
  ).toBe(twoButtons);
});
