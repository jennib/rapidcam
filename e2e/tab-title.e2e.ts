/**
 * The open file's name and its unsaved-changes marker live in TWO places: the
 * browser tab (title) and a small readout in the app chrome beside the logo.
 *
 * Both keep the same marker convention: the marker LEADS rather than trails,
 * because a browser truncates a tab title from the right, and shows very few
 * characters once several tabs are open — a trailing `*` is the first thing to
 * vanish, exactly when the user is scanning for the one with unsaved work.
 */
import { test, expect, waitForApp, APP_URL } from "./appFixture";
import type { Page } from "@playwright/test";

async function newProject(page: Page): Promise<void> {
  const welcome = page.locator(".welcome-backdrop");
  await welcome.locator(".welcome-card", { hasText: "New Project" }).click();
  await page.locator("#npd-backdrop .tp-apply-btn").click();
  await expect(welcome).toHaveCount(0);
}

test("the tab names the open file, and marks it when there are unsaved changes", async ({
  page,
}) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);

  // A fresh project is clean: named, no marker.
  await expect(page).toHaveTitle(/^Untitled — RapidCAM$/);

  // Any edit dirties it.
  await page.evaluate(() => {
    (window as unknown as { __app: { doc: { emitChange(): void } } }).__app.doc.emitChange();
  });
  await expect(page).toHaveTitle(/^● Untitled — RapidCAM$/);

  // The marker LEADS, so it survives a truncated tab.
  const title = await page.title();
  expect(title.startsWith("●")).toBe(true);
});

test("the file name also appears in the app chrome beside the logo", async ({ page }) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);

  // A fresh project is clean: the chrome readout carries the name, no marker.
  const readout = page.locator("#topbar .topbar-filename");
  await expect(readout).toHaveText("Untitled");

  // Dirtying the document adds the marker to the chrome too.
  await page.evaluate(() => {
    (window as unknown as { __app: { doc: { emitChange(): void } } }).__app.doc.emitChange();
  });
  await expect(readout).toHaveText("● Untitled");
});