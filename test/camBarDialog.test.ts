// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from "vitest";
import { CamBar } from "../src/ui/camBar";
import { CADDocument } from "../src/model/document";
import { RectEntity } from "../src/model/entities";

/**
 * DOM-level cover for the Add-Toolpath dialog, which until now was guarded only
 * by the Playwright specs — a lot of weight on browser tests for a 3600-line
 * file whose bugs have all been logic, not rendering.
 *
 * Two bug classes are targeted, both of which have actually shipped:
 *
 *  - **Per-type field visibility.** camBar sets the same row-visibility rules
 *    TWICE: once inside the type `change` listener and once as the initial state
 *    (camBar.ts ~1488 and ~1530, near-identical blocks). A v-carve bug shipped
 *    precisely because a `replace_all` updated one copy and not the other, so
 *    *switching* the dropdown left Stepdown visible and V-carve pitch hidden
 *    while opening fresh was correct. Tests here drive the dropdown, which
 *    exercises the listener copy, and also assert the freshly-opened state.
 *  - **Unit conversion in labels and values.** The dialog reads mm internally
 *    and must render the document's display unit; raw floats leaking into the
 *    inputs ("0.23622047244094488") was a real defect.
 *
 * The dialog opens by clicking the real button rather than calling the private
 * `openDialog`, so this drives the same path a user does.
 */

/** Build a CamBar for `doc`, click "+ Add Toolpath", return the dialog element. */
function openDialog(doc: CADDocument): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  new CamBar(host, doc);

  const addBtn = [...host.querySelectorAll("button.cam-add-btn")].find((b) =>
    b.textContent?.includes("Add Toolpath"),
  ) as HTMLButtonElement | undefined;
  if (!addBtn) throw new Error("no '+ Add Toolpath' button");
  addBtn.click();

  const dialog = document.querySelector(".tp-dialog") as HTMLElement | null;
  if (!dialog) throw new Error("dialog did not open");
  return dialog;
}

/** The `.tp-field` row whose label starts with `label` (labels carry units). */
function row(dialog: HTMLElement, label: string): HTMLElement {
  const found = [...dialog.querySelectorAll(".tp-field")].find((f) =>
    f.querySelector("label")?.textContent?.startsWith(label),
  );
  if (!found) throw new Error(`no field row labelled "${label}"`);
  return found as HTMLElement;
}

/** happy-dom has no layout, so visibility is the inline display the code sets. */
const shown = (el: HTMLElement) => el.style.display !== "none";

/** Pick an op type the way a user does — the `change` listener is the code under test. */
function selectType(dialog: HTMLElement, combo: string): void {
  const sel = dialog.querySelector('[data-testid="op-type-select"]') as HTMLSelectElement;
  sel.value = combo;
  sel.dispatchEvent(new Event("change"));
}

function millDoc(unit: "mm" | "in" = "mm"): CADDocument {
  const doc = new CADDocument({ width: 300, height: 200 }, unit);
  doc.stockThickness = 19.05;
  doc.add(new RectEntity({ x: 0, y: 0 }, { x: 100, y: 100 }));
  return doc;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("Add-Toolpath dialog: per-type field visibility", () => {
  test("switching to V-Carve hides Stepdown and reveals the V-carve rows", () => {
    const dialog = openDialog(millDoc());
    // Default is a profile op: stepdown applies, v-carve pitch does not.
    expect(shown(row(dialog, "Stepdown"))).toBe(true);
    expect(shown(row(dialog, "V-carve pitch"))).toBe(false);

    selectType(dialog, "vcarve");

    // The exact regression that shipped once: the change handler must mirror
    // the initial-state block, or switching type leaves the wrong rows up.
    expect(shown(row(dialog, "Stepdown"))).toBe(false);
    expect(shown(row(dialog, "V-carve pitch"))).toBe(true);
    expect(shown(row(dialog, "V-carve hop clearance"))).toBe(true);
  });

  test("switching to Pocket reveals Stepover and Clearing, and drops the V-carve rows", () => {
    const dialog = openDialog(millDoc());
    selectType(dialog, "vcarve");
    selectType(dialog, "pocket");

    expect(shown(row(dialog, "Stepover"))).toBe(true);
    expect(shown(row(dialog, "Clearing"))).toBe(true);
    expect(shown(row(dialog, "Stepdown"))).toBe(true);
    expect(shown(row(dialog, "V-carve pitch"))).toBe(false);
  });

  test("switching to Drill swaps Stepdown for Peck depth", () => {
    const dialog = openDialog(millDoc());
    expect(shown(row(dialog, "Peck depth"))).toBe(false);

    selectType(dialog, "drill");

    expect(shown(row(dialog, "Peck depth"))).toBe(true);
    expect(shown(row(dialog, "Stepdown"))).toBe(false);
    expect(shown(row(dialog, "Stepover"))).toBe(false);
  });

  test("Cut direction is offered for profiles only", () => {
    const dialog = openDialog(millDoc());
    expect(shown(row(dialog, "Cut direction"))).toBe(true); // default profile-outside
    selectType(dialog, "pocket");
    expect(shown(row(dialog, "Cut direction"))).toBe(false);
    selectType(dialog, "profile-inside");
    expect(shown(row(dialog, "Cut direction"))).toBe(true);
  });
});

describe("Add-Toolpath dialog: display units", () => {
  test("an inch document labels its length and feed rows in inches", () => {
    const dialog = openDialog(millDoc("in"));
    expect(row(dialog, "Depth").querySelector("label")?.textContent).toContain("(in)");
    expect(row(dialog, "Stepdown").querySelector("label")?.textContent).toContain("(in)");
    expect(row(dialog, "Feed").querySelector("label")?.textContent).toContain("(in/min)");
  });

  test("inch values are converted and rounded, never raw floats", () => {
    const dialog = openDialog(millDoc("in"));
    // 6mm default diameter is 0.2362204724409449in — it must arrive rounded.
    const diam = row(dialog, "Diameter").querySelector("input") as HTMLInputElement;
    expect(diam.value).toMatch(/^\d+\.\d{1,4}$/);
    expect(Number(diam.value)).toBeCloseTo(6 / 25.4, 3);

    const depth = row(dialog, "Depth").querySelector("input") as HTMLInputElement;
    expect(depth.value).toMatch(/^-?\d+\.\d{1,4}$/);
    expect(Number(depth.value)).toBeCloseTo(-3 / 25.4, 3);
  });

  test("a millimetre document keeps mm labels and unconverted values", () => {
    const dialog = openDialog(millDoc("mm"));
    expect(row(dialog, "Depth").querySelector("label")?.textContent).toContain("(mm)");
    const diam = row(dialog, "Diameter").querySelector("input") as HTMLInputElement;
    expect(Number(diam.value)).toBeCloseTo(6, 6);
  });
});

describe("Add-Toolpath dialog: laser documents", () => {
  test("the type list narrows to beam operations", () => {
    const doc = millDoc();
    doc.machineKind = "laser";
    const dialog = openDialog(doc);

    const values = [
      ...dialog.querySelectorAll('[data-testid="op-type-select"] option'),
    ].map((o) => (o as HTMLOptionElement).value);

    expect(values).toContain("score"); // laser-only
    // Volumetric ops mean nothing to a beam and must not be offerable.
    expect(values).not.toContain("pocket");
    expect(values).not.toContain("drill");
    expect(values).not.toContain("vcarve");
  });

  test("a mill document offers the volumetric ops a laser cannot do", () => {
    // Positive control for the negative assertions above: proves the option
    // list is really being read, and that those values exist to be excluded.
    const dialog = openDialog(millDoc());
    const values = [
      ...dialog.querySelectorAll('[data-testid="op-type-select"] option'),
    ].map((o) => (o as HTMLOptionElement).value);

    expect(values).toEqual(
      expect.arrayContaining(["pocket", "drill", "vcarve", "chamfer", "relief-rough"]),
    );
    expect(values).not.toContain("score");
  });
});
