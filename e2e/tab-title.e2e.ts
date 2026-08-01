/**
 * The browser tab carries the open file's name and its unsaved-changes marker.
 *
 * This matters more than it looks: the app chrome no longer shows the file name
 * anywhere, so the tab is the ONLY place it appears. A regression here loses the
 * information entirely rather than merely duplicating it badly.
 *
 * The marker leads rather than trails because a browser truncates a tab title
 * from the right, and shows very few characters once several tabs are open — a
 * trailing `*` is the first thing to vanish, exactly when the user is scanning
 * tabs for the one with unsaved work.
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

test("the file name appears nowhere in the app chrome — the tab is its only home", async ({
  page,
}) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await newProject(page);

  // Positive control: the tab really does carry it, so the absence below is
  // "moved" rather than "lost".
  await expect(page).toHaveTitle(/Untitled/);

  // The old label sat between the logo and the File menu, pushing the menus
  // right to say what the tab already said.
  await expect(page.locator("#topbar .topbar-filename")).toHaveCount(0);
  const topbarText = await page.locator("#topbar").innerText();
  expect(topbarText).not.toContain("Untitled");
});
