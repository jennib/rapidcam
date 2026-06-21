import { describe, it, expect } from "vitest";
import { generateGCode } from "../src/cam/gcode";
import { CADDocument } from "../src/model/document";
import { PolylineEntity, RectEntity } from "../src/model/entities";
import type { CAMOperation } from "../src/cam/types";

const profileOp = (entityIds: string[], over: Partial<CAMOperation> = {}): CAMOperation => ({
  id: "p1", name: "prof", type: "profile", side: "outside", entityIds,
  toolType: "end-mill", toolNumber: 1, diameter: 6,
  feedrate: 1000, plungeRate: 300, spindleSpeed: 18000,
  safeZ: 5, depth: -2, stepdown: 2, stepover: 0.4, ...over,
});

// Walk the program, tracking the current XY, and reconstruct every G2/G3 arc:
// centre = current + (I,J); endpoint = (X,Y). Returns centres + endpoint radii.
function arcsOf(gcode: string): { centres: { x: number; y: number }[]; endRadii: number[]; arcCount: number } {
  const centres: { x: number; y: number }[] = [];
  const endRadii: number[] = [];
  let cx = 0, cy = 0, arcCount = 0;
  for (const line of gcode.split("\n")) {
    const mx = line.match(/X(-?\d+(?:\.\d+)?)/);
    const my = line.match(/Y(-?\d+(?:\.\d+)?)/);
    const nx = mx ? parseFloat(mx[1]) : cx;
    const ny = my ? parseFloat(my[1]) : cy;
    if (/^G[23]\b/.test(line)) {
      const mi = line.match(/I(-?\d+(?:\.\d+)?)/);
      const mj = line.match(/J(-?\d+(?:\.\d+)?)/);
      if (mi && mj) {
        const ccx = cx + parseFloat(mi[1]), ccy = cy + parseFloat(mj[1]);
        centres.push({ x: ccx, y: ccy });
        endRadii.push(Math.hypot(nx - ccx, ny - ccy));
        arcCount++;
      }
    }
    if (mx) cx = nx;
    if (my) cy = ny;
  }
  return { centres, endRadii, arcCount };
}

describe("profile arc-fitting", () => {
  it("posts a circular polyline profile as reconstructable G2/G3 arcs", () => {
    const R = 20, N = 64;
    const pts = Array.from({ length: N }, (_, i) => {
      const a = (i / N) * 2 * Math.PI;
      return { x: 50 + R * Math.cos(a), y: 50 + R * Math.sin(a) };
    });
    const doc = new CADDocument({ width: 120, height: 120 });
    const poly = doc.add(new PolylineEntity(pts, true));
    const out = generateGCode([profileOp([poly.id], { side: "outside" })], doc);

    const { centres, endRadii, arcCount } = arcsOf(out);
    expect(arcCount).toBeGreaterThan(0);                      // it actually used arcs
    expect(arcCount).toBeLessThan(N / 2);                     // ...far fewer than the facets

    // Every arc shares one centre (the circle's), and every endpoint sits on the
    // tool-compensated radius R + toolR = 23 mm. Wrong I/J would fail this.
    const c0 = centres[0];
    for (const c of centres) {
      expect(c.x).toBeCloseTo(c0.x, 1);
      expect(c.y).toBeCloseTo(c0.y, 1);
    }
    for (const r of endRadii) expect(r).toBeCloseTo(23, 1);
  });

  it("leaves a rectangle profile as straight G1 (no behaviour change)", () => {
    const doc = new CADDocument({ width: 120, height: 120 });
    const rect = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 80, y: 60 }));
    const out = generateGCode([profileOp([rect.id])], doc);
    expect(arcsOf(out).arcCount).toBe(0); // no arcs — identical to pre-arc-fit output
  });
});
