import { describe, it, expect } from "vitest";
import { CADDocument, ORIGIN_ENTITY_ID } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { commitOffset } from "../src/tools/offsetTool";

describe("Offset coincident and stock boundary constraint inheritance test", () => {
  it("constrains both ends of offset line when parent endpoints were coincident/pointOnLine to stock and another line", () => {
    const doc = new CADDocument({ width: 300, height: 250 });
    doc.stockRect = { x: 50, y: 50, width: 200, height: 150 };

    const rightLine = new LineEntity({ x: 80, y: 50 }, { x: 80, y: 170 }, "ent3");
    doc.add(rightLine);

    const parent = new LineEntity({ x: 50, y: 138.9 }, { x: 80, y: 138.9 }, "ent5");
    doc.add(parent);

    // Endpoint a: coincident or pointOnLine on stock left edge
    doc.addConstraint({
      id: "con_a",
      type: "pointOnLine",
      points: [{ entityId: "ent5", key: "a" }],
      entities: ["__stock__#mid_l"],
    });

    // Endpoint b: coincident to rightLine.a (or ent3)
    doc.addConstraint({
      id: "con_b",
      type: "coincident",
      points: [
        { entityId: "ent5", key: "b" },
        { entityId: "ent3", key: "a" },
      ],
      entities: [],
    });

    const mockCtx: any = {
      doc,
      pushHistory: () => {},
    };

    commitOffset(parent, 28.38, mockCtx);

    const child = doc.entities.find(
      (e) => e.id !== "ent3" && e.id !== "ent5" && e.id !== ORIGIN_ENTITY_ID,
    ) as LineEntity;
    expect(child).toBeDefined();

    // Verify endpoint a got pointOnLine to __stock__#mid_l
    const polA = doc.constraints.find(
      (c) =>
        c.type === "pointOnLine" &&
        c.points.some((p) => p.entityId === child.id && p.key === "a") &&
        c.entities.includes("__stock__#mid_l"),
    );
    expect(polA).toBeDefined();

    // Verify endpoint b got pointOnLine to ent3 (right vertical line)
    const polB = doc.constraints.find(
      (c) =>
        c.type === "pointOnLine" &&
        c.points.some((p) => p.entityId === child.id && p.key === "b") &&
        c.entities.includes("ent3"),
    );
    expect(polB).toBeDefined();
  });
});
