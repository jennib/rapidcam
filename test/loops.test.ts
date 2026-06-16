import { describe, it, expect } from "vitest";
import {
  chainLinesIntoPolygons,
  chainToPolygon,
  groupLinesIntoClosedChains,
  collectClosedLoops,
  pointInPolygon,
} from "../src/cam/loops";
import { LineEntity, ArcEntity, BezierEntity } from "../src/model/entities";
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

// --- collectClosedLoops: mixed-curve loops (regression for filleted rect) -----

describe("collectClosedLoops", () => {
  it("closes a loop made of lines + an arc (filleted-rectangle corner)", () => {
    // Rect 40..160 x 30..120 with the bottom-left corner replaced by an arc.
    const segs = [
      new LineEntity({ x: 55, y: 30 }, { x: 160, y: 30 }),
      new LineEntity({ x: 160, y: 30 }, { x: 160, y: 120 }),
      new LineEntity({ x: 160, y: 120 }, { x: 40, y: 120 }),
      new LineEntity({ x: 40, y: 120 }, { x: 40, y: 45 }),
      new ArcEntity({ x: 55, y: 45 }, 15, Math.PI, Math.PI * 1.5), // (40,45)→(55,30)
    ];
    const loops = collectClosedLoops(segs);
    expect(loops.length).toBe(1);
    expect(loops[0].ids.length).toBe(5);
    expect(pointInPolygon({ x: 100, y: 75 }, loops[0].verts)).toBe(true);
  });

  it("closes a loop made of lines + a bezier", () => {
    const segs = [
      new LineEntity({ x: 0, y: 0 }, { x: 100, y: 0 }),
      new LineEntity({ x: 100, y: 0 }, { x: 100, y: 50 }),
      new BezierEntity({ x: 100, y: 50 }, { x: 60, y: 90 }, { x: 40, y: 90 }, { x: 0, y: 50 }),
      new LineEntity({ x: 0, y: 50 }, { x: 0, y: 0 }),
    ];
    const loops = collectClosedLoops(segs);
    expect(loops.length).toBe(1);
    expect(pointInPolygon({ x: 50, y: 25 }, loops[0].verts)).toBe(true);
  });

  it("does not form a loop from a non-closing line + arc", () => {
    const segs = [
      new LineEntity({ x: 0, y: 0 }, { x: 100, y: 0 }),
      new ArcEntity({ x: 100, y: 50 }, 50, -Math.PI / 2, 0), // starts at (100,0), ends elsewhere, no closure
    ];
    expect(collectClosedLoops(segs).length).toBe(0);
  });
});

