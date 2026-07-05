import { test, expect } from "vitest";
import { planTiles } from "../src/cam/tiling";
import type { Bounds } from "../src/model/entities";

const B = (w: number, h: number, x = 0, y = 0): Bounds =>
  ({ min: { x, y }, max: { x: x + w, y: y + h } });

test("a design that fits the bed is a single tile with no seams", () => {
  const p = planTiles(B(100, 80), { tileW: 150, tileH: 150 });
  expect(p.cols).toBe(1);
  expect(p.rows).toBe(1);
  expect(p.tiles).toHaveLength(1);
  expect(p.seams).toEqual([]);
  expect(p.features).toEqual([]);
  expect(p.tiles[0].rect).toEqual(B(100, 80));
});

test("an exact multiple tiles without an extra sliver", () => {
  const p = planTiles(B(300, 150), { tileW: 150, tileH: 150 });
  expect([p.cols, p.rows]).toEqual([2, 1]);
  expect(p.seams).toHaveLength(1);
  expect(p.seams[0].orientation).toBe("vertical");
});

test("a 2x2 grid: tile rects partition the bounds, last row/col are smaller", () => {
  const p = planTiles(B(250, 250), { tileW: 150, tileH: 150 });
  expect([p.cols, p.rows]).toEqual([2, 2]);
  const rects = p.tiles.map((t) => t.rect);
  expect(rects).toContainEqual(B(150, 150, 0, 0));   // full tile
  expect(rects).toContainEqual(B(100, 150, 150, 0)); // right column narrower
  expect(rects).toContainEqual(B(150, 100, 0, 150)); // bottom row shorter
  expect(rects).toContainEqual(B(100, 100, 150, 150));
  // Tiles tile the plane with no gaps/overlap: summed area == design area.
  const area = rects.reduce((s, r) => s + (r.max.x - r.min.x) * (r.max.y - r.min.y), 0);
  expect(area).toBeCloseTo(250 * 250, 6);
});

test("a 2x2 grid has 4 seams and deduped features on the seam lines", () => {
  const p = planTiles(B(250, 250), { tileW: 150, tileH: 150 });
  expect(p.seams).toHaveLength(4); // 2 vertical + 2 horizontal
  expect(p.features).toHaveLength(8); // 2 per seam, none coincide

  for (const s of p.seams) {
    for (const f of s.features) {
      if (s.orientation === "vertical") {
        expect(f.x).toBeCloseTo(s.a.x, 9);           // sits on the seam line
        expect(f.y).toBeGreaterThan(Math.min(s.a.y, s.b.y));
        expect(f.y).toBeLessThan(Math.max(s.a.y, s.b.y));
      } else {
        expect(f.y).toBeCloseTo(s.a.y, 9);
        expect(f.x).toBeGreaterThan(Math.min(s.a.x, s.b.x));
        expect(f.x).toBeLessThan(Math.max(s.a.x, s.b.x));
      }
    }
  }
});

test("each seam joins the correct adjacent tile pair", () => {
  const p = planTiles(B(250, 250), { tileW: 150, tileH: 150 });
  // Tiles are row-major: 0,1 / 2,3.
  const pairs = p.seams.map((s) => s.tiles.slice().sort((a, b) => a - b).join(","));
  expect(pairs).toContain("0,1"); // top row vertical
  expect(pairs).toContain("2,3"); // bottom row vertical
  expect(pairs).toContain("0,2"); // left col horizontal
  expect(pairs).toContain("1,3"); // right col horizontal
});

test("featuresPerSeam=1 places a single feature at the seam midpoint", () => {
  const p = planTiles(B(300, 150), { tileW: 150, tileH: 150, featuresPerSeam: 1 });
  expect(p.features).toHaveLength(1);
  expect(p.features[0]).toEqual({ x: 150, y: 75 });
});

test("offset bounds keep tiles in world coordinates", () => {
  const p = planTiles(B(300, 150, 1000, 500), { tileW: 150, tileH: 150 });
  expect(p.tiles[0].rect).toEqual(B(150, 150, 1000, 500));
  expect(p.tiles[1].rect.min.x).toBe(1150);
});

test("toolpath margin pads the tiled region so overhang still fits", () => {
  // 140mm fits one 150mm tile — until a 10mm outside-profile overhang is added.
  expect(planTiles(B(140, 140), { tileW: 150, tileH: 150 }).cols).toBe(1);
  const padded = planTiles(B(140, 140), { tileW: 150, tileH: 150, toolpathMargin: 10 });
  expect([padded.cols, padded.rows]).toEqual([2, 2]);
  expect(padded.bounds).toEqual(B(160, 160, -10, -10));
});

test("keep-out regions suppress features that would land on material", () => {
  const seamStrip: Bounds = { min: { x: 149, y: 0 }, max: { x: 151, y: 150 } };
  const p = planTiles(B(300, 150), { tileW: 150, tileH: 150, keepOut: [seamStrip] });
  expect(p.seams[0].features).toEqual([]); // the whole seam is inside a part
  expect(p.features).toEqual([]);
});

test("a seam too short for two features falls back to one at its midpoint", () => {
  const p = planTiles(B(300, 20), { tileW: 150, tileH: 150 });
  expect([p.cols, p.rows]).toEqual([2, 1]);
  expect(p.seams[0].features).toEqual([{ x: 150, y: 10 }]);
});

test("rejects a non-positive tile size", () => {
  expect(() => planTiles(B(100, 100), { tileW: 0, tileH: 150 })).toThrow(/positive/);
});
