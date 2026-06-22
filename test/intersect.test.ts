/**
 * Intersection snapping geometry: crossings between entities that lie near a
 * query point, used to offer an "intersection" object snap.
 */

import { describe, it, expect } from "vitest";
import { intersectionsNear } from "../src/core/intersect";
import { LineEntity, CircleEntity, RectEntity, ArcEntity } from "../src/model/entities";

describe("intersectionsNear", () => {
  it("finds the crossing of two lines", () => {
    const a = new LineEntity({ x: -10, y: 0 }, { x: 10, y: 0 });
    const b = new LineEntity({ x: 0, y: -10 }, { x: 0, y: 10 });
    const hits = intersectionsNear([a, b], { x: 0, y: 0 }, 2);
    expect(hits.length).toBe(1);
    expect(hits[0].x).toBeCloseTo(0);
    expect(hits[0].y).toBeCloseTo(0);
  });

  it("ignores crossings far from the query point", () => {
    const a = new LineEntity({ x: -10, y: 0 }, { x: 10, y: 0 });
    const b = new LineEntity({ x: 0, y: -10 }, { x: 0, y: 10 });
    // Query near (8,0) — the crossing at the origin is outside the tolerance.
    expect(intersectionsNear([a, b], { x: 8, y: 0 }, 2).length).toBe(0);
  });

  it("does not report non-touching lines", () => {
    const a = new LineEntity({ x: -10, y: 0 }, { x: -5, y: 0 });
    const b = new LineEntity({ x: 0, y: -10 }, { x: 0, y: 10 });
    expect(intersectionsNear([a, b], { x: 0, y: 0 }, 2).length).toBe(0);
  });

  it("finds a line/circle crossing", () => {
    const line = new LineEntity({ x: -20, y: 0 }, { x: 20, y: 0 });
    const circle = new CircleEntity({ x: 0, y: 0 }, 10);
    const hits = intersectionsNear([line, circle], { x: 10, y: 0 }, 2);
    expect(hits.length).toBe(1);
    expect(hits[0].x).toBeCloseTo(10);
    expect(hits[0].y).toBeCloseTo(0);
  });

  it("finds a line crossing a rectangle edge", () => {
    const rect = new RectEntity({ x: 0, y: 0 }, { x: 100, y: 50 });
    const line = new LineEntity({ x: 30, y: -10 }, { x: 30, y: 60 });
    const hits = intersectionsNear([rect, line], { x: 30, y: 0 }, 2);
    // Crosses the bottom edge at (30,0) (the top edge at (30,50) is out of range).
    expect(hits.some((p) => Math.abs(p.x - 30) < 1e-6 && Math.abs(p.y - 0) < 1e-6)).toBe(true);
  });

  it("respects an arc's angular range", () => {
    // Quarter arc in the +x/+y quadrant (0 → π/2). A vertical line at x=0 would
    // meet the full circle at (0,10) and (0,-10); only (0,10) is on the arc, and
    // it sits at the arc endpoint.
    const arc = new ArcEntity({ x: 0, y: 0 }, 10, 0, Math.PI / 2);
    const line = new LineEntity({ x: 0, y: -20 }, { x: 0, y: 20 });
    const hits = intersectionsNear([arc, line], { x: 0, y: -10 }, 2);
    expect(hits.length).toBe(0); // (0,-10) is not on the 0→π/2 arc
  });
});
