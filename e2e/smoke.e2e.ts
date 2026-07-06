import { expect, test } from "@playwright/test";

/**
 * Boot smoke test: proves the app initialises, renders its editor shell, and
 * that the Draw/CAM panel switching is wired up. This is the durable, real-
 * browser replacement for the ad-hoc CDP scripts used previously.
 */
test("app boots and the editor shell is interactive", async ({ page }) => {
  await page.goto("/");

  // The app installs its dev hook once fully initialised.
  await expect
    .poll(() => page.evaluate(() => "__app" in window && Boolean((window as unknown as { __app: unknown }).__app)))
    .toBe(true);

  // Dismiss the first-load analytics consent banner so it can't overlay dialogs.
  const consent = page.locator("#analytics-consent-banner");
  await consent.getByRole("button", { name: "No thanks" }).click();
  await expect(consent).toHaveCount(0);

  // First run shows the welcome screen; start a blank project to enter the editor.
  const welcome = page.locator(".welcome-backdrop");
  await expect(welcome).toBeVisible();
  await welcome.locator(".welcome-card", { hasText: "New Project" }).click();
  await expect(welcome).toHaveCount(0);

  // "New Project" opens the New Project dialog; confirm it to create the drawing.
  const newProjectDialog = page.locator("#npd-backdrop");
  await expect(newProjectDialog).toBeVisible();
  await newProjectDialog.getByRole("button", { name: "Create Project" }).click();
  await expect(newProjectDialog).toHaveCount(0);

  // The editor shell is now present.
  await expect(page.locator("#scene")).toBeAttached();
  await expect(page.locator("#topbar")).toBeVisible();

  // Draw is the default active panel.
  const drawTab = page.locator(".rtab", { hasText: "Draw" });
  const camTab = page.locator(".rtab", { hasText: "CAM" });
  await expect(drawTab).toHaveClass(/active/);
  await expect(page.locator('.rtab-content[data-panel="draw"]')).toHaveClass(/active/);

  // Switching to CAM activates the CAM panel and its settings bar.
  await camTab.click();
  await expect(camTab).toHaveClass(/active/);
  await expect(page.locator('.rtab-content[data-panel="cam"]')).toHaveClass(/active/);
  await expect(page.locator("#settingsbar")).toBeVisible();
});
