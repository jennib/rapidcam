import { describe, it, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity, CircleEntity } from "../src/model/entities";
import { makeConstraint } from "../src/model/constraints";
import { solve } from "../src/solver/solver";
import { buildConstraintsFor } from "../src/ui/constraintBar";

describe("midpoint constraint — two-point variant", () => {
  it("drives a circle centre to the midpoint of two fixed points", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    // Two fixed lines standing in for rectangle edges; we use one endpoint of
    // each as the "opposite corners": (0,0) and (100,50).
    const l1 = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 0 })) as LineEntity;
    const l2 = doc.add(new LineEntity({ x: 0, y: 50 }, { x: 100, y: 50 })) as LineEntity;
    doc.addConstraint(makeConstraint("fixed", { entities: [l1.id] }));
    doc.addConstraint(makeConstraint("fixed", { entities: [l2.id] }));

    const circ = doc.add(new CircleEntity({ x: 10, y: 10 }, 5)) as CircleEntity;
    doc.addConstraint(makeConstraint("midpoint", {
      points: [
        { entityId: circ.id, key: "c" },
        { entityId: l1.id, key: "a" },  // (0, 0)
        { entityId: l2.id, key: "b" },  // (100, 50)
      ],
    }));

    solve(doc);
    expect(circ.center.x).toBeCloseTo(50, 3);
    expect(circ.center.y).toBeCloseTo(25, 3);
  });

  it("line variant still works (regression)", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const l1 = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 40 })) as LineEntity;
    doc.addConstraint(makeConstraint("fixed", { entities: [l1.id] }));

    const circ = doc.add(new CircleEntity({ x: 90, y: 90 }, 5)) as CircleEntity;
    doc.addConstraint(makeConstraint("midpoint", {
      points: [{ entityId: circ.id, key: "c" }],
      entities: [l1.id],
    }));

    solve(doc);
    expect(circ.center.x).toBeCloseTo(50, 3);
    expect(circ.center.y).toBeCloseTo(20, 3);
  });

  it("constraint bar accepts 3 selected points (first = midpoint)", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const l1 = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 0 })) as LineEntity;
    const l2 = doc.add(new LineEntity({ x: 0, y: 50 }, { x: 100, y: 50 })) as LineEntity;
    const circ = doc.add(new CircleEntity({ x: 10, y: 10 }, 5)) as CircleEntity;

    doc.selectedPoints = [
      { entityId: circ.id, key: "c" },
      { entityId: l1.id, key: "a" },
      { entityId: l2.id, key: "b" },
    ];
    const res = buildConstraintsFor("midpoint", doc);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.constraints[0].type).toBe("midpoint");
      expect(res.constraints[0].points.length).toBe(3);
      expect(res.constraints[0].points[0].entityId).toBe(circ.id);
      expect(res.constraints[0].entities.length).toBe(0);
    }
  });

  it("constraint bar still rejects 2 points without a line", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const l1 = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 0 })) as LineEntity;
    doc.selectedPoints = [
      { entityId: l1.id, key: "a" },
      { entityId: l1.id, key: "b" },
    ];
    const res = buildConstraintsFor("midpoint", doc);
    expect(res.ok).toBe(false);
  });
});
