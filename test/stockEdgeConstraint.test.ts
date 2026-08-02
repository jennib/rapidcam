import { describe, it, expect } from "vitest";
import { CADDocument, STOCK_ENTITY_ID } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { seedConstraintPoints } from "../src/model/constraints";
import { solve } from "../src/solver/solver";
import { buildConstraintsFor } from "../src/ui/constraintBar";

describe("Point on Line to Stock Edge test", () => {
  it("constrains a line endpoint to the left stock edge via buildConstraintsFor", () => {
    const doc = new CADDocument({ width: 400, height: 400 });
    doc.stockRect = { x: 50, y: 50, width: 300, height: 300 };

    // Line starting at (70, 150) to (120, 150)
    const line = doc.add(new LineEntity({ x: 70, y: 150 }, { x: 120, y: 150 })) as LineEntity;

    // User Ctrl+clicks line endpoint 'a' and stock left midpoint 'mid_l'
    doc.selectedPoints = [
      { entityId: line.id, key: "a" },
      { entityId: STOCK_ENTITY_ID, key: "mid_l" },
    ];

    const build = buildConstraintsFor("pointOnLine", doc);
    console.log("Build result for stock edge pointOnLine:", build);

    expect(build.ok).toBe(true);
    if (!build.ok) return;

    seedConstraintPoints(doc, build.constraints);
    for (const c of build.constraints) doc.addConstraint(c);

    const res = solve(doc);
    console.log("Solve result:", res);
    console.log("Line position:", line.a, line.b);

    expect(res.converged).toBe(true);
    expect(line.a.x).toBeCloseTo(50);
  });
});
