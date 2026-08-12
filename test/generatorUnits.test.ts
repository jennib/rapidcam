// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { CADDocument } from "../src/model/document";
import { GENERATORS } from "../src/generators/index";
import { Sketch } from "../src/generators/sketch";
import { kumiko } from "../src/generators/kumiko";
import { openGeneratorDialog } from "../src/ui/generatorDialog";

/**
 * Units in the generator dialog.
 *
 * The dialog read and wrote raw millimetres regardless of the document's
 * display unit, so an inch project showed "200" for a 7.874" panel and every
 * generator note quoted mm at a user working in inches — including the ones
 * carrying a number you act on ("cut with a ⌀4.6 mm bit"). None of it was
 * caught, because nothing tested this surface at all.
 *
 * The load-bearing distinction is that a generator param is a length OR a bare
 * count, and only the model knows which — converting a tooth count by 25.4
 * would be far worse than the bug being fixed. Hence `ParamSpec.unit`, and
 * hence the drift guard below.
 */

/** Open the dialog for `gen` over `doc` and return its root element. */
function openDialog(doc: CADDocument, genId: string): HTMLElement {
  openGeneratorDialog({ doc, pushHistory: () => {}, gen: GENERATORS[genId] });
  const dialogs = [...document.querySelectorAll(".tp-dialog")];
  return dialogs[dialogs.length - 1] as HTMLElement;
}

function field(dialog: HTMLElement, labelStarts: string): HTMLInputElement {
  const row = [...dialog.querySelectorAll(".tp-field")].find((r) =>
    r.querySelector("label")?.textContent?.startsWith(labelStarts),
  );
  if (!row) throw new Error(`no field labelled ${labelStarts}`);
  return row.querySelector("input") as HTMLInputElement;
}

function apply(dialog: HTMLElement): void {
  (dialog.querySelector(".tp-apply-btn") as HTMLButtonElement).click();
}

function inchDoc(): CADDocument {
  const doc = new CADDocument({ width: 400, height: 400 });
  doc.displayUnit = "in";
  return doc;
}

// --- the model tag ----------------------------------------------------------

test("s.param records the length tag, and omits it for a bare count", () => {
  const s = new Sketch();
  s.param("width", 100, { unit: "len", label: "Width" });
  s.param("teeth", 20, { int: true, label: "Teeth" });
  expect(s.params[0].unit).toBe("len");
  expect(s.params[1].unit).toBeUndefined();
});

test("every generator parameter is either a tagged length or plainly unitless", () => {
  // The guard promised in ParamSpec.unit's docstring. A new length param that
  // forgets the tag silently reverts the bug this file exists for, and nothing
  // else would notice — the dialog would just show mm again.
  const DIMENSIONLESS: Record<string, string> = {
    // param name -> why it carries no length
    pressureAngle: "degrees",
  };
  const untagged: string[] = [];
  for (const [id, gen] of Object.entries(GENERATORS)) {
    const s = new Sketch();
    gen.build(s);
    for (const p of s.params) {
      const ok = p.unit === "len" || p.int || p.choices || p.name in DIMENSIONLESS;
      if (!ok) untagged.push(`${id}.${p.name}`);
    }
  }
  expect(untagged).toEqual([]);
});

test("the guard would actually catch an untagged length", () => {
  // Positive control: the check above passes vacuously if the predicate is
  // wrong, so prove a bare unnamed scalar fails it.
  const s = new Sketch();
  s.param("depth", 6, { label: "Depth" });
  const p = s.params[0];
  expect(p.unit === "len" || p.int || p.choices).toBeFalsy();
});

// --- notes ------------------------------------------------------------------

test("Sketch.len formats in the sketch's display unit", () => {
  expect(new Sketch().len(25.4)).toBe("25.40 mm");
  expect(new Sketch({ displayUnit: "in" }).len(25.4)).toBe("1.000 in");
  expect(new Sketch({ displayUnit: "in" }).len(25.4, 1)).toBe("1.0 in");
});

test("generator notes quote no millimetres in an inch document", () => {
  const s = new Sketch({ displayUnit: "in", params: { bar: 6, pitch: 12 } });
  kumiko.build(s);
  expect(s.notes.length).toBeGreaterThan(0);
  for (const n of s.notes) expect(n).not.toMatch(/\bmm\b/);
  expect(s.notes.join(" ")).toMatch(/\bin\b/);
});

test("...and does quote them in a millimetre document", () => {
  // Positive control for the negative assertion above: a generator that emitted
  // no notes at all, or notes with no measurements, would pass it silently.
  const s = new Sketch({ params: { bar: 6, pitch: 12 } });
  kumiko.build(s);
  expect(s.notes.join(" ")).toMatch(/\bmm\b/);
});

// --- the dialog -------------------------------------------------------------

test("a length field shows the document unit in its label and its value", () => {
  const dialog = openDialog(inchDoc(), "kumiko-asanoha");
  const width = field(dialog, "Width");
  expect(width.value).toBe("7.874"); // 200 mm
  // Looked up by name, not by position: this asserted the first label in the
  // dialog until a Pattern dropdown was added ahead of it.
  const label = [...dialog.querySelectorAll(".tp-field label")].find((l) =>
    l.textContent?.startsWith("Width"),
  ) as HTMLElement;
  expect(label.textContent).toBe("Width (in)");
});

test("a count field is left alone — no label suffix, no conversion", () => {
  const dialog = openDialog(inchDoc(), "box-joint");
  const fingers = field(dialog, "Fingers");
  expect(fingers.value).toBe("6");
  const row = [...dialog.querySelectorAll(".tp-field")].find((r) =>
    r.querySelector("label")?.textContent?.startsWith("Fingers"),
  );
  expect(row?.querySelector("label")?.textContent).toBe("Fingers");
});

test("typing inches commits millimetres", () => {
  const doc = inchDoc();
  const dialog = openDialog(doc, "kumiko-asanoha");
  field(dialog, "Width").value = "8";
  field(dialog, "Height").value = "6";
  apply(dialog);

  const feature = doc.features[0];
  expect(feature.params.width).toBeCloseTo(203.2, 6); // 8 in
  expect(feature.params.height).toBeCloseTo(152.4, 6); // 6 in
});

test("a unit suffix overrides the document unit, fractions included", () => {
  const doc = inchDoc();
  const dialog = openDialog(doc, "kumiko-asanoha");
  field(dialog, "Width").value = "250mm";
  field(dialog, "Bar width").value = '1/8"';
  apply(dialog);

  const feature = doc.features[0];
  expect(feature.params.width).toBeCloseTo(250, 6);
  expect(feature.params.bar).toBeCloseTo(3.175, 6);
});

test("an expression stays internal mm and is stored as a formula", () => {
  // The repo-wide convention (camBar paramRow, dimEditor, variables): a bare
  // number is display units, but bare numbers INSIDE a formula are already mm.
  const doc = inchDoc();
  doc.stockThickness = 18;
  const dialog = openDialog(doc, "kumiko-asanoha");
  field(dialog, "Bar width").value = "stock / 2";
  apply(dialog);

  const feature = doc.features[0];
  expect(feature.params.bar).toBeCloseTo(9, 6); // 9 mm, NOT 9 in
  expect(feature.paramExprs?.bar).toBe("stock / 2");
});

test("a millimetre document is unchanged — values and labels stay bare mm", () => {
  const doc = new CADDocument({ width: 400, height: 400 });
  const dialog = openDialog(doc, "kumiko-asanoha");
  expect(field(dialog, "Width").value).toBe("200.00");
  field(dialog, "Width").value = "180";
  apply(dialog);
  expect(doc.features[0].params.width).toBeCloseTo(180, 6);
});

test("an untouched field commits its exact original value, not a re-parse", () => {
  // Inch precision is 3 dp, so 160 mm shows as "6.299" and reads back as
  // 159.9946. Editing only the width must not nudge every other parameter.
  const doc = inchDoc();
  const dialog = openDialog(doc, "kumiko-asanoha");
  field(dialog, "Width").value = "8";
  apply(dialog);

  const p = doc.features[0].params;
  expect(p.width).toBeCloseTo(203.2, 9); // the one field actually edited
  expect(p.height).toBe(160); // exactly, not 159.9946
  expect(p.pitch).toBe(40);
  expect(p.bar).toBe(3);
  expect(p.frame).toBe(10);
});

test("an untouched expression field keeps its formula", () => {
  const doc = inchDoc();
  doc.stockThickness = 18;
  const first = openDialog(doc, "kumiko-asanoha");
  field(first, "Bar width").value = "stock / 2";
  apply(first);
  const id = doc.features[0].id;
  expect(doc.features[0].paramExprs?.bar).toBe("stock / 2");

  // Re-open that feature and Update without touching anything.
  openGeneratorDialog({ doc, pushHistory: () => {}, gen: GENERATORS["kumiko-asanoha"], editFeatureId: id });
  const dialogs = [...document.querySelectorAll(".tp-dialog")];
  const second = dialogs[dialogs.length - 1] as HTMLElement;
  expect(field(second, "Bar width").value).toBe("stock / 2");
  apply(second);
  expect(doc.features[0].paramExprs?.bar).toBe("stock / 2");
  expect(doc.features[0].params.bar).toBeCloseTo(9, 9);
});

test("the range hint is shown in the field's unit, not raw mm", () => {
  const dialog = openDialog(inchDoc(), "kumiko-asanoha");
  const row = [...dialog.querySelectorAll(".tp-field")].find((r) =>
    r.querySelector("label")?.textContent?.startsWith("Bar width"),
  );
  // min 0.5 mm reads as min 0.020 in, not "min 0.5".
  expect(row?.textContent).toContain("0.020");
});
