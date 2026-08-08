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
  const textarea = startField.locator("textarea");
  const picker = startField.locator(".gbe-picker");
  const findings = startField.locator(".gbe-finding");

  // The button TOGGLES, so every open and close asserts the state it reached
  // rather than assuming it — an earlier version of this test tracked the state
  // in its head, guessed wrong (`fill()` does not fire pointerdown, so the
  // picker it thought it was opening was already open) and closed the menu it
  // was about to click into.
  const openPicker = async () => {
    await startField.locator(".gbe-add").click();
    await expect(picker).toBeVisible();
  };

  // --- findings speak up, and only about real problems -----------------------
  await textarea.fill("G54 ; work offset\nG43 H1\nG0X10Y20");
  await expect(findings).not.toHaveCount(0); // run-together words

  await textarea.fill("Gq9999");
  await expect(findings).toHaveCount(1);
  await expect(findings).toContainText("not valid G-code");

  // --- the picker overlays rather than displacing the field ------------------
  await expect(picker).toBeHidden();
  const closedY = (await textarea.boundingBox())!.y;
  await openPicker();
  expect((await textarea.boundingBox())!.y).toBeCloseTo(closedY, 0);

  // Nothing may collapse to a zero box — the shape of "rendered but invisible".
  for (const loc of [picker, findings.first()]) {
    const box = await loc.boundingBox();
    expect(box, "element has no layout box").not.toBeNull();
    expect(box!.width).toBeGreaterThan(50);
    expect(box!.height).toBeGreaterThan(5);
  }

  // The regression this file exists for: Save must stay reachable.
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport();

  // --- picking appends to what is already there ------------------------------
  await expect(picker.locator(".gbe-option")).not.toHaveCount(0);
  await picker.locator(".gbe-option").first().click();
  await expect(textarea).toHaveValue(/^Gq9999\n/);
  await expect(picker).toBeHidden();

  // A click outside closes it without inserting anything.
  await openPicker();
  await dialog.locator(".post-settings-title").click();
  await expect(picker).toBeHidden();
  await expect(textarea).toHaveValue(/^Gq9999\n/);
});

test("clicking a finding scrolls to its line and selects it", async ({ page }) => {
  // happy-dom has no layout, so it cannot answer whether the box actually
  // scrolled — only a real browser can.
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/");
  await waitForApp(page);
  const welcome = page.locator(".welcome-backdrop");
  await welcome.locator(".welcome-card", { hasText: "New Project" }).click();
  await page.locator("#npd-backdrop .tp-apply-btn").click();
  await expect(welcome).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  const startField = page.locator(".post-settings-dialog .gbe").first();
  const textarea = startField.locator("textarea");

  // The offender is well below the four visible rows, so reaching it REQUIRES
  // scrolling — the assertion below is not satisfiable by selection alone.
  const lines = ["G54", "M8", "G0 X0 Y0", "G0 X1 Y1", "G0 X2 Y2", "G0 X3 Y3", "Gq9999"];
  await textarea.fill(lines.join(String.fromCharCode(10)));

  const finding = startField.locator(".gbe-finding--linked").first();
  await expect(finding).toBeVisible();

  // Scroll back to the top and drop focus first. `fill()` leaves the caret at
  // the end, so the box is already scrolled down — without this reset the
  // assertion below would pass on a scroll the click had nothing to do with.
  await textarea.evaluate((el: HTMLTextAreaElement) => {
    el.scrollTop = 0;
    el.blur();
  });
  expect(await textarea.evaluate((el: HTMLTextAreaElement) => el.scrollTop)).toBe(0);

  await finding.click();

  const state = await textarea.evaluate((el: HTMLTextAreaElement) => ({
    selected: el.value.slice(el.selectionStart, el.selectionEnd),
    scrollTop: el.scrollTop,
    focused: document.activeElement === el,
  }));
  expect(state.selected).toBe("Gq9999");
  expect(state.focused).toBe(true);
  expect(state.scrollTop).toBeGreaterThan(0);
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
