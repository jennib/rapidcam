import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { CircleEntity } from "../src/model/entities";
import { solve } from "../src/solver/solver";
import { evaluateAll, makeVariable } from "../src/model/variables";
import { bindingResiduals } from "../src/model/bindings";
import { serializeDoc, applyFile } from "../src/io/fileio";

function resolve(doc: CADDocument) {
  evaluateAll(doc.variables, doc.dimensions, doc.displayUnit, doc.entities);
  return solve(doc);
}

test("a scalar binding drives a circle's radius from a variable formula", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  const c = doc.add(new CircleEntity({ x: 100, y: 100 }, 10));
  doc.variables.push(makeVariable("plateW", "80", "mm"));
  doc.bindings.push({ id: "b1", entityId: c.id, scalarKey: "r", expr: "plateW/2" });

  resolve(doc);
  expect(c.radius).toBeCloseTo(40, 3);      // 80/2

  // Changing the variable re-drives the radius on the next solve.
  doc.variables[0].expr = "100";
  resolve(doc);
  expect(c.radius).toBeCloseTo(50, 3);      // 100/2
});

test("solve reports constraints when only a binding is present", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  const c = doc.add(new CircleEntity({ x: 50, y: 50 }, 5));
  doc.variables.push(makeVariable("r0", "12", "mm"));
  doc.bindings.push({ id: "b1", entityId: c.id, scalarKey: "r", expr: "r0" });
  const res = resolve(doc);
  expect(res.hasConstraints).toBe(true);
  expect(c.radius).toBeCloseTo(12, 3);
});

test("bindingResiduals is empty for a broken formula (deleted variable)", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  const c = doc.add(new CircleEntity({ x: 50, y: 50 }, 5));
  const geo = (id: string) => doc.entities.find((e) => e.id === id);
  // no such variable → evalExpr returns null → no residual (radius left alone)
  expect(bindingResiduals({ id: "b", entityId: c.id, scalarKey: "r", expr: "ghost*2" }, geo, new Map())).toEqual([]);
  const before = c.radius;
  resolve(doc);
  expect(c.radius).toBe(before);
});

test("deleting the entity prunes its binding", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  const c = doc.add(new CircleEntity({ x: 50, y: 50 }, 5));
  doc.bindings.push({ id: "b1", entityId: c.id, scalarKey: "r", expr: "r0" });
  doc.remove(c);
  expect(doc.bindings).toHaveLength(0);
});

test("renaming a variable rewrites binding formulas", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  const c = doc.add(new CircleEntity({ x: 50, y: 50 }, 5));
  doc.bindings.push({ id: "b1", entityId: c.id, scalarKey: "r", expr: "plateW/2" });
  doc.renameVariableRefs("plateW", "boardW");
  expect(doc.bindings[0].expr).toBe("boardW/2");
});

test("bindings round-trip through save/load", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  const c = doc.add(new CircleEntity({ x: 50, y: 50 }, 5));
  doc.bindings.push({ id: "b1", entityId: c.id, scalarKey: "r", expr: "plateW/2" });
  const doc2 = new CADDocument({ width: 1, height: 1 });
  applyFile(doc2, serializeDoc(doc, "b"));
  expect(doc2.bindings).toEqual([{ id: "b1", entityId: c.id, scalarKey: "r", expr: "plateW/2" }]);
});
