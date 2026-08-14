// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { openTextDialog, type TextParams } from "../src/ui/textEditDialog";

// Opening the dialog kicks off the bundled-font load, which under happy-dom is a
// real fetch at a dev server that isn't running. The refused connections cost
// ~19s of the run against 0.4s for the rest of the environment, and none of the
// behaviour under test depends on them — the font `<select>` is seeded directly
// below. Everything else in the module stays real.
vi.mock("../src/core/fontManager", async (importActual) => ({
  ...(await importActual<typeof import("../src/core/fontManager")>()),
  initBundledFonts: vi.fn(async () => {}),
}));

/**
 * The placement dialog's backdrop dismissal.
 *
 * The Text tool's button used to read "Stamp (click canvas)" while the dialog's
 * own backdrop covered the canvas. A user who followed that instruction hit the
 * backdrop, which cancelled — silently discarding everything they had typed.
 * The button now says "Place" and a backdrop click on the placement dialog
 * COMMITS instead of destroying.
 *
 * Editing an existing text keeps the conventional dismiss, so both behaviours
 * are pinned here: getting either one wrong is invisible to a type-check and to
 * every other test in the suite.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

/** The dialog reads its font from a `<select>` populated by the font manager,
 *  which loads nothing under test — so stand one in, the way a loaded font
 *  would appear. It is the only `<select>` the dialog builds. */
function seedFont(): void {
  const sel = document.querySelector<HTMLSelectElement>(".tp-dialog select")!;
  const opt = document.createElement("option");
  opt.value = "test-font";
  opt.textContent = "Test Font";
  sel.appendChild(opt);
  sel.value = "test-font";
}

function typeText(s: string): void {
  const inp = document.querySelector<HTMLInputElement>(".tp-dialog input")!;
  inp.value = s;
}

function clickBackdrop(): void {
  const backdrop = document.querySelector<HTMLElement>(".tp-backdrop")!;
  // `e.target === backdrop` is what separates a backdrop click from a click
  // inside the dialog, so the event must originate on the backdrop itself.
  backdrop.dispatchEvent(new Event("click", { bubbles: true }));
}

test("placement: clicking the backdrop keeps the typed text", () => {
  const onApply = vi.fn<(p: TextParams) => void>();
  const onCancel = vi.fn();
  openTextDialog({
    initial: {},
    applyLabel: "Place",
    title: "Place Text",
    backdropAction: "apply",
    onApply,
    onCancel,
  });
  seedFont();
  typeText("Warning: Pew Pew Pew");

  clickBackdrop();

  expect(onCancel).not.toHaveBeenCalled();
  expect(onApply).toHaveBeenCalledTimes(1);
  expect(onApply.mock.calls[0][0].text).toBe("Warning: Pew Pew Pew");
  // And the dialog is gone, so the canvas underneath is reachable.
  expect(document.querySelector(".tp-backdrop")).toBeNull();
});

test("editing: clicking the backdrop still abandons the edit", () => {
  const onApply = vi.fn<(p: TextParams) => void>();
  const onCancel = vi.fn();
  openTextDialog({
    initial: { text: "before" },
    applyLabel: "Apply",
    title: "Edit Text",
    onApply,
    onCancel,
  });
  seedFont();
  typeText("after");

  clickBackdrop();

  expect(onApply).not.toHaveBeenCalled();
  expect(onCancel).toHaveBeenCalledTimes(1);
});

test("placement: an empty dialog dismissed by backdrop cancels, and does not error", () => {
  const onApply = vi.fn<(p: TextParams) => void>();
  const onCancel = vi.fn();
  openTextDialog({
    initial: {},
    applyLabel: "Place",
    title: "Place Text",
    backdropAction: "apply",
    onApply,
    onCancel,
  });
  seedFont();
  // nothing typed

  clickBackdrop();

  expect(onApply).not.toHaveBeenCalled();
  expect(onCancel).toHaveBeenCalledTimes(1);
});

test("the heading is the title given, not one inferred from the button", () => {
  openTextDialog({
    initial: {},
    applyLabel: "Place",
    title: "Place Text",
    onApply: () => {},
  });
  expect(document.querySelector(".tp-dialog h3")?.textContent).toBe("Place Text");
  expect(document.querySelector(".tp-apply-btn")?.textContent).toBe("Place");
  document.body.innerHTML = "";

  // The pair that used to be coupled: the heading used to be chosen by string-
  // matching the button label, so this combination silently produced "Edit Text".
  openTextDialog({
    initial: {},
    applyLabel: "Apply",
    title: "Place Text",
    onApply: () => {},
  });
  expect(document.querySelector(".tp-dialog h3")?.textContent).toBe("Place Text");
});
