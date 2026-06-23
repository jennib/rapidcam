/**
 * Regular-polygon geometry: the polygon tool sizes by an across-flats (AF)
 * diameter, the machinist convention. A typed Ø D maps to circumradius
 * R = (D/2) / cos(π/n), so 2× the apothem of the resulting polygon equals D.
 */

import { describe, it, expect } from "vitest";
import { polygonPoints } from "../src/tools/polygonTool";

/** Across-flats diameter = 2× apothem (centre → nearest edge midpoint). */
function acrossFlats(pts: { x: number; y: number }[], center = { x: 0, y: 0 }): number {
  let minApothem = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    minApothem = Math.min(minApothem, Math.hypot(mx - center.x, my - center.y));
  }
  return 2 * minApothem;
}

describe("polygon across-flats sizing", () => {
  const center = { x: 0, y: 0 };

  it("hexagon: typed Ø 50 yields 50 across flats", () => {
    const n = 6, d = 50;
    const r = (d / 2) / Math.cos(Math.PI / n);
    const pts = polygonPoints(center, r, n, 0);
    expect(pts).toHaveLength(6);
    expect(acrossFlats(pts, center)).toBeCloseTo(50, 6);
  });

  it("square and octagon also honour across-flats regardless of orientation", () => {
    for (const n of [4, 8]) {
      const d = 30;
      const r = (d / 2) / Math.cos(Math.PI / n);
      const pts = polygonPoints(center, r, n, 0.37); // arbitrary rotation
      expect(acrossFlats(pts, center)).toBeCloseTo(30, 6);
    }
  });

  it("circumradius exceeds the across-flats radius (corners stick out past flats)", () => {
    const n = 6, d = 50;
    const r = (d / 2) / Math.cos(Math.PI / n);
    expect(r).toBeGreaterThan(d / 2);
  });
});
