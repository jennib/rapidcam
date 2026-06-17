import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { CircleEntity } from "../src/model/entities";
import { makeConstraint } from "../src/model/constraints";
import { solve } from "../src/solver/solver";

// Regression: a horizontal/vertical constraint defined on a point PAIR (no line
// entity) must solve. Previously lineGeom() threw on the undefined entity ref
// before the residual could fall through to its point-pair path.
test("point-pair horizontal constraint solves and equalises Y", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  const a = doc.add(new CircleEntity({ x: 0, y: 0 }, 2));
  const b = doc.add(new CircleEntity({ x: 10, y: 5 }, 2));
  doc.addConstraint(makeConstraint("fixedPoint", { points: [{ entityId: a.id, key: "c" }], params: [0, 0] }));
  doc.addConstraint(makeConstraint("horizontal", { points: [{ entityId: a.id, key: "c" }, { entityId: b.id, key: "c" }] }));

  const r = solve(doc);
  expect(r.converged).toBe(true);
  expect((b as CircleEntity).center.y).toBeCloseTo(0, 3);
});

test("point-pair vertical constraint solves and equalises X", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  const a = doc.add(new CircleEntity({ x: 0, y: 0 }, 2));
  const b = doc.add(new CircleEntity({ x: 10, y: 5 }, 2));
  doc.addConstraint(makeConstraint("fixedPoint", { points: [{ entityId: a.id, key: "c" }], params: [0, 0] }));
  doc.addConstraint(makeConstraint("vertical", { points: [{ entityId: a.id, key: "c" }, { entityId: b.id, key: "c" }] }));

  const r = solve(doc);
  expect(r.converged).toBe(true);
  expect((b as CircleEntity).center.x).toBeCloseTo(0, 3);
});
