import { expect, test } from "@playwright/test";

test("clicking 'No thanks' on analytics banner does NOT dismiss New Project dialog", async ({ page }) => {
  await page.goto("/");

  // Wait for window.__app
  await expect
    .poll(() => page.evaluate(() => "__app" in window && Boolean((window as unknown as { __app: unknown }).__app)))
    .toBe(true);

  // Welcome screen -> New Project
  const welcome = page.locator(".welcome-backdrop");
  await expect(welcome).toBeVisible();
  await welcome.locator(".welcome-card", { hasText: "New Project" }).click();

  // Confirm New Project dialog is visible
  const newProjectDialog = page.locator("#npd-backdrop");
  await expect(newProjectDialog).toBeVisible();

  // Confirm analytics consent banner is visible
  const consentBanner = page.locator("#analytics-consent-banner");
  await expect(consentBanner).toBeVisible();

  // Click "No thanks" on consent banner
  await consentBanner.getByRole("button", { name: "No thanks" }).click();

  // Consent banner should be removed
  await expect(consentBanner).toHaveCount(0);

  // CRITICAL CHECK: New Project dialog MUST STILL BE VISIBLE and NOT dismissed!
  await expect(newProjectDialog).toBeVisible();
});
