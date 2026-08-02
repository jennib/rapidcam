import { describe, it, expect } from "vitest";
import { CADDocument, stockRefEntity } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { makeDimension, dimensionLayout } from "../src/model/dimensions";

describe("Stock Edge Dimension Layout & Visibility Test", () => {
  it("computes dimension layout for a line-distance dimension anchored to a stock edge ref", () => {
    const doc = new CADDocument({ width: 300, height: 250 });
    doc.stockRect = { x: 50, y: 50, width: 200, height: 150 };

    const line = new LineEntity({ x: 50, y: 138.9 }, { x: 80, y: 138.9 }, "ent3");
    doc.add(line);

    const dim = makeDimension("line-distance", {
      entities: ["ent3", "__stock__#mid_b"],
      value: 88.9,
      offset: 0,
      driving: true,
      anchors: [0.5, 0.5],
      expr: "cup_offset_bottom",
    });
    doc.dimensions.push(dim);

    const byId = new Map(doc.entities.map((e) => [e.id, e]));
    const geo = (id: string) =>
      id === "__stock__" || id.startsWith("__stock__")
        ? (stockRefEntity(doc) as any)
        : byId.get(id);

    const layout = dimensionLayout(dim, geo, "mm", 1);
    expect(layout).not.toBeNull();
    expect(layout?.label).toContain("cup_offset_bottom");
    expect(layout?.segments.length).toBeGreaterThan(0);
  });
});
