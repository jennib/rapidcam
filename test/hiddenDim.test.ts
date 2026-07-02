import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { makeDimension } from "../src/model/dimensions";
import { solve } from "../src/solver/solver";
import { evaluateAll, makeVariable } from "../src/model/variables";
import { serializeDoc, applyFile } from "../src/io/fileio";

function resolve(doc: CADDocument) {
  evaluateAll(doc.variables, doc.dimensions, doc.displayUnit, doc.entities);
  return solve(doc);
}

test("a hidden driving distance dimension drives a line's length from a formula", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const l = doc.add(new LineEntity({ x: 20, y: 20 }, { x: 40, y: 20 })); // length 20
  doc.variables.push(makeVariable("plateW", "120", "mm"));
  doc.dimensions.push(makeDimension("distance", {
    points: [{ entityId: l.id, key: "a" }, { entityId: l.id, key: "b" }],
    value: 20, offset: 0, driving: true, expr: "plateW", hidden: true,
  }));

  resolve(doc);
  expect(l.length).toBeCloseTo(120, 2);

  doc.variables[0].expr = "200";
  resolve(doc);
  expect(l.length).toBeCloseTo(200, 2);
});

test("a hidden dimension is not returned by dimensionAt (nothing drawn to click)", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const l = doc.add(new LineEntity({ x: 0, y: 50 }, { x: 100, y: 50 }));
  doc.dimensions.push(makeDimension("distance", {
    points: [{ entityId: l.id, key: "a" }, { entityId: l.id, key: "b" }],
    value: 100, offset: 0, driving: true, expr: "50", hidden: true,
  }));
  // Right on the line/dimension path, generous tolerance — still nothing to hit.
  expect(doc.dimensionAt({ x: 50, y: 50 }, 60)).toBeNull();
});

test("the hidden flag round-trips through save/load", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const l = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 10, y: 0 }));
  doc.dimensions.push(makeDimension("distance", {
    points: [{ entityId: l.id, key: "a" }, { entityId: l.id, key: "b" }],
    value: 10, offset: 0, driving: true, expr: "w", hidden: true,
  }));
  const doc2 = new CADDocument({ width: 1, height: 1 });
  applyFile(doc2, serializeDoc(doc, "h"));
  expect(doc2.dimensions[0].hidden).toBe(true);
});
