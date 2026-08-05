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

  it("inherits vertical and bottom stock edge constraint when offsetting a vertical line with stock fills sheet", () => {
    const doc = new CADDocument({ width: 300, height: 250 });
    // stockRect is null (default "stock fills the sheet")

    // Vertical line with bottom point 'a' on bottom stock edge (y = 0)
    const parent = new LineEntity({ x: 50, y: 0 }, { x: 50, y: 100 }, "ent_v");
    doc.add(parent);

    doc.addConstraint({
      id: "con_v",
      type: "vertical",
      points: [],
      entities: ["ent_v"],
    });

    doc.addConstraint({
      id: "con_bottom",
      type: "pointOnLine",
      points: [{ entityId: "ent_v", key: "a" }],
      entities: ["__stock__#bottom"],
    });

    const mockCtx: any = {
      doc,
      pushHistory: () => {},
    };

    commitOffset(parent, 25, mockCtx);

    const child = doc.entities.find(
      (e) => e.id !== "ent_v" && e.id !== ORIGIN_ENTITY_ID,
    ) as LineEntity;
    expect(child).toBeDefined();

    // Verify child inherited vertical constraint
    const vCon = doc.constraints.find(
      (c) => c.type === "vertical" && c.entities.includes(child.id),
    );
    expect(vCon).toBeDefined();

    // Verify child inherited bottom stock edge constraint on point 'a'
    const botCon = doc.constraints.find(
      (c) =>
        c.type === "pointOnLine" &&
        c.points.some((p) => p.entityId === child.id && p.key === "a") &&
        c.entities.some((ref) => ref.startsWith("__stock__#bottom")),
    );
    expect(botCon).toBeDefined();
  });

  it("inherits bottom stock edge constraint when parent is coincident to stock bottom midpoint", () => {
    const doc = new CADDocument({ width: 300, height: 250 });

    const parent = new LineEntity({ x: 150, y: 0 }, { x: 150, y: 120 }, "ent_v2");
    doc.add(parent);

    doc.addConstraint({
      id: "con_coin_stock",
      type: "coincident",
      points: [
        { entityId: "ent_v2", key: "a" },
        { entityId: "__stock__", key: "mid_b" },
      ],
      entities: [],
    });

    const mockCtx: any = {
      doc,
      pushHistory: () => {},
    };

    commitOffset(parent, 30, mockCtx);

    const child = doc.entities.find(
      (e) => e.id !== "ent_v2" && e.id !== ORIGIN_ENTITY_ID,
    ) as LineEntity;
    expect(child).toBeDefined();

    const botCon = doc.constraints.find(
      (c) =>
        c.type === "pointOnLine" &&
        c.points.some((p) => p.entityId === child.id && p.key === "a") &&
        c.entities.some((ref) => ref.startsWith("__stock__#bottom")),
    );
    expect(botCon).toBeDefined();
  });
});
