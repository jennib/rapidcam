import { describe, it, expect } from "vitest";
import { CADDocument, ORIGIN_ENTITY_ID } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { commitOffset } from "../src/tools/offsetTool";

describe("Offset constraint inheritance test", () => {
  it("inherits horizontal and pointOnLine stock edge constraints when offsetting a line", () => {
    const doc = new CADDocument({ width: 300, height: 250 });
    doc.stockRect = { x: 50, y: 50, width: 200, height: 150 };

    const parent = new LineEntity({ x: 50, y: 138.9 }, { x: 80, y: 138.9 }, "ent3");
    doc.add(parent);

    doc.addConstraint({
      id: "con_h",
      type: "horizontal",
      points: [],
      entities: ["ent3"],
    });

    doc.addConstraint({
      id: "con_pol",
      type: "pointOnLine",
      points: [{ entityId: "ent3", key: "a" }],
      entities: ["__stock__#left"],
    });

    const mockCtx: any = {
      doc,
      pushHistory: () => {},
    };

    commitOffset(parent, 28.38, mockCtx);

    const child = doc.entities.find(
      (e) => e.id !== "ent3" && e.id !== ORIGIN_ENTITY_ID,
    ) as LineEntity;
    expect(child).toBeDefined();

    // Verify child inherited horizontal constraint
    const hCon = doc.constraints.find(
      (c) => c.type === "horizontal" && c.entities.includes(child.id),
    );
    expect(hCon).toBeDefined();

    // Verify child inherited pointOnLine constraint on stock left edge
    const polCon = doc.constraints.find(
      (c) =>
        c.type === "pointOnLine" &&
        c.points.some((p) => p.entityId === child.id && p.key === "a") &&
        c.entities.includes("__stock__#left"),
    );
    expect(polCon).toBeDefined();
  });
});
