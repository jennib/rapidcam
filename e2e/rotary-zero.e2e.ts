import { expect, test } from "@playwright/test";

/**
 * Rotary Z0 (zero reference) selectors, driven in a real browser. Both surfaces
 * that configure it — the New Project dialog and Machine Settings — write through
 * to `doc.rotary.zero`, which is what export/gSender-send read. These guards prove
 * the UI wiring (the generator math itself is unit-covered in test/klein.test.ts).
 */

/** Read the live document's rotary settings via the dev inspection hook. */
function rotary(page: import("@playwright/test").Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __app: { doc: { machineKind: string; rotary: unknown } } }).__app.doc,
  );
}

test("Rotary Z0: New Project sets centre-zero; Machine Settings reflects and edits it", async ({
  page,
}) => {
  // The Machine Settings dialog is long (rotary section + two G-code textareas);
  // a tall viewport keeps its Save button on-screen.
  await page.setViewportSize({ width: 1280, height: 1600 });
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => "__app" in window && Boolean((window as { __app?: unknown }).__app)))
    .toBe(true);

  // Clear the consent banner so it can't overlay the dialogs.
  const consent = page.locator("#analytics-consent-banner");
  await consent.getByRole("button", { name: "No thanks" }).click();
  await expect(consent).toHaveCount(0);

  // Welcome → New Project dialog.
  const welcome = page.locator(".welcome-backdrop");
  await welcome.locator(".welcome-card", { hasText: "New Project" }).click();
  const npd = page.locator("#npd-backdrop");
  await expect(npd).toBeVisible();

  // The Rotary Z0 row is hidden until a rotary machine is chosen.
  const zeroRow = npd.locator(".tp-field", { hasText: "Rotary Z0" });
  await expect(zeroRow).toBeHidden();
  await npd.locator(".tp-field", { hasText: "Machine type" }).locator("select").selectOption("mill-rotary");
  await expect(zeroRow).toBeVisible();

  // Choose centre-zero and create the project.
  await zeroRow.locator("select").selectOption("center");
  await npd.getByRole("button", { name: "Create Project" }).click();
  await expect(npd).toHaveCount(0);

  // The choice landed on the document (what export/send read).
  expect(await rotary(page)).toMatchObject({ machineKind: "mill-rotary", rotary: { zero: "center" } });

  // Machine Settings must show the same value, and be able to switch it back.
  await page.locator("#topbar").getByRole("button", { name: "Settings" }).click();
  const settings = page.locator(".post-settings-dialog");
  await expect(settings).toBeVisible();
  const zeroSelect = settings.locator(".post-settings-field", { hasText: "Zero reference (Z0)" }).locator("select");
  await expect(zeroSelect).toHaveValue("center");

  await zeroSelect.selectOption("surface");
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(settings).toHaveCount(0);

  expect(await rotary(page)).toMatchObject({ rotary: { zero: "surface" } });
});
