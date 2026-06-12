import { describe, it, expect } from "vitest";
import {
  chainLinesIntoPolygons,
  chainToPolygon,
  groupLinesIntoClosedChains,
  pointInPolygon,
} from "../src/cam/loops";
import { LineEntity } from "../src/model/entities";
import type { Vec2 } from "../src/core/vec2";

// --- helpers -----------------------------------------------------------------

/** Build LineEntity segments tracing the given closed polygon. */
function polyLines(pts: Vec2[]): LineEntity[] {
  return pts.map((p, i) => new LineEntity(p, pts[(i + 1) % pts.length]));
}

const square = (x: number, y: number, s: number): Vec2[] => [
  { x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s },
];

// --- chaining ------------------------------------------------------------------

describe("chainLinesIntoPolygons", () => {
  it("chains one square into one polygon", () => {
    const { polygons, leftover } = chainLinesIntoPolygons(polyLines(square(0, 0, 10)));
    expect(polygons.length).toBe(1);
    expect(leftover.length).toBe(0);
    expect(polygons[0].verts.length).toBe(4);
  });

  it("chains two disjoint squares into two polygons", () => {
    const segs = [...polyLines(square(0, 0, 10)), ...polyLines(square(20, 0, 5))];
    const { polygons, leftover } = chainLinesIntoPolygons(segs);
    expect(polygons.length).toBe(2);
    expect(leftover.length).toBe(0);
  });

  it("separates open segments as leftover", () => {
    const segs = [
      ...polyLines(square(0, 0, 10)),
      new LineEntity({ x: 50, y: 50 }, { x: 60, y: 50 }),
    ];
    const { polygons, leftover } = chainLinesIntoPolygons(segs);
    expect(polygons.length).toBe(1);
    expect(leftover.length).toBe(1);
  });

  it("orders chained vertices so consecutive points share segment endpoints", () => {
    // Shuffle segment order and flip some directions.
    const pts = square(0, 0, 10);
    const segs = [
      new LineEntity(pts[2], pts[1]),
      new LineEntity(pts[0], pts[1]),
      new LineEntity(pts[3], pts[0]),
      new LineEntity(pts[2], pts[3]),
    ];
    const { chains } = groupLinesIntoClosedChains(segs);
    expect(chains.length).toBe(1);
    const poly = chainToPolygon(chains[0]);
    expect(poly.length).toBe(4);
    // Each consecutive pair must be an edge of the square (length 10).
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(10);
    }
  });
});

// --- point-in-polygon ----------------------------------------------------------

describe("pointInPolygon", () => {
  const sq = square(0, 0, 10);
  it("detects inside / outside", () => {
    expect(pointInPolygon({ x: 5, y: 5 }, sq)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, sq)).toBe(false);
    expect(pointInPolygon({ x: -1, y: -1 }, sq)).toBe(false);
  });
});

