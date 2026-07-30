import { describe, expect, test } from "vitest";
import { CADDocument } from "../src/model/document";
import {
  ArcEntity,
  CircleEntity,
  LineEntity,
  PolylineEntity,
  RectEntity,
} from "../src/model/entities";
import { constraintResiduals, makeConstraint, segmentRef } from "../src/model/constraints";
import { makeDimension } from "../src/model/dimensions";
import { solve } from "../src/solver/solver";

/**
 * The solver partitions the constraint graph into independent subsystems and
 * solves each one separately. The partition is deliberately conservative — a
 * residual is assumed to depend on every variable of every entity it names — but
 * "conservative" was an argument, not a fact, and the first implementation got it
 * wrong: a polyline SEGMENT is referenced as `${polylineId}#${vertexId}`, which
 * resolved to no variables, so those constraints were filed under no subsystem
 * and silently STOPPED BEING APPLIED. Geometry solved wrong with no error.
 *
 * These tests exist so that class of bug fails loudly. A dropped constraint is
 * one that is no longer satisfied, so rather than introspecting the partition
 * (testing the implementation) each case asserts through the public API that
 * EVERY constraint's residual really is driven to zero.
 */

/** Largest |residual| over every constraint in the document, after solving. */
function worstResidual(doc: CADDocument): number {
  const byId = new Map(doc.entities.map((e) => [e.id, e]));
  const geo = (id: string) => byId.get(id);
  let worst = 0;
  for (const c of doc.constraints) {
    if (c.type === "fixed") continue; // locks DOFs, emits no equation
    for (const r of constraintResiduals(c, geo)) worst = Math.max(worst, Math.abs(r));
  }
  return worst;
}

describe("every constraint survives partitioning", () => {
  test("a polyline SEGMENT constraint is still applied", () => {
    // The exact bug: segment refs are composite ids, not entity ids.
    const doc = new CADDocument({ width: 300, height: 200 });
    const poly = doc.add(
      new PolylineEntity(
        [
          { x: 0, y: 0 },
          { x: 100, y: 37 },
          { x: 150, y: 80 },
        ],
        false,
      ),
    ) as PolylineEntity;
    doc.addConstraint(
      makeConstraint("horizontal", { entities: [segmentRef(poly.id, poly.vertexIds[0])] }),
    );
    expect(solve(doc).converged).toBe(true);
    expect(worstResidual(doc)).toBeLessThan(1e-4);
  });

  test("entity-referencing constraints are all still applied", () => {
    // One document, many constraint SHAPES: entities-only, points-only, and
    // mixed. Any of them resolving to the wrong subsystem shows up as a residual
    // that never reaches zero.
    const doc = new CADDocument({ width: 400, height: 300 });
    const a = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 80, y: 13 })) as LineEntity;
    const b = doc.add(new LineEntity({ x: 100, y: 0 }, { x: 180, y: 21 })) as LineEntity;
    // Started near its solution on purpose. This test is about the PARTITION,
    // not the optimiser's basin of attraction — from a far start this same
    // document stalls at ~0.02 on the pre-partition solver too (verified
    // against HEAD~1, bit-identical), which would make the test about
    // convergence rather than about constraints being applied.
    const c = doc.add(new LineEntity({ x: 120, y: 4 }, { x: 122, y: 70 })) as LineEntity;
    const circ = doc.add(new CircleEntity({ x: 250, y: 120 }, 20)) as CircleEntity;
    const circ2 = doc.add(new CircleEntity({ x: 300, y: 200 }, 12)) as CircleEntity;

    doc.addConstraint(makeConstraint("horizontal", { entities: [a.id] }));
    doc.addConstraint(makeConstraint("parallel", { entities: [a.id, b.id] }));
    doc.addConstraint(makeConstraint("perpendicular", { entities: [a.id, c.id] }));
    doc.addConstraint(makeConstraint("equal", { entities: [circ.id, circ2.id] }));
    doc.addConstraint(
      makeConstraint("coincident", {
        points: [
          { entityId: a.id, key: "b" },
          { entityId: b.id, key: "a" },
        ],
      }),
    );
    doc.addConstraint(
      makeConstraint("pointOnLine", { points: [{ entityId: c.id, key: "b" }], entities: [b.id] }),
    );

    expect(solve(doc).converged).toBe(true);
    expect(worstResidual(doc)).toBeLessThan(1e-4);
  });

  test("independent groups all converge — none is left out", () => {
    // The case partitioning exists for. If one group were dropped its residual
    // would stay large, so a per-group assertion catches a lost subsystem.
    const doc = new CADDocument({ width: 600, height: 600 });
    for (let i = 0; i < 25; i++) {
      const l = doc.add(
        new LineEntity({ x: i * 20, y: 10 }, { x: i * 20 + 15, y: 30 + (i % 5) }),
      ) as LineEntity;
      doc.addConstraint(makeConstraint("horizontal", { entities: [l.id] }));
    }
    expect(solve(doc).converged).toBe(true);
    expect(worstResidual(doc)).toBeLessThan(1e-4);
  });

  test("a driving dimension is applied alongside constraints", () => {
    const doc = new CADDocument({ width: 300, height: 200 });
    const l = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 50, y: 0 })) as LineEntity;
    doc.addConstraint(makeConstraint("horizontal", { entities: [l.id] }));
    doc.addDimension(
      makeDimension("distance", {
        points: [
          { entityId: l.id, key: "a" },
          { entityId: l.id, key: "b" },
        ],
        value: 120,
        offset: 10,
      }),
    );
    expect(solve(doc).converged).toBe(true);
    const len = Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y);
    expect(len).toBeCloseTo(120, 3);
  });

  test("a constraint spanning two groups merges them rather than splitting", () => {
    // Two otherwise-separate clusters joined by one constraint must be solved
    // TOGETHER. If the partition split them, the joining constraint could not be
    // satisfied and its residual would remain.
    const doc = new CADDocument({ width: 400, height: 300 });
    const l1 = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 60, y: 5 })) as LineEntity;
    const l2 = doc.add(new LineEntity({ x: 200, y: 100 }, { x: 260, y: 140 })) as LineEntity;
    doc.addConstraint(makeConstraint("horizontal", { entities: [l1.id] }));
    doc.addConstraint(makeConstraint("vertical", { entities: [l2.id] }));
    doc.addConstraint(makeConstraint("equal", { entities: [l1.id, l2.id] })); // the bridge
    expect(solve(doc).converged).toBe(true);
    expect(worstResidual(doc)).toBeLessThan(1e-4);
    const len1 = Math.hypot(l1.b.x - l1.a.x, l1.b.y - l1.a.y);
    const len2 = Math.hypot(l2.b.x - l2.a.x, l2.b.y - l2.a.y);
    expect(len1).toBeCloseTo(len2, 3);
  });

  test("arcs and rectangles (scalar DOFs) partition correctly too", () => {
    // Arcs carry scalar DOFs (radius, start/end angle) as well as points; a
    // partition that only tracked point variables would strand them.
    const doc = new CADDocument({ width: 400, height: 300 });
    const arc = doc.add(new ArcEntity({ x: 100, y: 100 }, 30, 0, Math.PI / 2)) as ArcEntity;
    const circ = doc.add(new CircleEntity({ x: 200, y: 100 }, 17)) as CircleEntity;
    const rect = doc.add(new RectEntity({ x: 0, y: 200 }, { x: 60, y: 250 })) as RectEntity;
    doc.addConstraint(makeConstraint("equal", { entities: [arc.id, circ.id] }));
    doc.addConstraint(makeConstraint("fixedPoint", { points: [{ entityId: rect.id, key: "p0" }], params: [0, 200] }));
    expect(solve(doc).converged).toBe(true);
    expect(worstResidual(doc)).toBeLessThan(1e-4);
    expect(arc.radius).toBeCloseTo(circ.radius, 3);
  });
});
