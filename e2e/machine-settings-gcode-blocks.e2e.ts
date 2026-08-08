/**
 * Layout cover for the custom program start/end G-code fields.
 *
 * The field's logic is unit-tested in test/gcodeBlockEditor.test.ts, but
 * happy-dom has no layout engine, so that suite stayed green while the real
 * dialog was broken: the panes this field adds made Machine Settings taller than
 * the viewport and pushed Save off the bottom, leaving a dialog with no visible
 * way to commit. Everything asserted here is a question only a real browser can
 * answer.
 */
import { test, expect, waitForApp } from "./appFixture";

test("machine settings stays usable with the G-code block editors open", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/");
  await waitForApp(page);

  const welcome = page.locator(".welcome-backdrop");
  await welcome.locator(".welcome-card", { hasText: "New Project" }).click();
  await page.locator("#npd-backdrop .tp-apply-btn").click();
  await expect(welcome).toHaveCount(0);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.locator(".post-settings-dialog");
  await expect(dialog).toBeVisible();

  const startField = dialog.locator(".gbe").first();

  // A run-together line, which pre-flight cannot read — one of the few things
  // this field speaks up about.
  await startField.locator("textarea").fill("G54 ; work offset\nG43 H1\nG0X10Y20");
  await expect(startField.locator(".gbe-finding")).not.toHaveCount(0);

  await startField.locator(".gbe-add").click();
  const picker = startField.locator(".gbe-picker");
  await expect(picker).toBeVisible();
  await expect(picker.locator(".gbe-option")).not.toHaveCount(0);

  // Nothing may collapse to a zero box — the shape of "rendered but invisible".
  for (const loc of [picker, startField.locator(".gbe-finding").first()]) {
    const box = await loc.boundingBox();
    expect(box, "element has no layout box").not.toBeNull();
    expect(box!.width).toBeGreaterThan(50);
    expect(box!.height).toBeGreaterThan(5);
  }

  // The regression this file exists for: Save must stay on screen with both
  // fields expanded. The dialog scrolls; its footer is pinned (style.css).
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport();

  // Picking a block appends to the textarea rather than replacing it.
  await picker.locator(".gbe-option").first().click();
  await expect(startField.locator("textarea")).toHaveValue(/^G54 ; work offset/);
  await expect(picker).toBeHidden();
});

test("switching to a laser re-resolves the catalogue live", async ({ page }) => {
  // The laser branch is unit-covered, but the wiring that re-resolves it from the
  // machine-type dropdown is only exercised by driving the real dialog — and the
  // first browser pass checked the mill path only.
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/");
  await waitForApp(page);

  const welcome = page.locator(".welcome-backdrop");
  await welcome.locator(".welcome-card", { hasText: "New Project" }).click();
  await page.locator("#npd-backdrop .tp-apply-btn").click();
  await expect(welcome).toHaveCount(0);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.locator(".post-settings-dialog");
  const startField = dialog.locator(".gbe").first();
  await startField.locator(".gbe-add").click();
  const options = startField.locator(".gbe-picker .gbe-option");

  // Mill: the machine-coordinate Z retract is offered.
  await expect(options.filter({ hasText: "Retract Z" })).toHaveCount(1);

  // A laser has no Z, so that block must disappear without the dialog reopening.
  await dialog.locator("select").first().selectOption("laser");
  await expect(options.filter({ hasText: "Retract Z" })).toHaveCount(0);
  await expect(options).not.toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeInViewport();

  // And the checks follow the laser controller too: M4 is GRBL's dynamic beam
  // mode, so on a laser it raises the spindle/beam finding rather than an
  // unsupported-code error.
  await startField.locator("textarea").fill("M4 S500");
  await expect(startField.locator(".gbe-finding")).toHaveCount(1);
});
