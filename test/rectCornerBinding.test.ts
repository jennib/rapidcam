import { expect, test } from "vitest";
import { CADDocument } from "../src/model/document";
import { CircleEntity, RectEntity } from "../src/model/entities";
import { makeVariable } from "../src/model/variables";
import { solve } from "../src/solver/solver";
import { applyFile, serializeDoc } from "../src/io/fileio";

/**
 * A corner radius driven by a formula.
 *
 * `cr` is the rectangle's scalar DOF, so it rides the same parametric channel a
 * circle's radius does: `Radius = stock * 2` in the properties field parks a
 * ScalarBinding, and the solver drives the corners to it.
 *
 * The distinction that shapes the design: unlike a circle's `r`, which
 * tangent/equal/radius constraints act on, NO constraint type reads a corner
 * radius. Leaving it free would add a variable per rectangle that the solver
 * could only ever hold still, so it is fixed unless a binding drives it. Both
 * halves of that are asserted here — the second one against the variable count,
 * because "it feels fast" is not a test.
 */

/**
 * All four corners at `r`.
 *
 * Not toEqual: the solver is iterative, so a driven radius lands within a few
 * NANOMETRES of its target rather than exactly on it — the same convergence a
 * circle's bound radius has always had. 4 decimal places is 0.1µm, far below
 * anything a machine can cut and far above the residual.
 */
function expectRadii(rect: RectEntity, r: number): void {
  for (const [i, actual] of rect.cornerRadii.entries()) {
    expect(actual, `corner ${i}`).toBeCloseTo(r, 4);
  }
}

function docWithRect(w = 80, h = 60) {
  const doc = new CADDocument({ width: 300, height: 200 }, "mm");
  const rect = doc.add(new RectEntity({ x: 0, y: 0 }, { x: w, y: h }));
  return { doc, rect };
}

test("a formula on the radius drives all four corners through a real solve", () => {
  const { doc, rect } = docWithRect();
  doc.variables.push(makeVariable("edge", "5", "mm"));
  doc.bindings.push({ id: "b1", entityId: rect.id, scalarKey: "cr", expr: "edge * 2" });

  solve(doc);
  expectRadii(rect, 10);
  expect(rect.hasShapedCorners()).toBe(true);
});

test("changing the variable re-cuts the corners", () => {
  const { doc, rect } = docWithRect();
  doc.variables.push(makeVariable("edge", "5", "mm"));
  doc.bindings.push({ id: "b1", entityId: rect.id, scalarKey: "cr", expr: "edge * 2" });
  solve(doc);

  const v = doc.variables[0];
  v.expr = "3";
  v.value = 3;
  solve(doc);
  expectRadii(rect, 6);

  // The boundary really followed — the whole point of a parametric radius.
  const bl = rect.corners()[0];
  const nearest = Math.min(
    ...rect.outlinePoints(0.001).map((p) => Math.hypot(p.x - bl.x, p.y - bl.y)),
  );
  expect(nearest).toBeCloseTo(6 * (Math.SQRT2 - 1), 2);
});

test("`stock` drives it too — corners that follow the material", () => {
  // The most useful case: a radius tied to the stock thickness.
  const { doc, rect } = docWithRect();
  doc.stockThickness = 12;
  doc.bindings.push({ id: "b1", entityId: rect.id, scalarKey: "cr", expr: "stock / 2" });
  solve(doc);
  expectRadii(rect, 6);
});

test("an UNBOUND rectangle adds no solver variable for its radius", () => {
  // The reason `cr` is fixed by default. A rectangle contributes exactly its two
  // point DOFs (bl, tr) = 4 variables, as it did before corner radii existed.
  const { doc, rect } = docWithRect();
  rect.cornerRadii = [5, 5, 5, 5]; // shaped, but nothing drives it
  const before = solve(doc);
  expect(before.variables).toBe(4);

  // Positive control: binding it DOES add the variable, so the 4 above means
  // "held fixed", not "scalars are never counted".
  doc.variables.push(makeVariable("edge", "5", "mm"));
  doc.bindings.push({ id: "b1", entityId: rect.id, scalarKey: "cr", expr: "edge" });
  const after = solve(doc);
  expect(after.variables).toBe(5);
});

test("binding the radius does not change the sketch's free DOF count", () => {
  // The binding adds one variable AND one equation, so the status bar reads the
  // same before and after — a radius formula is not new freedom to constrain.
  const { doc, rect } = docWithRect();
  const free = solve(doc).dof;
  doc.variables.push(makeVariable("edge", "5", "mm"));
  doc.bindings.push({ id: "b1", entityId: rect.id, scalarKey: "cr", expr: "edge" });
  expect(solve(doc).dof).toBe(free);
});

test("a rectangle's radius does not disturb a circle's — different scalar keys", () => {
  const { doc, rect } = docWithRect();
  const circle = doc.add(new CircleEntity({ x: 40, y: 30 }, 7));
  doc.variables.push(makeVariable("edge", "4", "mm"));
  doc.bindings.push(
    { id: "b1", entityId: rect.id, scalarKey: "cr", expr: "edge" },
    { id: "b2", entityId: circle.id, scalarKey: "r", expr: "edge * 3" },
  );
  solve(doc);
  expectRadii(rect, 4);
  expect(circle.radius).toBeCloseTo(12, 4);
});

test("a broken formula leaves the last resolved radius alone", () => {
  // evalExpr fails → no residual → the geometry holds its last good value
  // rather than collapsing to zero. A file never needs an expression evaluated.
  const { doc, rect } = docWithRect();
  rect.cornerRadii = [7, 7, 7, 7];
  doc.bindings.push({ id: "b1", entityId: rect.id, scalarKey: "cr", expr: "noSuchVar * 2" });
  solve(doc);
  expect(rect.cornerRadii).toEqual([7, 7, 7, 7]);
});

test("the scalar reports the largest when the four differ", () => {
  // No single answer exists; a bound radius is about to make them equal anyway.
  const { rect } = docWithRect();
  rect.cornerRadii = [2, 9, 0, 4];
  expect(rect.dofScalars()).toEqual([{ key: "cr", value: 9 }]);
});

test("setting the scalar clears a mixed set to one radius", () => {
  const { doc, rect } = docWithRect();
  rect.cornerRadii = [2, 9, 0, 4];
  doc.variables.push(makeVariable("edge", "3", "mm"));
  doc.bindings.push({ id: "b1", entityId: rect.id, scalarKey: "cr", expr: "edge" });
  solve(doc);
  expectRadii(rect, 3);
});

test("a negative formula result squares the corners rather than inverting them", () => {
  const { doc, rect } = docWithRect();
  rect.cornerRadii = [5, 5, 5, 5];
  doc.variables.push(makeVariable("edge", "-4", "mm"));
  doc.bindings.push({ id: "b1", entityId: rect.id, scalarKey: "cr", expr: "edge" });
  solve(doc);
  expect(rect.cornerRadii).toEqual([0, 0, 0, 0]);
  expect(rect.outlinePoints()).toEqual(rect.corners());
});

test("a `fixed` constraint still locks the radius", () => {
  // fixed pins every DOF including scalars; a binding must not override that.
  const { doc, rect } = docWithRect();
  rect.cornerRadii = [5, 5, 5, 5];
  doc.addConstraint({
    id: "f1",
    type: "fixed",
    points: [],
    entities: [rect.id],
    params: [],
  });
  doc.variables.push(makeVariable("edge", "20", "mm"));
  doc.bindings.push({ id: "b1", entityId: rect.id, scalarKey: "cr", expr: "edge" });
  solve(doc);
  expect(rect.cornerRadii).toEqual([5, 5, 5, 5]);
});

test("a corner-radius binding round-trips through save/open", () => {
  const { doc, rect } = docWithRect();
  doc.variables.push(makeVariable("edge", "5", "mm"));
  doc.bindings.push({ id: "b1", entityId: rect.id, scalarKey: "cr", expr: "edge * 2" });
  solve(doc);

  const file = JSON.parse(JSON.stringify(serializeDoc(doc, "bound")));
  const fresh = new CADDocument({ width: 300, height: 200 });
  applyFile(fresh, file);

  const back = fresh.entities.find((e): e is RectEntity => e instanceof RectEntity)!;
  // The last resolved values are in the file, so the shape is right before any
  // formula is evaluated — a file never needs an expression to load.
  expectRadii(back, 10);
  expect(fresh.bindings.find((b) => b.scalarKey === "cr")?.expr).toBe("edge * 2");

  // And the formula is still live: change the variable, re-solve, corners move.
  fresh.variables[0].value = 2;
  solve(fresh);
  expectRadii(back, 4);
});
