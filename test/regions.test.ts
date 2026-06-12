import { describe, it, expect } from "vitest";
import { regionAtPoint, interiorPoint } from "../src/cam/regions";
import { pointInPolygon, type RegionLoop } from "../src/cam/loops";
import { signedArea } from "../src/cam/offset";
import type { Vec2 } from "../src/core/vec2";

const rect = (x: number, y: number, w: number, h: number): Vec2[] => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];
const loop = (verts: Vec2[], id: string): RegionLoop => ({ verts, ids: [id] });

const regionArea = (r: { outer: Vec2[]; holes: Vec2[][] }) =>
  Math.abs(signedArea(r.outer)) - r.holes.reduce((s, h) => s + Math.abs(signedArea(h)), 0);

describe("regionAtPoint — flood-fill face picking", () => {
  // Two overlapping rectangles: A spans x 0..50, B spans x 30..80, both y 0..50.
  // Faces: A-only crescent (1500), intersection (1000), B-only crescent (1500).
  const A = loop(rect(0, 0, 50, 50), "A");
  const B = loop(rect(30, 0, 50, 50), "B");
  const overlapping = [A, B];

  it("returns null outside all loops", () => {
    expect(regionAtPoint({ x: 200, y: 200 }, overlapping)).toBeNull();
  });

  it("picks the intersection face of two overlapping rects", () => {
    const r = regionAtPoint({ x: 40, y: 25 }, overlapping)!;
    expect(regionArea(r)).toBeCloseTo(20 * 50, 0);
    expect(r.holes.length).toBe(0);
    expect(r.loopIds.sort()).toEqual(["A", "B"]);
  });

  it("picks the A-only crescent without the intersection", () => {
    const r = regionAtPoint({ x: 10, y: 25 }, overlapping)!;
    expect(regionArea(r)).toBeCloseTo(50 * 50 - 20 * 50, 0);
    // No part of the region may reach into B.
    expect(r.outer.every((v) => v.x <= 30 + 0.01)).toBe(true);
  });

  it("treats a fully enclosed shape as a hole (island)", () => {
    const outer = loop(rect(0, 0, 100, 100), "outer");
    const inner = loop(rect(40, 40, 20, 20), "inner");
    const r = regionAtPoint({ x: 5, y: 5 }, [outer, inner])!;
    expect(r.holes.length).toBe(1);
    expect(regionArea(r)).toBeCloseTo(100 * 100 - 20 * 20, 0);
    expect(r.loopIds.sort()).toEqual(["inner", "outer"]);
  });

  it("handles multi-level nesting (island inside an island's pocket)", () => {
    const outer  = loop(rect(0, 0, 100, 100), "outer");
    const island = loop(rect(30, 30, 40, 40), "island");
    const nested = loop(rect(45, 45, 10, 10), "nested");
    const loops = [outer, island, nested];
    // Click in the outer face: island is a hole, nested (inside the hole) is not.
    const rOuter = regionAtPoint({ x: 5, y: 5 }, loops)!;
    expect(rOuter.holes.length).toBe(1);
    expect(regionArea(rOuter)).toBeCloseTo(100 * 100 - 40 * 40, 0);
    // Click between island and nested: that face has nested as its hole.
    const rIsland = regionAtPoint({ x: 35, y: 35 }, loops)!;
    expect(rIsland.holes.length).toBe(1);
    expect(regionArea(rIsland)).toBeCloseTo(40 * 40 - 10 * 10, 0);
  });

  it("selects only the connected component containing the click", () => {
    // B cuts A into two disjoint pieces; clicking the left piece must not
    // select the right piece.
    const A2 = loop(rect(0, 0, 100, 20), "A");
    const B2 = loop(rect(40, -10, 20, 40), "B");
    const r = regionAtPoint({ x: 10, y: 10 }, [A2, B2])!;
    expect(regionArea(r)).toBeCloseTo(40 * 20, 0);
    expect(r.outer.every((v) => v.x <= 40 + 0.01)).toBe(true);
  });

  it("picking inside the cutting shape yields only that face", () => {
    const A2 = loop(rect(0, 0, 100, 20), "A");
    const B2 = loop(rect(40, -10, 20, 40), "B");
    // B − A is two disjoint 20×10 strips (above and below A); the click is in
    // the upper strip, so only that component is returned.
    const r = regionAtPoint({ x: 50, y: 25 }, [A2, B2])!;
    expect(regionArea(r)).toBeCloseTo(20 * 10, 0);
    expect(r.outer.every((v) => v.y >= 20 - 0.01)).toBe(true);
  });
});

describe("interiorPoint", () => {
  it("finds a point inside a plain polygon", () => {
    const poly = rect(10, 10, 30, 20);
    const p = interiorPoint(poly)!;
    expect(pointInPolygon(p, poly)).toBe(true);
  });

  it("avoids holes", () => {
    const outer = rect(0, 0, 100, 100);
    const hole = rect(25, 25, 50, 50); // centred hole — centroid is inside it
    const p = interiorPoint(outer, [hole])!;
    expect(pointInPolygon(p, outer)).toBe(true);
    expect(pointInPolygon(p, hole)).toBe(false);
  });
});
