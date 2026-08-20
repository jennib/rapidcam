/**
 * Built-in parametric keywords: stock/sheet/origin dimensions, math constants,
 * and the incrementing serial counter. These are resolved live from the document
 * (not stored as user variables) and layered UNDER user variables, so a user
 * definition of the same name wins.
 */
import { test, expect } from "vitest";
import { CADDocument, builtinContext } from "../src/model/document";
import { applyFile, serializeDoc } from "../src/io/fileio";
import { evalExpr } from "../src/core/expr";
import {
  builtinKeywords,
  evaluateVariables,
  makeVariable,
  varMap,
} from "../src/model/variables";

function flatDoc(): CADDocument {
  const doc = new CADDocument({ width: 300, height: 200 }, "mm");
  doc.stockThickness = 10;
  return doc;
}

test("math constants resolve to pi and e", () => {
  const vm = varMap([], builtinContext(flatDoc()));
  expect(vm.get("pi")).toBeCloseTo(Math.PI, 12);
  expect(vm.get("PI")).toBeCloseTo(Math.PI, 12);
  expect(vm.get("e")).toBeCloseTo(Math.E, 12);
  expect(vm.get("E")).toBeCloseTo(Math.E, 12);
  // `2*e` is Euler × 2, while `2e3` stays a scientific-notation literal.
  expect(evalExpr("2*e", vm)).toBeCloseTo(2 * Math.E, 12);
  expect(evalExpr("2e3", vm)).toBe(2000);
});

test("flat stock, sheet and origin keywords resolve from document state", () => {
  const doc = flatDoc();
  const vm = varMap([], builtinContext(doc));
  // stock fills the sheet (no stockRect), so width/height == canvas.
  expect(vm.get("stock")).toBe(10);
  expect(vm.get("stock_thickness")).toBe(10);
  expect(vm.get("stockThickness")).toBe(10);
  expect(vm.get("stock_t")).toBe(10);
  expect(vm.get("stock_width")).toBe(300);
  expect(vm.get("stockWidth")).toBe(300);
  expect(vm.get("stock_height")).toBe(200);
  expect(vm.get("sheet_width")).toBe(300);
  expect(vm.get("sheet_height")).toBe(200);
  // Flat blank: no rotary keywords.
  expect(vm.has("stock_diameter")).toBe(false);
  expect(vm.has("stock_circumference")).toBe(false);
  expect(vm.has("stock_wall")).toBe(false);
});

test("a positioned stockRect shrinks stock_width/height but not the sheet", () => {
  const doc = flatDoc();
  doc.stockRect = { x: 20, y: 15, width: 120, height: 80 };
  const vm = varMap([], builtinContext(doc));
  expect(vm.get("stock_width")).toBe(120);
  expect(vm.get("stock_height")).toBe(80);
  expect(vm.get("sheet_width")).toBe(300);
  expect(vm.get("sheet_height")).toBe(200);
});

test("origin coordinates follow a non-default WCS origin", () => {
  const doc = flatDoc();
  doc.origin = { x: "center", y: "center", z: "bed" };
  const vm = varMap([], builtinContext(doc));
  expect(vm.get("origin_x")).toBe(150);
  expect(vm.get("origin_y")).toBe(100);
  expect(vm.get("origin_z")).toBe(10); // bed origin → zOffset = stock thickness
  expect(vm.get("ox")).toBe(150);
  expect(vm.get("oz")).toBe(10);
});

test("rotary keywords resolve from the cylinder; flat/sheet keys are absent", () => {
  const doc = new CADDocument({ width: 300, height: 200 }, "mm");
  doc.machineKind = "mill-rotary";
  doc.rotary = { axisWord: "A", diameter: 60, wrapAxis: "y" };
  doc.stockThickness = 10;
  const vm = varMap([], builtinContext(doc));
  // canvas is the unrolled surface: length = width, circumference = height.
  expect(vm.get("stock_length")).toBe(300);
  expect(vm.get("stock_circumference")).toBe(200);
  expect(vm.get("stock_diameter")).toBeCloseTo(200 / Math.PI, 12);
  expect(vm.get("stock_wall")).toBe(10);
  // `stock` still means thickness (the radial wall) on a rotary job.
  expect(vm.get("stock")).toBe(10);
  expect(vm.has("stock_width")).toBe(false);
  expect(vm.has("stock_height")).toBe(false);
  expect(vm.has("sheet_width")).toBe(false);
  expect(vm.has("sheet_height")).toBe(false);
});

test("counter/serial/seq keywords track doc.counter", () => {
  const doc = flatDoc();
  doc.counter = 7;
  const vm = varMap([], builtinContext(doc));
  expect(vm.get("counter")).toBe(7);
  expect(vm.get("count")).toBe(7);
  expect(vm.get("serial")).toBe(7);
  expect(vm.get("serial_number")).toBe(7);
  expect(vm.get("serialNumber")).toBe(7);
  expect(vm.get("seq")).toBe(7);
});

test("builtins compose in formulas", () => {
  const doc = flatDoc();
  const vm = varMap([], builtinContext(doc));
  expect(evalExpr("(2 * pi * 10) / 6", vm)).toBeCloseTo((2 * Math.PI * 10) / 6, 10);
  expect(evalExpr("origin_x + stock_width / 2", vm)).toBeCloseTo(0 + 300 / 2, 10);
  expect(evalExpr("counter * 10", vm)).toBeCloseTo(10, 10);
  expect(evalExpr("stock - 2", vm)).toBeCloseTo(8, 10);
});

test("a user variable overrides a built-in of the same name", () => {
  const doc = flatDoc();
  const vars = [makeVariable("pi", "3", "mm"), makeVariable("stock", "7", "mm")];
  const vm = varMap(vars, builtinContext(doc));
  expect(vm.get("pi")).toBe(3);
  expect(vm.get("stock")).toBe(7);
  // Unrelated built-ins are untouched.
  expect(vm.get("stock_width")).toBe(300);
});

test("evaluateVariables seeds built-ins so a variable can reference them", () => {
  const doc = flatDoc();
  const vars = [makeVariable("margin", "stock_width * 0.1", "mm")];
  evaluateVariables(vars, "mm", builtinContext(doc));
  expect(vars[0].value).toBeCloseTo(30, 10);

  // And a user variable wins in the seed map too (consistent with varMap).
  const override = [makeVariable("pi", "3", "mm")];
  evaluateVariables(override, "mm", builtinContext(doc));
  expect(override[0].value).toBe(3);
});

test("builtinKeywords covers both spellings and all aliases", () => {
  const names = [...builtinKeywords(builtinContext(flatDoc())).keys()];
  for (const k of [
    "pi", "PI", "e", "E",
    "stock", "stock_thickness", "stockThickness", "stock_t",
    "stock_width", "stockWidth", "stock_w",
    "stock_height", "stockHeight", "stock_h",
    "sheet_width", "sheetWidth", "sheet_w",
    "sheet_height", "sheetHeight", "sheet_h",
    "origin_x", "originX", "ox", "origin_y", "originY", "oy", "origin_z", "originZ", "oz",
    "counter", "count", "serial", "serial_number", "serialNumber", "seq",
  ]) {
    expect(names, k).toContain(k);
  }
});

test("the counter round-trips through serialize/apply", () => {
  const doc = flatDoc();
  doc.counter = 42;
  const file = serializeDoc(doc, "counter");
  expect(file.counter).toBe(42);

  const restored = new CADDocument({ width: 1, height: 1 });
  applyFile(restored, file);
  expect(restored.counter).toBe(42);
});

test("a legacy file without a counter defaults to 1", () => {
  const doc = flatDoc();
  const file = serializeDoc(doc, "legacy");
  delete (file as { counter?: number }).counter;
  const restored = new CADDocument({ width: 1, height: 1 });
  applyFile(restored, file);
  expect(restored.counter).toBe(1);
});

