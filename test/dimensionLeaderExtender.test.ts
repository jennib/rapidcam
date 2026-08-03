import { describe, it, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { dimensionLayout, makeDimension } from "../src/model/dimensions";

describe("Dimension leader line extension test", () => {
  it("extends dimension line leader to text label when label expression is longer than the measured span", () => {
    const doc = new CADDocument({ width: 300, height: 250 });
    doc.stockRect = { x: 50, y: 50, width: 200, height: 150 };

    const l1 = new LineEntity({ x: 50, y: 138.9 }, { x: 80, y: 138.9 }, "ent1");
    const l2 = new LineEntity({ x: 50, y: 161.4 }, { x: 80, y: 161.4 }, "ent2");
    doc.add(l1);
    doc.add(l2);

    const dim = makeDimension("line-distance", {
      entities: ["ent1", "ent2"],
      value: 22.5,
      offset: 0,
      expr: "screw_distanc_apart / 2",
      driving: true,
    });
    doc.dimensions.push(dim);

    const geo = (id: string) => doc.entities.find((e) => e.id === id);

    // Pass pxPerMm = 1.6 (zoom ~55%)
    const layout = dimensionLayout(dim, geo, "mm", 1.6);

    expect(layout).not.toBeNull();
    if (!layout) return;

    // Verify textPos is moved outside
    expect(layout.textPos.y).toBeGreaterThan(161.4);

    // Verify layout.segments includes leader line extending past 161.4 to layout.textPos
    const leader = layout.segments.find(
      ([a, b]) => Math.abs(a.x - 65) < 20 && (a.y >= 160 || b.y >= 160),
    );
    expect(leader).toBeDefined();
  });
});
