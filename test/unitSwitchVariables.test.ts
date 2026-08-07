/**
 * Switching the project's display unit must not change what any variable MEANS.
 *
 * `Variable.expr` is the raw input and is re-parsed on every solve via
 * `parseLength(expr, displayUnit)`, so a bare "10" means "10 of whatever the
 * project currently displays". Flipping a mm project to inches therefore
 * silently re-read 10 as 10 INCHES and wrote 254mm — not at the moment of the
 * switch (nothing re-evaluates then), but on the next solve any drag triggered,
 * dragging every dimension and binding driven from it along with it.
 */
import { expect, test } from "vitest";
import { CADDocument } from "../src/model/document";
import { evaluateAll, makeVariable, pinVariableUnits } from "../src/model/variables";

/** Flip the display unit the way SettingsBar does, then solve. */
function switchUnitAndSolve(doc: CADDocument, to: "mm" | "in"): void {
  pinVariableUnits(doc.variables, doc.displayUnit);
  doc.displayUnit = to;
  evaluateAll(doc.variables, doc.dimensions, doc.displayUnit, doc.stockThickness, doc.operations);
}

test("a bare-number variable keeps its physical size across a unit switch", () => {
  const doc = new CADDocument({ width: 300, height: 200 }, "mm");
  doc.addVariable(makeVariable("w", "10", "mm"));
  expect(doc.variables[0].value).toBe(10);

  switchUnitAndSolve(doc, "in");

  expect(doc.variables[0].value, "10mm is still 10mm when only the DISPLAY changes").toBe(10);
  // The expr is now self-describing, so it can never be re-read as inches.
  expect(doc.variables[0].expr).toBe("10mm");
});

test("it survives repeated switches without drifting", () => {
  const doc = new CADDocument({ width: 300, height: 200 }, "mm");
  doc.addVariable(makeVariable("w", "10", "mm"));

  switchUnitAndSolve(doc, "in");
  switchUnitAndSolve(doc, "mm");
  switchUnitAndSolve(doc, "in");

  expect(doc.variables[0].value).toBe(10);
});

test("fractional and mixed-fraction inputs are pinned too", () => {
  const doc = new CADDocument({ width: 300, height: 200 }, "in");
  doc.addVariable(makeVariable("half", "1/2", "in")); // 12.7mm
  doc.addVariable(makeVariable("mixed", "3 1/4", "in")); // 82.55mm
  expect(doc.variables[0].value).toBeCloseTo(12.7, 6);
  expect(doc.variables[1].value).toBeCloseTo(82.55, 6);

  switchUnitAndSolve(doc, "mm");

  expect(doc.variables[0].value).toBeCloseTo(12.7, 6);
  expect(doc.variables[1].value).toBeCloseTo(82.55, 6);
});

test("an already unit-qualified expr is left exactly as the user typed it", () => {
  const doc = new CADDocument({ width: 300, height: 200 }, "mm");
  doc.addVariable(makeVariable("a", "50mm", "mm"));
  doc.addVariable(makeVariable("b", "3.5in", "mm"));

  switchUnitAndSolve(doc, "in");

  expect(doc.variables[0].expr).toBe("50mm"); // not "50mmmm"
  expect(doc.variables[1].expr).toBe("3.5in");
  expect(doc.variables[0].value).toBe(50);
  expect(doc.variables[1].value).toBeCloseTo(88.9, 6);
});

test("a formula is not touched — bare numbers inside one are already mm", () => {
  const doc = new CADDocument({ width: 300, height: 200 }, "mm");
  doc.addVariable(makeVariable("base", "10", "mm"));
  doc.addVariable(makeVariable("derived", "base * 2", "mm"));

  switchUnitAndSolve(doc, "in");

  expect(doc.variables[1].expr, "a formula must stay a formula").toBe("base * 2");
  expect(doc.variables[1].value).toBe(20);
});

test("a variable authored in inches pins to inches, not to the incoming unit", () => {
  const doc = new CADDocument({ width: 300, height: 200 }, "in");
  doc.addVariable(makeVariable("w", "2", "in")); // 50.8mm
  expect(doc.variables[0].value).toBeCloseTo(50.8, 6);

  switchUnitAndSolve(doc, "mm");

  expect(doc.variables[0].expr).toBe("2in");
  expect(doc.variables[0].value).toBeCloseTo(50.8, 6);
});

test("zero needs no pinning — it is the same length in every unit", () => {
  const doc = new CADDocument({ width: 300, height: 200 }, "mm");
  doc.addVariable(makeVariable("z", "0", "mm"));

  switchUnitAndSolve(doc, "in");

  expect(doc.variables[0].expr).toBe("0");
  expect(doc.variables[0].value).toBe(0);
});
