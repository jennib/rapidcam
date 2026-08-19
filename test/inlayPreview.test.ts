import { describe, expect, it } from "vitest";
import { rasterizeStock } from "../src/cam/stockRasterizer";
import type { CAMOperation } from "../src/cam/types";
import { CADDocument } from "../src/model/document";
import { RectEntity } from "../src/model/entities";

const inlayOp = (entityIds: string[]): CAMOperation => ({
  id: "i1",
  name: "inlay",
  type: "inlay",
  entityIds,
  side: "outside",
  toolType: "v-bit",
  toolNumber: 1,
  diameter: 12,
  vAngle: 90,
  feedrate: 1000,
  plungeRate: 300,
  spindleSpeed: 18000,
  safeZ: 5,
  depth: -5,
  stepdown: 1.5,
  stepover: 0.4,
  vStep: 0.5,
  pocketDepth: 5,
  glueGap: 0.5,
  sawAllowance: 1,
  inlayMargin: 10,
});

describe("v-carve inlay stock preview", () => {
  it("previews board A: a pocket floor that deepens to the pocket depth", () => {
    const doc = new CADDocument({ width: 100, height: 100 }); // stockT = 10
    const rect = doc.add(new RectEntity({ x: 10, y: 10 }, { x: 50, y: 50 }));
    const hm = rasterizeStock([inlayOp([rect.id])], doc);

    const RES = hm.gridW / hm.stockW;
    const heightAt = (x: number, y: number): number =>
      hm.data[Math.round(y * RES) * hm.gridW + Math.round(x * RES)];

    const centre = heightAt(30, 30);
    const nearWall = heightAt(12, 30);
    const uncut = heightAt(80, 80);

    expect(uncut).toBeCloseTo(hm.stockT, 5);
    expect(nearWall).toBeLessThan(hm.stockT);
    expect(centre).toBeLessThan(nearWall - 1);
    // Clamped at the pocket floor (5), not the male's saw allowance depth (6).
    expect(centre).toBeGreaterThanOrEqual(hm.stockT - 5 - 1e-6);
  });
});
