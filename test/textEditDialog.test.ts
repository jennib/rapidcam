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
 * The shared text dialog's two modes.
 *
 * The create flow opens it with `peek: true` — docked to the side, no dimming,
 * with a live `onChange` so the glyphs preview as the fields are edited. The
 * edit flow (double-click) opens it as a normal modal, where a backdrop click
 * still abandons the edit. Both are pinned here: a wrong backdrop or a dead
 * onChange is invisible to a type-check and to every other test in the suite.
 */

afterEach(() => {
  vi.useRealTimers();
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

test("peek docks the dialog without dimming; the edit modal does not", () => {
  openTextDialog({
    initial: {},
    applyLabel: "Place",
    title: "Place Text",
    displayUnit: "mm",
    peek: true,
    onApply: () => {},
  });
  expect(
    document.querySelector(".tp-backdrop")?.classList.contains("tp-backdrop--peek"),
  ).toBe(true);
  document.body.innerHTML = "";

  openTextDialog({
    initial: { text: "before" },
    applyLabel: "Apply",
    title: "Edit Text",
    displayUnit: "mm",
    onApply: () => {},
  });
  expect(
    document.querySelector(".tp-backdrop")?.classList.contains("tp-backdrop--peek"),
  ).toBe(false);
});

test("onChange fires (debounced) with the edited fields", () => {
  vi.useFakeTimers();
  const onChange = vi.fn<(p: TextParams) => void>();
  openTextDialog({
    initial: {},
    applyLabel: "Place",
    title: "Place Text",
    displayUnit: "mm",
    peek: true,
    onChange,
    onApply: () => {},
  });
  seedFont();
  const inp = document.querySelector<HTMLInputElement>(".tp-dialog input")!;
  inp.value = "Warning: Pew Pew Pew";
  inp.dispatchEvent(new Event("input", { bubbles: true }));

  expect(onChange).not.toHaveBeenCalled(); // debounced

  vi.advanceTimersByTime(150);
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange.mock.calls[0][0].text).toBe("Warning: Pew Pew Pew");
  expect(onChange.mock.calls[0][0].fontId).toBe("test-font");
  vi.useRealTimers();
});

test("editing: clicking the backdrop still abandons the edit", () => {
  const onApply = vi.fn<(p: TextParams) => void>();
  const onCancel = vi.fn();
  openTextDialog({
    initial: { text: "before" },
    applyLabel: "Apply",
    title: "Edit Text",
    displayUnit: "mm",
    onApply,
    onCancel,
  });
  seedFont();
  typeText("after");

  clickBackdrop();

  expect(onApply).not.toHaveBeenCalled();
  expect(onCancel).toHaveBeenCalledTimes(1);
});

test("the heading is the title given, not one inferred from the button", () => {
  openTextDialog({
    initial: {},
    applyLabel: "Place",
    title: "Place Text",
    displayUnit: "mm",
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
    displayUnit: "mm",
    onApply: () => {},
  });
  expect(document.querySelector(".tp-dialog h3")?.textContent).toBe("Place Text");
});

/**
 * The height field is a LENGTH, so it must read and write in the document's
 * unit. It was hardcoded `"Height (mm)"` showing raw `sizeMM`, so an inch
 * project displayed 25.4 where its Properties panel said 1.000 in.
 */

test("an inch document shows inches, and commits millimetres", () => {
  const onApply = vi.fn<(p: TextParams) => void>();
  openTextDialog({
    initial: { sizeMM: 25.4 },
    applyLabel: "Place",
    title: "Place Text",
    displayUnit: "in",
    onApply,
  });
  seedFont();

  const labels = [...document.querySelectorAll(".tp-dialog label")].map((l) => l.textContent);
  expect(labels).toContain("Height (in)");
  expect(labels).not.toContain("Height (mm)");

  // 25.4mm reads back as 1 inch, not as 25.4.
  const size = [...document.querySelectorAll<HTMLInputElement>(".tp-dialog input")].find(
    (i) => i.value === "1" || i.value === "1.000",
  );
  expect(size).toBeDefined();

  typeText("HELLO");
  document.querySelector<HTMLElement>(".tp-apply-btn")!.click();
  // Committed value is always mm internally, whatever the field displayed.
  expect(onApply.mock.calls[0][0].sizeMM).toBeCloseTo(25.4, 6);
});

test("a suffix or fraction overrides the document unit", () => {
  const onApply = vi.fn<(p: TextParams) => void>();
  openTextDialog({
    initial: { sizeMM: 10 },
    applyLabel: "Place",
    title: "Place Text",
    displayUnit: "mm",
    onApply,
  });
  seedFont();
  typeText("HELLO");

  const size = [...document.querySelectorAll<HTMLInputElement>(".tp-dialog input")][1];
  size.value = '1/2"';
  document.querySelector<HTMLElement>(".tp-apply-btn")!.click();
  expect(onApply.mock.calls[0][0].sizeMM).toBeCloseTo(12.7, 6);
});

test("an unreadable height keeps the size it opened with", () => {
  const onApply = vi.fn<(p: TextParams) => void>();
  openTextDialog({
    initial: { sizeMM: 42 },
    applyLabel: "Place",
    title: "Place Text",
    displayUnit: "mm",
    onApply,
  });
  seedFont();
  typeText("HELLO");

  const size = [...document.querySelectorAll<HTMLInputElement>(".tp-dialog input")][1];
  size.value = "not a number";
  document.querySelector<HTMLElement>(".tp-apply-btn")!.click();
  // Not the 10mm hardcoded default the old `|| 10` fell back to.
  expect(onApply.mock.calls[0][0].sizeMM).toBe(42);
});
