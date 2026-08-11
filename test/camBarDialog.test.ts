// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from "vitest";
import { CamBar } from "../src/ui/camBar";
import { CADDocument } from "../src/model/document";
import { RasterImageEntity, RectEntity } from "../src/model/entities";
import { registerEmbeddedImage } from "../src/core/imageManager";
import { applyOpParam, makeVariable } from "../src/model/variables";
import type { CAMOperation } from "../src/cam/types";

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

describe("Add-Toolpath dialog: laser material presets", () => {
  function laserDoc(): CADDocument {
    const doc = millDoc();
    doc.machineKind = "laser";
    return doc;
  }
  const picker = (d: HTMLElement) => d.querySelector(".tp-preset-picker") as HTMLElement;
  const loadBtn = (d: HTMLElement) => d.querySelector(".tp-preset-load") as HTMLButtonElement;
  const saveBtn = (d: HTMLElement) => d.querySelector(".tp-preset-save") as HTMLButtonElement;

  /**
   * Answer the name prompt the Save button opens. It used to be native
   * `prompt()`, stubbed with `vi.stubGlobal`; it is now `promptDialog`, a real
   * dialog in the DOM — so drive it like one. `promptDialog` appends its
   * backdrop synchronously, so it is already present when this runs; the
   * trailing await lets the handler's `await` resume before we assert.
   */
  async function answerNamePrompt(value: string | null): Promise<void> {
    const backdrops = document.querySelectorAll<HTMLElement>(".tp-backdrop");
    const dlg = backdrops[backdrops.length - 1];
    if (!dlg?.querySelector(".tp-apply-btn")) throw new Error("no name prompt opened");
    if (value === null) {
      dlg.querySelectorAll<HTMLButtonElement>(".tp-dialog-footer .btn")[0].click(); // Cancel
    } else {
      (dlg.querySelector("input") as HTMLInputElement).value = value;
      dlg.querySelector<HTMLButtonElement>(".tp-apply-btn")?.click();
    }
    await Promise.resolve();
  }

  beforeEach(() => {
    localStorage.clear();
  });

  test("the preset row rides in the laser section, hidden on a mill document", () => {
    const laserDialog = openDialog(laserDoc());
    expect(laserDialog.querySelector(".tp-preset-row")).toBeTruthy();

    document.body.innerHTML = "";
    const millDialog = openDialog(millDoc());
    // The row exists but its whole section is display:none for a spindle job.
    const section = millDialog.querySelector(".tp-preset-row")?.closest(".tp-dialog-section");
    expect((section as HTMLElement).style.display).toBe("none");
  });

  test("an empty library says how to make one instead of offering numbers", () => {
    const dialog = openDialog(laserDoc());
    loadBtn(dialog).click();

    const empty = picker(dialog).querySelector(".tp-preset-empty");
    expect(empty).toBeTruthy();
    // No fabricated starter recipe: power/speed are machine-specific.
    expect(empty?.textContent).toMatch(/Material Test/);
    expect(picker(dialog).querySelectorAll(".tp-preset-item")).toHaveLength(0);
  });

  test("saving a preset then loading it fills the fields back in", async () => {
    const dialog = openDialog(laserDoc());

    // Dial in values the way a user would, then save them.
    const power = row(dialog, "Power").querySelector("input") as HTMLInputElement;
    const passes = row(dialog, "Passes").querySelector("input") as HTMLInputElement;
    power.value = "42";
    power.dispatchEvent(new Event("change"));
    passes.value = "3";
    passes.dispatchEvent(new Event("change"));

    saveBtn(dialog).click();
    await answerNamePrompt("3mm ply");

    // A fresh dialog starts back at the defaults...
    document.body.innerHTML = "";
    const fresh = openDialog(laserDoc());
    const freshPower = row(fresh, "Power").querySelector("input") as HTMLInputElement;
    expect(freshPower.value).not.toBe("42");

    // ...until the saved recipe is applied, which must repopulate the inputs and
    // not merely mutate state behind them.
    loadBtn(fresh).click();
    const item = picker(fresh).querySelector(".tp-preset-item") as HTMLElement;
    expect(item.textContent).toContain("3mm ply");
    item.click();

    expect((row(fresh, "Power").querySelector("input") as HTMLInputElement).value).toBe("42");
    expect((row(fresh, "Passes").querySelector("input") as HTMLInputElement).value).toBe("3");
  });

  test("a cut recipe is never offered on an engrave op", async () => {
    const dialog = openDialog(laserDoc());
    saveBtn(dialog).click(); // default combo is profile-outside -> kind "cut"
    await answerNamePrompt("ply CUT 100%");

    // Positive control: it IS offered on the cut op that saved it.
    loadBtn(dialog).click();
    expect(picker(dialog).querySelectorAll(".tp-preset-item")).toHaveLength(1);

    // Switching type with the picker still OPEN must re-filter it in place. A
    // stale cut recipe left on screen is clickable, and applying one to an
    // engrave op sets roughly five times the power that job wants.
    selectType(dialog, "engrave");
    expect(picker(dialog).querySelectorAll(".tp-preset-item")).toHaveLength(0);
    expect(picker(dialog).querySelector(".tp-preset-empty")?.textContent).toMatch(/engrave/);
  });

  test("cancelling the name prompt saves nothing", async () => {
    const dialog = openDialog(laserDoc());
    saveBtn(dialog).click();
    // Positive control first: the prompt really opened, so the "nothing was
    // saved" assertion below is about Cancel and not about a prompt that never
    // appeared. (Exactly that made this test pass vacuously mid-conversion.)
    expect(document.querySelector(".tp-apply-btn"), "no name prompt opened").toBeTruthy();
    await answerNamePrompt(null);

    loadBtn(dialog).click();
    expect(picker(dialog).querySelectorAll(".tp-preset-item")).toHaveLength(0);
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

describe("Add-Toolpath dialog: shared clamping", () => {
  /**
   * A field's bounds live in ONE table (`OP_PARAMS` in model/variables.ts). The
   * row clamps through it on commit and `applyOpParam` clamps through it on
   * every solve. Before they were unified, a row and its expression could
   * settle on different numbers for the same field — e.g. the relief stepover
   * floored at 0.01 in the dialog and 0.001 on solve.
   */
  test("a typed value is clamped to the field's bounds", () => {
    const dialog = openDialog(millDoc());
    selectType(dialog, "pocket");
    const stepover = row(dialog, "Stepover").querySelector("input") as HTMLInputElement;

    stepover.value = "5"; // above the 0..1 range
    stepover.dispatchEvent(new Event("change"));
    expect(stepover.value).toBe("1");

    stepover.value = "-3";
    stepover.dispatchEvent(new Event("change"));
    expect(stepover.value).toBe("0.01");
  });

  test("a formula and a typed number land on the same clamped value", () => {
    const doc = millDoc();
    doc.addVariable(makeVariable("wide", "5", "mm")); // resolves above the max
    const dialog = openDialog(doc);
    selectType(dialog, "pocket");
    const stepover = row(dialog, "Stepover").querySelector("input") as HTMLInputElement;

    // Drive it with an expression: the row shows the formula...
    stepover.value = "wide";
    stepover.dispatchEvent(new Event("change"));
    expect(stepover.value).toBe("wide");

    // ...and the operation it builds carries the SAME clamped number a typed
    // "5" produced above, not the raw 5.
    const op = { stepover: 0 } as unknown as CAMOperation;
    expect(applyOpParam(op, "stepover", 5)).toBe(true);
    expect(op.stepover).toBe(1);
  });

  test("depth always resolves below the surface, typed or driven", () => {
    const dialog = openDialog(millDoc());
    const depth = row(dialog, "Depth").querySelector("input") as HTMLInputElement;

    depth.value = "8"; // a user typing a positive depth means "8 deep"
    depth.dispatchEvent(new Event("change"));
    // A length field renders through lenView, so compare the number, not the text.
    expect(parseFloat(depth.value)).toBe(-8);

    const op = { depth: 0 } as unknown as CAMOperation;
    applyOpParam(op, "depth", 8);
    expect(op.depth).toBe(-8);
  });
});

describe("Add-Toolpath dialog: V-carve halftone", () => {
  /** A mill doc whose only entity is a selected greyscale image. */
  function imageDoc(): CADDocument {
    registerEmbeddedImage({
      id: "ht-dlg",
      name: "ht-dlg",
      width: 2,
      height: 2,
      data: btoa(String.fromCharCode(0, 128, 200, 255)),
    });
    const doc = new CADDocument({ width: 300, height: 200 });
    doc.stockThickness = 19.05;
    const img = new RasterImageEntity("ht-dlg", { x: 10, y: 10 }, 40, 40, 0);
    doc.add(img);
    img.selected = true;
    return doc;
  }

  const toolSelect = (dialog: HTMLElement) =>
    row(dialog, "Tool Type").querySelector("select") as HTMLSelectElement;

  const setTool = (dialog: HTMLElement, t: string): void => {
    const sel = toolSelect(dialog);
    sel.value = t;
    sel.dispatchEvent(new Event("change"));
  };

  test("the halftone row appears when a V-bit is loaded, not before", () => {
    // The bug this guards: the tool lives in a different section, and nothing
    // told the cut section a tool had been PICKED (only the reverse — a section
    // forcing a tool). So the option stayed hidden however the user set the bit,
    // and the only way to reach it was not to need it. Found by opening the app.
    const dialog = openDialog(imageDoc());
    selectType(dialog, "engrave");
    // An image engrave forces a depth-shaping bit; a ball-nose has no groove to
    // widen, so the option is correctly absent here.
    expect(toolSelect(dialog).value).toBe("ball-nose");
    expect(shown(row(dialog, "V-carve halftone"))).toBe(false);

    setTool(dialog, "v-bit");
    expect(shown(row(dialog, "V-carve halftone"))).toBe(true);
  });

  test("ticking halftone hides the stepover it derives, and reveals the land", () => {
    const dialog = openDialog(imageDoc());
    selectType(dialog, "engrave");
    setTool(dialog, "v-bit");
    expect(shown(row(dialog, "Relief stepover"))).toBe(true);
    expect(shown(row(dialog, "Groove land"))).toBe(false);

    const chk = row(dialog, "V-carve halftone").querySelector(
      "input[type=checkbox]",
    ) as HTMLInputElement;
    chk.click();

    // A halftone's row pitch IS the bit's groove width — leaving the stepover
    // field on screen while it is ignored is the same lie as a dead control.
    expect(shown(row(dialog, "Relief stepover"))).toBe(false);
    expect(shown(row(dialog, "Groove land"))).toBe(true);
  });

  test("switching back off a V-bit takes the halftone rows with it", () => {
    const dialog = openDialog(imageDoc());
    selectType(dialog, "engrave");
    setTool(dialog, "v-bit");
    (
      row(dialog, "V-carve halftone").querySelector("input[type=checkbox]") as HTMLInputElement
    ).click();
    expect(shown(row(dialog, "Groove land"))).toBe(true);

    setTool(dialog, "ball-nose");
    expect(shown(row(dialog, "V-carve halftone"))).toBe(false);
    expect(shown(row(dialog, "Groove land"))).toBe(false);
    expect(shown(row(dialog, "Relief stepover"))).toBe(true);
  });
});

describe("Add-Toolpath dialog: the type caption", () => {
  const caption = (dialog: HTMLElement) =>
    dialog.querySelector(".tp-type-hint") as HTMLElement;
  const pairs = (dialog: HTMLElement) =>
    dialog.querySelector(".tp-type-pairs") as HTMLElement;

  test("describes the type the dialog opened on", () => {
    const dialog = openDialog(millDoc());
    expect(caption(dialog).textContent).toMatch(/outside of the line/);
  });

  test("follows the dropdown", () => {
    const dialog = openDialog(millDoc());
    selectType(dialog, "drill");
    expect(caption(dialog).textContent).toMatch(/circle/i);
    selectType(dialog, "pocket");
    expect(caption(dialog).textContent).toMatch(/inside a closed shape/i);
    // Control: it changed rather than accumulating both.
    expect(caption(dialog).textContent).not.toMatch(/circle/i);
  });

  test("draws a diagram, and redraws it when the type changes", () => {
    const dialog = openDialog(millDoc());
    const svg = () => dialog.querySelector(".tp-type-art svg");
    // Not just "an svg exists" — an empty one would render as a blank box.
    expect(svg()?.childElementCount ?? 0).toBeGreaterThan(0);
    const before = svg()!.innerHTML;

    selectType(dialog, "drill");
    expect(svg()?.childElementCount ?? 0).toBeGreaterThan(0);
    expect(svg()!.innerHTML).not.toBe(before);
  });

  test("only Relief Roughing gets a pairing line, and it names the Engrave pass", () => {
    // The gap that prompted this: nothing said relief roughing leaves a
    // staircase and needs a second op to become a surface.
    const dialog = openDialog(millDoc());
    expect(shown(pairs(dialog))).toBe(false);

    selectType(dialog, "relief-rough");
    expect(shown(pairs(dialog))).toBe(true);
    expect(pairs(dialog).textContent).toMatch(/Engrave/);
    expect(pairs(dialog).textContent).toMatch(/ball-nose/);

    selectType(dialog, "pocket");
    expect(shown(pairs(dialog))).toBe(false);
  });
});
