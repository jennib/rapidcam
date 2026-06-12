import { describe, it, expect } from "vitest";
import {
  chainLinesIntoPolygons,
  chainToPolygon,
  groupLinesIntoClosedChains,
  pointInPolygon,
  classifyRegionAt,
  type RegionLoop,
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

// --- region classification -------------------------------------------------------

describe("classifyRegionAt", () => {
  const loop = (verts: Vec2[], id: string): RegionLoop => ({ verts, ids: [id] });

  // outer square 0..100, two islands inside, one shape nested inside an island,
  // and an unrelated square elsewhere.
  const outer    = loop(square(0, 0, 100), "outer");
  const islandA  = loop(square(10, 10, 20), "islandA");
  const islandB  = loop(square(50, 50, 30), "islandB");
  const nested   = loop(square(55, 55, 10), "nested");   // inside islandB
  const elsewhere = loop(square(200, 0, 10), "elsewhere");
  const loops = [outer, islandA, islandB, nested, elsewhere];

  it("returns null when clicking empty space", () => {
    expect(classifyRegionAt({ x: 150, y: 150 }, loops)).toBeNull();
  });

  it("picks the enclosing loop as boundary and direct children as islands", () => {
    const r = classifyRegionAt({ x: 5, y: 95 }, loops)!; // inside outer, outside islands
    expect(r.boundary.ids).toEqual(["outer"]);
    const islandIds = r.islands.map((l) => l.ids[0]).sort();
    expect(islandIds).toEqual(["islandA", "islandB"]);
  });

  it("does not treat deeply nested loops as islands of the outer boundary", () => {
    const r = classifyRegionAt({ x: 5, y: 95 }, loops)!;
    expect(r.islands.some((l) => l.ids[0] === "nested")).toBe(false);
  });

  it("treats a click inside an island as picking that island's interior region", () => {
    const r = classifyRegionAt({ x: 52, y: 52 }, loops)!; // inside islandB, outside nested
    expect(r.boundary.ids).toEqual(["islandB"]);
    expect(r.islands.map((l) => l.ids[0])).toEqual(["nested"]);
  });

  it("prefers the innermost containing loop", () => {
    const r = classifyRegionAt({ x: 57, y: 57 }, loops)!; // inside nested
    expect(r.boundary.ids).toEqual(["nested"]);
    expect(r.islands.length).toBe(0);
  });
});
