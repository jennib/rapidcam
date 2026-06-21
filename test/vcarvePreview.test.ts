import { describe, it, expect } from "vitest";
import { rasterizeStock } from "../src/cam/stockRasterizer";
import { CADDocument } from "../src/model/document";
import { RectEntity } from "../src/model/entities";
import type { CAMOperation } from "../src/cam/types";

const vcarveOp = (entityIds: string[]): CAMOperation => ({
  id: "v1", name: "carve", type: "vcarve", entityIds, side: "outside",
  toolType: "v-bit", toolNumber: 1, diameter: 12, vAngle: 90,
  feedrate: 1000, plungeRate: 300, spindleSpeed: 18000,
  safeZ: 5, depth: -5, stepdown: 1.5, stepover: 0.4, vStep: 0.5,
});

describe("v-carve stock preview", () => {
  it("carves a floor that deepens from wall to centre", () => {
    const doc = new CADDocument({ width: 100, height: 100 }); // stockT = 10
    // 40 mm square centred at (30,30).
    const rect = doc.add(new RectEntity({ x: 10, y: 10 }, { x: 50, y: 50 }));
    const hm = rasterizeStock([vcarveOp([rect.id])], doc);

    const RES = hm.gridW / hm.stockW; // cells per mm
    const heightAt = (x: number, y: number): number =>
      hm.data[Math.round(y * RES) * hm.gridW + Math.round(x * RES)];

    const centre = heightAt(30, 30);  // near the spine — deepest
    const nearWall = heightAt(12, 30); // 2 mm in from the x=10 wall — shallow
    const uncut = heightAt(80, 80);    // outside the shape

    expect(uncut).toBeCloseTo(hm.stockT, 5);        // untouched stock
    expect(nearWall).toBeLessThan(hm.stockT);       // some material removed
    expect(centre).toBeLessThan(nearWall - 1);      // and the centre is clearly deeper
    expect(centre).toBeGreaterThanOrEqual(hm.stockT - 5 - 1e-6); // clamped at |depth|
  });
});
