import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { CircleEntity } from "../src/model/entities";
import { rasterizeStock } from "../src/cam/stockRasterizer";
import type { CAMOperation } from "../src/cam/types";

// The 3-D preview modelled a drill's point as an unbounded cone sized purely
// from the tip angle (drilled-depth × tan(halfAngle)), with no clamp at the
// bit's own diameter. A real twist drill's flutes run a straight cylindrical
// shank past the point — a 12mm-deep hole on the standard 118° point
// (halfTan ≈ tan59° ≈ 1.66) flared to ~20mm lateral reach, rendering an ⌀8mm
// hole as a ~40mm-wide crater in the preview. These assert every cut cell sits
// within the bit's own radius of the hole centre.

function drillOp(circleId: string, diameter: number, depth: number): CAMOperation {
  return {
    id: "op",
    name: "drill",
    type: "drill",
    side: "outside",
    entityIds: [circleId],
    toolType: "drill",
    toolNumber: 1,
    diameter,
    feedrate: 300,
    plungeRate: 300,
    spindleSpeed: 3000,
    safeZ: 5,
    depth,
    stepdown: 4,
    stepover: 0.4,
  };
}

test("3D preview: a deep drill hole's cone does not flare past the bit's own radius", () => {
  const doc = new CADDocument({ width: 60, height: 60 });
  doc.stockThickness = 20;
  const R = 4; // ⌀8mm bit
  const circle = doc.add(new CircleEntity({ x: 30, y: 30 }, R));
  const hm = rasterizeStock([drillOp(circle.id, R * 2, -12)], doc);
  const { data, gridW, gridH, stockT } = hm;

  const cellsPerMM = gridW / doc.canvas.width;
  const cx = 30 * cellsPerMM;
  const cy = 30 * cellsPerMM;
  const maxCutRadiusCells = (R + 0.5) * cellsPerMM; // small slack for cell-centre rounding

  // Positive control: the hole IS carved at all (a vacuous "nothing exceeds R"
  // pass on an unstamped grid would prove nothing).
  const centerIdx = Math.round(cy) * gridW + Math.round(cx);
  expect(data[centerIdx]).toBeLessThan(stockT - 1e-6);

  let worstRadiusCells = 0;
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      if (data[y * gridW + x] < stockT - 1e-6) {
        worstRadiusCells = Math.max(worstRadiusCells, Math.hypot(x - cx, y - cy));
      }
    }
  }
  expect(worstRadiusCells).toBeLessThanOrEqual(maxCutRadiusCells);
});

test("3D preview: a shallow drill hole is unaffected by the clamp (cone stays inside R anyway)", () => {
  // When the geometric cone would already stay inside the bit radius (a
  // shallow hole, or a steep/narrow point angle), the clamp must not change
  // anything — the hole should still taper to a point at the bottom.
  const doc = new CADDocument({ width: 60, height: 60 });
  doc.stockThickness = 20;
  const R = 4;
  const circle = doc.add(new CircleEntity({ x: 30, y: 30 }, R));
  const hm = rasterizeStock([drillOp(circle.id, R * 2, -1)], doc); // 1mm deep — cone reach ≈ 1.66mm < R
  const { data, gridW, stockT } = hm;
  const cellsPerMM = gridW / doc.canvas.width;
  const centerIdx = Math.round(30 * cellsPerMM) * gridW + Math.round(30 * cellsPerMM);
  expect(data[centerIdx]).toBeLessThan(stockT - 1e-6);
});
