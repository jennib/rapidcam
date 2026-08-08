// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vitest";
import { createGcodeBlockEditor, type BlockContext } from "../src/ui/gcodeBlockEditor";

/**
 * DOM cover for the custom program start/end field.
 *
 * happy-dom has no layout engine, so this can only prove the field's LOGIC —
 * that the picker offers what the selected controller can actually run, that
 * insertion appends rather than replaces, and that changing the controller
 * re-resolves the catalogue and the findings. Whether any of it is visible or reachable on screen
 * is not knowable here (see e2e/unreachable-controls.e2e.ts), and was checked by
 * driving the real dialog in a browser.
 */

const GRBL_MILL: BlockContext = { postId: "grbl", machine: "mill", coolantEnabled: false };

function open(over: Partial<Parameters<typeof createGcodeBlockEditor>[0]> = {}) {
  const editor = createGcodeBlockEditor({
    label: "Program start G-code",
    slot: "start",
    value: "",
    placeholder: "e.g. G54 ; work offset",
    ctx: GRBL_MILL,
    ...over,
  });
  document.body.replaceChildren(editor.field);
  const q = <T extends Element>(sel: string) => editor.field.querySelector<T>(sel);
  const qa = <T extends Element>(sel: string) => [...editor.field.querySelectorAll<T>(sel)];
  return {
    editor,
    textarea: q<HTMLTextAreaElement>("textarea")!,
    addBtn: q<HTMLButtonElement>(".gbe-add")!,
    picker: q<HTMLElement>(".gbe-picker")!,
    options: () => qa<HTMLButtonElement>(".gbe-option"),
    optionLabels: () => qa(".gbe-option-label").map((e) => e.textContent ?? ""),
    findings: () => qa(".gbe-finding").map((e) => e.textContent ?? ""),
  };
}

describe("picker", () => {
  test("is collapsed until asked for", () => {
    const ui = open();
    expect(ui.picker.hidden).toBe(true);
    ui.addBtn.click();
    expect(ui.picker.hidden).toBe(false);
    expect(ui.options().length).toBeGreaterThan(0);
  });

  test("offers homing on GRBL as $H, and withholds it on LinuxCNC", () => {
    const ui = open();
    ui.addBtn.click();
    const home = ui.options().find((o) => o.textContent?.includes("Home the machine"));
    expect(home?.textContent).toContain("$H");

    ui.editor.refresh({ ...GRBL_MILL, postId: "linuxcnc" });
    expect(ui.optionLabels().some((l) => l.includes("Home the machine"))).toBe(false);
  });

  test("a laser machine is not offered the mill-only Z retract", () => {
    const ui = open();
    ui.addBtn.click();
    expect(ui.optionLabels().some((l) => l.includes("Retract Z"))).toBe(true);
    ui.editor.refresh({ ...GRBL_MILL, machine: "laser", postId: "grbl-dynamic" });
    expect(ui.optionLabels().some((l) => l.includes("Retract Z"))).toBe(false);
  });

  test("the end slot offers park blocks, not start blocks", () => {
    const ui = open({ slot: "end" });
    ui.addBtn.click();
    const labels = ui.optionLabels().join(" ");
    expect(labels).toContain("Park");
    expect(labels).not.toContain("Home the machine");
  });
});

describe("insertion", () => {
  test("inserting appends to existing text rather than replacing it", () => {
    const ui = open({ value: "G54 ; existing" });
    ui.addBtn.click();
    ui.options()
      .find((o) => o.textContent?.includes("Home the machine"))!
      .click();
    expect(ui.textarea.value.split("\n")[0]).toBe("G54 ; existing");
    expect(ui.textarea.value).toContain("$H");
  });

  test("inserting keeps the explanatory comment the catalogue ships with", () => {
    const ui = open();
    ui.addBtn.click();
    ui.options()
      .find((o) => o.textContent?.includes("work offset"))!
      .click();
    // gcode.ts customLines passes lines through verbatim, so the comment reaches
    // the posted program and explains itself there too.
    expect(ui.textarea.value).toMatch(/^G54 ;/);
  });

  test("inserting collapses the picker and updates the explanation", () => {
    const ui = open();
    ui.addBtn.click();
    ui.options()[0].click();
    expect(ui.picker.hidden).toBe(true);
  });
});

describe("explanation and findings", () => {
  test("an empty block says nothing at all", () => {
    const ui = open();
    expect(ui.findings()).toEqual([]);
  });


  test("switching controller re-judges the same text", () => {
    const ui = open({ value: "G64 P0.01" });
    expect(ui.findings().length).toBe(1);
    ui.editor.refresh({ ...GRBL_MILL, postId: "linuxcnc" });
    expect(ui.findings()).toEqual([]);
  });

  test("the coolant checkbox changes whether M8 conflicts", () => {
    const ui = open({ value: "M8" });
    expect(ui.findings()).toEqual([]);
    ui.editor.refresh({ ...GRBL_MILL, coolantEnabled: true });
    expect(ui.findings().join(" ")).toContain("already switches M8");
  });


  test("an inches switch is surfaced as an error", () => {
    const ui = open({ value: "G20" });
    expect(ui.findings()[0]).toContain("⛔");
    expect(ui.findings()[0]).toContain("25.4");
  });
});

describe("lifecycle", () => {
  test("typing re-renders after the debounce", async () => {
    vi.useFakeTimers();
    try {
      const ui = open();
      ui.textarea.value = "G20";
      ui.textarea.dispatchEvent(new Event("input"));
      expect(ui.findings()).toEqual([]); // debounced, not yet
      vi.advanceTimersByTime(200);
      expect(ui.findings().length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("dispose cancels a pending re-render", () => {
    vi.useFakeTimers();
    try {
      const ui = open();
      ui.textarea.value = "G20";
      ui.textarea.dispatchEvent(new Event("input"));
      ui.editor.dispose();
      vi.advanceTimersByTime(500);
      // The timer must not fire after the dialog is gone — the bug shape that
      // resurrected the generator dialog's ghost preview.
      expect(ui.findings()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("value reflects what the user typed", () => {
    const ui = open();
    ui.textarea.value = "G54 ; typed";
    expect(ui.editor.value).toBe("G54 ; typed");
  });
});

describe("hiding", () => {
  // A DOM test can only assert the `hidden` PROPERTY; whether the browser then
  // paints it is a CSS question, and the answer was "yes, still visible" until
  // style.css gained an explicit `[hidden]` rule (an author `display` beats the
  // UA `[hidden]` rule at any specificity). Both facts are worth pinning: the
  // property here, the painting in e2e/machine-settings-gcode-blocks.e2e.ts.
  test("the picker uses the hidden property", () => {
    const ui = open();
    expect(ui.picker.hidden).toBe(true);
  });

});

describe("the picker is a popover", () => {
  // It used to expand in flow, pushing the textarea down the dialog — opening
  // the menu moved the thing you were about to type into.
  test("opening it does not reorder or displace the field", () => {
    const ui = open();
    const before = [...ui.editor.field.children].map((c) => c.className);
    ui.addBtn.click();
    const after = [...ui.editor.field.children].map((c) => c.className);
    expect(after).toEqual(before);
  });

  test("a click outside closes it", () => {
    const ui = open();
    ui.addBtn.click();
    expect(ui.picker.hidden).toBe(false);
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(ui.picker.hidden).toBe(true);
  });

  test("a click inside leaves it open", () => {
    const ui = open();
    ui.addBtn.click();
    ui.picker.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(ui.picker.hidden).toBe(false);
  });

  test("Escape closes the picker and stops there", () => {
    // The dialog's own Escape handler would discard the whole edit; a menu must
    // swallow the first Escape.
    const ui = open();
    ui.addBtn.click();
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    let reachedDocument = false;
    document.addEventListener("keydown", () => { reachedDocument = true; }, { once: true });
    ui.picker.dispatchEvent(esc);
    expect(ui.picker.hidden).toBe(true);
    expect(reachedDocument).toBe(false);
  });

  test("dispose detaches the outside-click listener", () => {
    const ui = open();
    ui.addBtn.click();
    ui.editor.dispose();
    // The listener is gone, so an outside click no longer reaches this field —
    // demonstrated by the picker NOT closing. dispose tears down; it does not
    // tidy up state the closing dialog is about to discard anyway.
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(ui.picker.hidden).toBe(false);
  });
});
