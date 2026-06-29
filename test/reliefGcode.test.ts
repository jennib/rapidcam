import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { RasterImageEntity } from "../src/model/entities";
import { generateGCode } from "../src/cam/gcode";
import { registerEmbeddedImage } from "../src/core/imageManager";
import type { CAMOperation } from "../src/cam/types";

let counter = 0;
function registerGrid(rowsTopDown: number[][]): string {
  const w = rowsTopDown[0].length, h = rowsTopDown.length;
  const id = `img-rl-${counter++}`;
  registerEmbeddedImage({ id, name: id, width: w, height: h, data: btoa(String.fromCharCode(...rowsTopDown.flat())) });
  return id;
}

function reliefOp(entityIds: string[], over: Partial<CAMOperation> = {}): CAMOperation {
  return {
    id: "r1", name: "relief", type: "engrave", entityIds, side: "outside",
    toolType: "ball-nose", toolNumber: 1, diameter: 2,
    feedrate: 1500, plungeRate: 300, spindleSpeed: 18000, safeZ: 5,
    depth: -2, stepdown: 2, stepover: 0.4,
    rasterLineInterval: 2, rasterDotPitch: 2, ...over,
  };
}

// Pull (X, Y, Z) from every G1 move that commands a Z.
const zMoves = (g: string) =>
  [...g.matchAll(/G1 X(-?[\d.]+) Y(-?[\d.]+) Z(-?[\d.]+)/g)].map((m) => ({ x: +m[1], y: +m[2], z: +m[3] }));

test("relief: a black top-left pixel carves deepest at top-left in world (Y-up, depth)", () => {
  // 2×2: top row [black, white], bottom row [white, white].
  const id = registerGrid([[0, 255], [255, 255]]);
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.add(new RasterImageEntity(id, { x: 10, y: 20 }, 4, 4, 0));
  const g = generateGCode([reliefOp([doc.entities.find((e) => e.type === "image")!.id])], doc);

  const moves = zMoves(g);
  const deepest = moves.reduce((a, b) => (b.z < a.z ? b : a));
  expect(deepest.z).toBeCloseTo(-2, 6);  // black dot reaches full depth
  expect(deepest.x).toBeCloseTo(11, 6);  // left column (dot centre at 10 + 0.5·2)
  expect(deepest.y).toBeCloseTo(23, 6);  // TOP band (20 + 1.5·2) — image row 0 is up
  // Nothing is cut deeper than the relief depth; white stays at the surface.
  for (const m of moves) expect(m.z).toBeGreaterThanOrEqual(-2 - 1e-6);
  expect(moves.some((m) => Math.abs(m.z) < 1e-9)).toBe(true);
});

test("relief: requires a depth-shaping bit (ball-nose / V-bit)", () => {
  const id = registerGrid([[0]]);
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, 10, 10, 0));
  const imgId = doc.entities.find((e) => e.type === "image")!.id;
  expect(generateGCode([reliefOp([imgId], { toolType: "end-mill" })], doc)).toMatch(/needs a ball-nose or V-bit/);
  expect(zMoves(generateGCode([reliefOp([imgId], { toolType: "end-mill" })], doc))).toEqual([]);
  // V-bit is accepted.
  expect(zMoves(generateGCode([reliefOp([imgId], { toolType: "v-bit" })], doc)).length).toBeGreaterThan(0);
});

test("relief: reaches depth over stepdown passes (never one deep plunge)", () => {
  const id = registerGrid([[0, 0]]); // a solid-black 1-row image
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, 6, 2, 0));
  // depth 3, stepdown 1 → 3 passes; the floor deepens 1mm at a time.
  const g = generateGCode([reliefOp([doc.entities.find((e) => e.type === "image")!.id],
    { depth: -3, stepdown: 1, rasterLineInterval: 2, rasterDotPitch: 2 })], doc);
  // The depth floor deepens one stepdown per pass (so virgin-material engagement
  // per pass is ≤ stepdown — prior passes already cleared the material above).
  const floors = [...new Set(zMoves(g).map((m) => m.z))].sort((a, b) => a - b);
  expect(floors).toEqual([-3, -2, -1]);
  // Three distinct passes (each starts with a safe-Z retract + plunge).
  const passStarts = [...g.matchAll(/G0 Z[\d.]+\nG0 X[^\n]+\nG1 Z(-?[\d.]+) F/g)].length;
  expect(passStarts).toBe(3);
});

test("relief: missing pixels / rotation are reported, not silently dropped", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.add(new RasterImageEntity("img-missing", { x: 0, y: 0 }, 10, 10, 0));
  expect(generateGCode([reliefOp([doc.entities.find((e) => e.type === "image")!.id])], doc)).toMatch(/pixels not loaded/);

  const id = registerGrid([[0]]);
  const doc2 = new CADDocument({ width: 100, height: 100 });
  doc2.add(new RasterImageEntity(id, { x: 0, y: 0 }, 10, 10, 0.3));
  expect(generateGCode([reliefOp([doc2.entities.find((e) => e.type === "image")!.id])], doc2)).toMatch(/rotated; relief engrave is axis-aligned/);
});

// --- output-size checkpoint -------------------------------------------------
test("output size: a solid relief merges each row to its endpoints (not one move per dot)", () => {
  const id = registerGrid([[0, 0, 0, 0]]); // solid; physical size drives the dot grid
  const doc = new CADDocument({ width: 200, height: 200 });
  doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, 50, 40, 0));
  // 0.2mm stepover/dot → 250×200 dots; depth 2 / stepdown 2 → 1 pass.
  const g = generateGCode([reliefOp([doc.entities.find((e) => e.type === "image")!.id],
    { depth: -2, stepdown: 2, rasterLineInterval: 0.2, rasterDotPitch: 0.2 })], doc);
  const moves = zMoves(g).length;
  // Equal-depth dots collapse: ~2 segments per row (×200 rows), not 250×200.
  expect(moves).toBeLessThan(200 * 6);
  expect(moves).toBeGreaterThan(200); // but every row is represented
});

test("a large relief generates without overflowing the stack (no spread-push)", () => {
  // ~290k moves — large enough that `lines.push(...reliefBody)` would overflow.
  const bytes = Uint8Array.from({ length: 400 * 300 }, (_, i) => (i * 37) % 256);
  let bin = ""; const C = 0x8000; // chunk: String.fromCharCode(...) also has an arg limit
  for (let i = 0; i < bytes.length; i += C) bin += String.fromCharCode(...bytes.subarray(i, i + C));
  registerEmbeddedImage({ id: "img-big", name: "big", width: 400, height: 300, data: btoa(bin) });

  const doc = new CADDocument({ width: 200, height: 200 });
  doc.add(new RasterImageEntity("img-big", { x: 0, y: 0 }, 80, 60, 0));
  const id = doc.entities.find((e) => e.type === "image")!.id;
  let g = "";
  expect(() => { g = generateGCode([reliefOp([id], { depth: -3, stepdown: 1.5, rasterLineInterval: 0.15, rasterDotPitch: 0.15 })], doc); }).not.toThrow();
  expect((g.match(/^G1 /gm) || []).length).toBeGreaterThan(150_000);
});

test("output size: a gradient relief stays bounded by the dot grid × passes", () => {
  const grad = Array.from({ length: 256 }, (_, x) => x);
  const id = registerGrid([grad]); // 256×1, tiled vertically by resampling
  const doc = new CADDocument({ width: 200, height: 200 });
  doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, 50, 40, 0));
  const g = generateGCode([reliefOp([doc.entities.find((e) => e.type === "image")!.id],
    { depth: -3, stepdown: 1.5, rasterLineInterval: 0.2, rasterDotPitch: 0.2 })], doc);
  const cols = 250, rows = 200, passes = 2;
  const moves = zMoves(g).length;
  expect(moves).toBeLessThanOrEqual(cols * rows * passes); // bounded, not unbounded
  expect(moves).toBeGreaterThan(rows); // it does vary with tone
});
