/**
 * Regular-polygon geometry: the polygon tool sizes by an across-flats (AF)
 * diameter, the machinist convention. A typed Ø D maps to circumradius
 * R = (D/2) / cos(π/n), so 2× the apothem of the resulting polygon equals D.
 */

import { describe, it, expect } from "vitest";
import { regularPolygonPoints as polygonPoints } from "../src/core/geom";
import { PolylineEntity } from "../src/model/entities";
import { CADDocument } from "../src/model/document";

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

describe("polygon construction metadata", () => {
  it("survives a snapshot/restore round-trip", () => {
    const doc = new CADDocument({ width: 200, height: 150 }, "mm");
    const pl = new PolylineEntity(polygonPoints({ x: 60, y: 40 }, 25, 6, 0.2), true);
    pl.polygon = { sides: 6, center: { x: 60, y: 40 }, radius: 25, rotation: 0.2 };
    doc.entities.push(pl);

    const before = doc.snapshot();
    const doc2 = new CADDocument({ width: 1, height: 1 }, "mm");
    doc2.restore(before);

    const restored = doc2.entities.find(e => e instanceof PolylineEntity) as PolylineEntity;
    expect(restored.polygon).toEqual({ sides: 6, center: { x: 60, y: 40 }, radius: 25, rotation: 0.2 });
  });

  it("translate() shifts the polygon centre so params stay consistent", () => {
    const pl = new PolylineEntity(polygonPoints({ x: 10, y: 10 }, 20, 5, 0), true);
    pl.polygon = { sides: 5, center: { x: 10, y: 10 }, radius: 20, rotation: 0 };
    pl.translate({ x: 7, y: -3 });
    expect(pl.polygon.center).toEqual({ x: 17, y: 7 });
    // The shifted params still reproduce the moved vertices.
    const expected = polygonPoints(pl.polygon.center, 20, 5, 0);
    pl.points.forEach((q, i) => {
      expect(Math.hypot(q.x - expected[i].x, q.y - expected[i].y)).toBeLessThan(1e-9);
    });
  });
});
