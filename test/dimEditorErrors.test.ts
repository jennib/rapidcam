// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from "vitest";
import { DimEditor } from "../src/ui/dimEditor";
import { makeDimension } from "../src/model/dimensions";
import type { VarMap } from "../src/core/expr";

/**
 * A refused dimension edit has to say WHY.
 *
 * Four unrelated failures used to collapse into the same wordless red flash:
 * an unparseable number, a syntax error, a reference to a variable that does
 * not exist, and a value the solver could not satisfy. Reported live as
 * typing a variable name and getting "a red flash with no idea why" — the
 * variable simply had not been created yet, which the app already knew and
 * did not say (core/expr's validateExpr produces the exact message, and was
 * dead code).
 */
describe("dimension editor error reporting", () => {
  let container: HTMLElement;
  let errors: string[];
  const vars: VarMap = new Map([
    ["Cup_Diam", 38],
    ["Drill_Distance", 48],
  ]);

  beforeEach(() => {
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    errors = [];
  });

  /** Open an editor, type `text`, press Enter. Returns whether it stayed open. */
  function typeAndCommit(text: string, onCommit: () => boolean): boolean {
    const editor = new DimEditor();
    editor.open({
      dim: makeDimension("distance", { value: 25, offset: 10 }),
      container,
      screenPos: { x: 0, y: 0 },
      displayUnit: "mm",
      vars,
      onCommit,
      onError: (m) => errors.push(m),
    });
    const input = container.querySelector("input.dim-edit") as HTMLInputElement;
    input.value = text;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return editor.isOpen;
  }

  test("names the variable that does not exist", () => {
    const stillOpen = typeAndCommit("Cup_to_Bottom", () => true);
    expect(errors).toEqual(["Unknown variable: Cup_to_Bottom"]);
    expect(stillOpen).toBe(true); // keeps what you typed so it can be fixed
  });

  test("a defined variable commits and closes, reporting nothing", () => {
    let committed: { v: number; expr?: string } | null = null;
    const editor = new DimEditor();
    editor.open({
      dim: makeDimension("distance", { value: 25, offset: 10 }),
      container,
      screenPos: { x: 0, y: 0 },
      displayUnit: "mm",
      vars,
      onCommit: (v, expr) => {
        committed = { v, expr };
        return true;
      },
      onError: (m) => errors.push(m),
    });
    const input = container.querySelector("input.dim-edit") as HTMLInputElement;
    input.value = "Cup_Diam";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(errors).toEqual([]);
    expect(editor.isOpen).toBe(false);
    expect(committed).toEqual({ v: 38, expr: "Cup_Diam" });
  });

  test("distinguishes a syntax error from an unknown name", () => {
    typeAndCommit("Cup_Diam *", () => true);
    expect(errors[0]).toBe("Unexpected end of expression");
    expect(errors[0]).not.toContain("Unknown variable");
  });

  test("a solver refusal is reported as such, not as a bad value", () => {
    // The expression is perfectly valid; the document rejects the result.
    typeAndCommit("Cup_Diam", () => false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/over-constrained/i);
    expect(errors[0]).not.toMatch(/unknown variable/i);
  });

  test("a caller-supplied refusal reason wins over the generic one", () => {
    // "already fully constrained" and "value unreachable" need different
    // fixes, so the document's specific diagnosis must reach the user.
    const editor = new DimEditor();
    editor.open({
      dim: makeDimension("distance", { value: 25, offset: 10 }),
      container,
      screenPos: { x: 0, y: 0 },
      displayUnit: "mm",
      vars,
      onCommit: () => false,
      onError: (m) => errors.push(m),
      commitFailureReason: () => "The sketch is already fully constrained",
    });
    const input = container.querySelector("input.dim-edit") as HTMLInputElement;
    input.value = "Cup_Diam";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(errors).toEqual(["The sketch is already fully constrained"]);
  });

  test("a non-positive value says so rather than blaming the syntax", () => {
    typeAndCommit("0", () => true);
    expect(errors).toEqual(["Value must be greater than zero"]);
  });

  test("an empty box asks for a value", () => {
    typeAndCommit("", () => true);
    expect(errors).toEqual(["Enter a value"]);
  });

  test("the reason is also left on the input for hover, and cleared on retype", () => {
    typeAndCommit("Cup_to_Bottom", () => true);
    const input = container.querySelector("input.dim-edit") as HTMLInputElement;
    expect(input.title).toBe("Unknown variable: Cup_to_Bottom");
    input.value = "Cup_D";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.title).toBe("");
  });

  test("the reason is a dismissable bubble, not a message that vanishes", () => {
    typeAndCommit("Cup_to_Bottom", () => true);
    const box = container.querySelector(".dim-error");
    expect(box?.textContent).toContain("Unknown variable: Cup_to_Bottom");

    // It must still be there after the brief input flash would have ended.
    expect(container.querySelector(".dim-error")).not.toBeNull();

    (box!.querySelector(".dim-error-close") as HTMLButtonElement).click();
    expect(container.querySelector(".dim-error")).toBeNull();
  });

  test("Escape dismisses the error but keeps the edit; a second Escape closes it", () => {
    const editor = new DimEditor();
    editor.open({
      dim: makeDimension("distance", { value: 25, offset: 10 }),
      container,
      screenPos: { x: 0, y: 0 },
      displayUnit: "mm",
      vars,
      onCommit: () => true,
      onError: (m) => errors.push(m),
    });
    const input = container.querySelector("input.dim-edit") as HTMLInputElement;
    input.value = "Cup_to_Bottom";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(container.querySelector(".dim-error")).not.toBeNull();

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(container.querySelector(".dim-error")).toBeNull();
    expect(editor.isOpen).toBe(true); // the typed value survives for correction
    expect(input.value).toBe("Cup_to_Bottom");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(editor.isOpen).toBe(false);
  });

  test("editing the value clears the bubble", () => {
    typeAndCommit("Cup_to_Bottom", () => true);
    expect(container.querySelector(".dim-error")).not.toBeNull();
    const input = container.querySelector("input.dim-edit") as HTMLInputElement;
    input.value = "Cup_D";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(container.querySelector(".dim-error")).toBeNull();
  });
});
