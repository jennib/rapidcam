/**
 * Error paths, in a real browser — which was impossible while they were native
 * `alert()`. A blocking alert freezes the page under Playwright, so every one of
 * these branches was invisible to the suite; that is how a raster-engrave
 * "Apply hang" got misdiagnosed as an infinite loop when it was an alert in
 * headless Chrome.
 *
 * So this spec is the point of the change, not a nicety: it asserts the app
 * KEEPS RUNNING while telling you something failed.
 */
import { test, expect, waitForApp, APP_URL } from "./appFixture";

test("a corrupt share link reports the failure without blocking the app", async ({ page }) => {
  // A well-formed fragment carrying garbage — decodes far enough to be tried,
  // and fails.
  await page.goto(`${APP_URL}#d=not-a-real-payload`);

  // The app still boots. This is the load-bearing assertion: a native alert()
  // blocks the main thread, so `__app` would never be published and this line
  // would time out — which is exactly why these branches had no coverage.
  await waitForApp(page);

  const notice = page.locator(".error-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(/invalid or corrupted/i);

  // Get past the welcome screen, which legitimately gates tool shortcuts while
  // it is up. The notice must survive that document swap — it is not a modal,
  // so closeAllModals() does not sweep it.
  const welcome = page.locator(".welcome-backdrop");
  await welcome.locator(".welcome-card", { hasText: "New Project" }).click();
  await page.locator("#npd-backdrop .tp-apply-btn").click();
  await expect(welcome).toHaveCount(0);
  await expect(notice, "a document swap swept the error away").toBeVisible();

  // Non-blocking: the canvas is live underneath it. A tool shortcut still
  // switches tools, which an alert() would have swallowed.
  await page.keyboard.press("c");
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __app: { tools: { active: { id: string } } } }).__app.tools.active
          .id,
    ),
  ).toBe("circle");

  // And it stays put rather than fading — the reason it is not a toast.
  await page.waitForTimeout(3500); // well past toast()'s 2.6s
  await expect(notice, "the error faded on its own").toBeVisible();

  // Dismissable, and gone for good.
  await page.locator(".error-notice-close").click();
  await expect(notice).toHaveCount(0);
});
