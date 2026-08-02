import { describe, it, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
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
});
