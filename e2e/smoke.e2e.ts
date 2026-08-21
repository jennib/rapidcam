import { expect, test, waitForApp } from "./appFixture";

/**
 * Boot smoke test: proves the app initialises, renders its editor shell, and
 * that the Draw/CAM panel switching is wired up. This is the durable, real-
 * browser replacement for the ad-hoc CDP scripts used previously.
 */
test("app boots and the editor shell is interactive", async ({ page }) => {
  await page.goto("/");
  await waitForApp(page);

  // First run shows the welcome screen; start a blank project to enter the editor.
  const welcome = page.locator(".welcome-backdrop");
  await expect(welcome).toBeVisible();
  await welcome.locator(".welcome-card", { hasText: "New Project" }).click();
  await expect(welcome).toHaveCount(0);

  const newProjectDialog = page.locator("#npd-backdrop");
  await expect(newProjectDialog).toBeVisible();
  await newProjectDialog.getByRole("button", { name: "Create Project" }).click();
  await expect(newProjectDialog).toHaveCount(0);

  // The editor shell is now present.
  await expect(page.locator("#scene")).toBeAttached();
  await expect(page.locator("#topbar")).toBeVisible();

  // Design is the default active panel.
  const drawTab = page.locator(".rtab", { hasText: "Design" });
  const camTab = page.locator(".rtab", { hasText: "Toolpaths" });
  await expect(drawTab).toHaveClass(/active/);
  await expect(page.locator('.rtab-content[data-panel="draw"]')).toHaveClass(/active/);

  // Switching to CAM activates the CAM panel and its settings bar.
  await camTab.click();
  await expect(camTab).toHaveClass(/active/);
  await expect(page.locator('.rtab-content[data-panel="cam"]')).toHaveClass(/active/);
  await expect(page.locator("#settingsbar")).toBeVisible();
});
