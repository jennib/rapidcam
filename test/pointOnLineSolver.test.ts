import { describe, it, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity, RectEntity } from "../src/model/entities";
import { makeConstraint, seedConstraintPoints } from "../src/model/constraints";
import { makeDimension } from "../src/model/dimensions";
import { solve } from "../src/solver/solver";

describe("Point on Line solver behavior", () => {
  it("constrains an endpoint of an unconstrained line (Line B) to a dimensioned line (Line A) without distorting Line A", () => {
    const doc = new CADDocument({ width: 400, height: 400 });

    // Line A (Reference): Horizontal line from (50, 108.153) to (80, 108.153)
    const lineA = doc.add(new LineEntity({ x: 50, y: 108.153 }, { x: 80, y: 108.153 })) as LineEntity;
    doc.addConstraint(makeConstraint("horizontal", { entities: [lineA.id] }));
    doc.addDimension(
      makeDimension("distance", {
        points: [
          { entityId: lineA.id, key: "a" },
          { entityId: lineA.id, key: "b" },
        ],
        value: 30,
        offset: 10,
      }),
    );

    // Line B (Mover): Vertical line starting at (22.5, 50) to (22.5, 150)
    const lineB = doc.add(new LineEntity({ x: 22.5, y: 50 }, { x: 22.5, y: 150 })) as LineEntity;

    const con = makeConstraint("pointOnLine", {
      points: [{ entityId: lineB.id, key: "a" }],
      entities: [lineA.id],
    });

    seedConstraintPoints(doc, [con]);
    doc.addConstraint(con);

    const res = solve(doc);
    expect(res.converged).toBe(true);

    // Line A should NOT move at all!
    expect(lineA.a.x).toBeCloseTo(50);
    expect(lineA.a.y).toBeCloseTo(108.153);
    expect(lineA.b.x).toBeCloseTo(80);
    expect(lineA.b.y).toBeCloseTo(108.153);

    // Line B point 'a' should be on Line A (Y = 108.153)
    expect(lineB.a.y).toBeCloseTo(108.153);
  });

  it("holds a point on a RECTANGLE edge — a bare rect id constrains nothing", () => {
    // pointOnLine resolves ONE line. A rectangle has four, so naming it by a
    // bare entity id resolved to null: the constraint was accepted, drew its
    // badge, and silently held the point nowhere. The edge-snap now qualifies
    // the ref as "<rectId>#mid_l" (see edgeEndsOf / autoJoin).
    const doc = new CADDocument({ width: 300, height: 300 });
    const rect = doc.add(new RectEntity({ x: 100, y: 100 }, { x: 200, y: 200 })) as RectEntity;
    const line = doc.add(new LineEntity({ x: 20, y: 20 }, { x: 60, y: 60 })) as LineEntity;

    const con = makeConstraint("pointOnLine", {
      points: [{ entityId: line.id, key: "b" }],
      entities: [`${rect.id}#mid_l`], // left edge: x = 100, y 100..200
    });
    doc.addConstraint(con);
    seedConstraintPoints(doc, [con]);
    expect(solve(doc).converged).toBe(true);
    expect(line.b.x).toBeCloseTo(100, 6);

    // ...and it must STAY on the edge when the far end is dragged away.
    solve(doc, new Map([[`${line.id}:a`, { x: 10, y: 250 }]]));
    expect(line.b.x).toBeCloseTo(100, 3);
  });

  it("an UNQUALIFIED rect id resolves to no line, so it must not silently pretend to constrain", () => {
    // Positive control for the above: proves the bare form really is inert,
    // so the qualified form above is doing the work (not the solver drifting
    // there by coincidence).
    const doc = new CADDocument({ width: 300, height: 300 });
    const rect = doc.add(new RectEntity({ x: 100, y: 100 }, { x: 200, y: 200 })) as RectEntity;
    const line = doc.add(new LineEntity({ x: 20, y: 20 }, { x: 60, y: 60 })) as LineEntity;
    const con = makeConstraint("pointOnLine", {
      points: [{ entityId: line.id, key: "b" }],
      entities: [rect.id],
    });
    doc.addConstraint(con);
    seedConstraintPoints(doc, [con]);
    solve(doc);
    expect(line.b.x).toBeCloseTo(60, 6); // unmoved
  });
});
