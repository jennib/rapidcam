import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { RasterImageEntity } from "../src/model/entities";
import { generateLaserGCode, laserPreviewPaths } from "../src/cam/lasergcode";
import { registerEmbeddedImage } from "../src/core/imageManager";
import type { CAMOperation } from "../src/cam/types";

// Register a greyscale image (row 0 = top, 0 = black) and return its id.
let counter = 0;
function registerGrid(rowsTopDown: number[][]): string {
  const w = rowsTopDown[0].length,
    h = rowsTopDown.length;
  const bytes = rowsTopDown.flat();
  const id = `img-rl-${counter++}`;
  registerEmbeddedImage({
    id,
    name: id,
    width: w,
    height: h,
    data: btoa(String.fromCharCode(...bytes)),
  });
  return id;
}

function engraveOp(entityIds: string[], over: Partial<CAMOperation> = {}): CAMOperation {
  return {
    id: "e1",
    name: "engrave",
    type: "engrave",
    entityIds,
    side: "outside",
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 0,
    feedrate: 3000,
    plungeRate: 300,
    spindleSpeed: 0,
    safeZ: 5,
    depth: 0,
    stepdown: 1,
    stepover: 0.4,
    laserPower: 100,
    rasterLineInterval: 2,
    rasterMinPower: 0,
    ...over,
  };
}

test("raster engrave is oriented correctly: a black top-left dot engraves at top-left in world", () => {
  // 2×2: top row [black, white], bottom row [white, white].
  const id = registerGrid([
    [0, 255],
    [255, 255],
  ]);
  const doc = new CADDocument({ width: 100, height: 100 });
  const ent = doc.add(new RasterImageEntity(id, { x: 10, y: 20 }, 4, 4, 0)); // 4mm, 2mm dot/row pitch → 2×2 dots

  const paths = laserPreviewPaths([engraveOp([ent.id], { rasterDotPitch: 2 })], doc);
  // Only the black top-left dot burns. World: bottom-left anchor (10,20); top row
  // sits at the HIGH y band (y = 20 + 1.5·2 = 23); left dot spans x 10→12.
  expect(paths).toHaveLength(1);
  expect(paths[0].pts).toEqual([
    { x: 10, y: 23 },
    { x: 12, y: 23 },
  ]);
});

test("flipX mirrors the engrave left↔right: a black top-left dot burns top-right", () => {
  const id = registerGrid([
    [0, 255],
    [255, 255],
  ]); // black top-left
  const doc = new CADDocument({ width: 100, height: 100 });
  const ent = doc.add(new RasterImageEntity(id, { x: 10, y: 20 }, 4, 4, 0));
  ent.flipX = true;
  const paths = laserPreviewPaths([engraveOp([ent.id], { rasterDotPitch: 2 })], doc);
  // Top row still at y=23, but the black dot is now the RIGHT column (x 12→14).
  expect(paths).toHaveLength(1);
  expect(paths[0].pts).toEqual([
    { x: 12, y: 23 },
    { x: 14, y: 23 },
  ]);
});

test("flipY mirrors the engrave top↔bottom: a black top-left dot burns bottom-left", () => {
  const id = registerGrid([
    [0, 255],
    [255, 255],
  ]); // black top-left
  const doc = new CADDocument({ width: 100, height: 100 });
  const ent = doc.add(new RasterImageEntity(id, { x: 10, y: 20 }, 4, 4, 0));
  ent.flipY = true;
  const paths = laserPreviewPaths([engraveOp([ent.id], { rasterDotPitch: 2 })], doc);
  // Left column still at x 10→12, but the black dot is now the BOTTOM row (y=21).
  expect(paths).toHaveLength(1);
  expect(paths[0].pts).toEqual([
    { x: 10, y: 21 },
    { x: 12, y: 21 },
  ]);
});

test("power is modulated per dot: darker → higher S, white skipped", () => {
  // One row, 4 dots: black, dark-grey, light-grey, white.
  const id = registerGrid([[0, 85, 170, 255]]);
  const doc = new CADDocument({ width: 100, height: 100 });
  const ent = doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, 4, 1, 0));
  const g = generateLaserGCode(
    [engraveOp([ent.id], { rasterDotPitch: 1, rasterLineInterval: 1 })],
    doc,
  );

  // Distinct S values appear, descending with brightness; the white dot is blank.
  const sVals = [...g.matchAll(/G1 [^\n]*S(\d+)/g)].map((m) => Number(m[1]));
  expect(sVals.length).toBe(3); // black, dark, light burn; white skipped
  expect(sVals[0]).toBeGreaterThan(sVals[1]); // black hotter than dark-grey
  expect(sVals[1]).toBeGreaterThan(sVals[2]);
  expect(g).toMatch(/M4|M3/); // beam on
  expect(g).toMatch(/M5/); // beam off
});

test("overscan brackets each lit run with beam-off run-up/run-down", () => {
  const id = registerGrid([[0]]); // one black dot
  const doc = new CADDocument({ width: 100, height: 100 });
  const ent = doc.add(new RasterImageEntity(id, { x: 10, y: 0 }, 2, 1, 0));
  const g = generateLaserGCode(
    [engraveOp([ent.id], { rasterDotPitch: 2, rasterLineInterval: 1, laserOverscan: 1 })],
    doc,
  );

  // Approach 1mm before the run (rapid), run up at S0, burn at S>0, run down at S0.
  expect(g).toMatch(/G0 X9 Y/); // 10 - 1mm overscan
  expect(g).toMatch(/G1 X10 Y[\d.]+ F\d+ S0/); // run-up, beam off
  expect(g).toMatch(/G1 X12 Y[\d.]+ S[1-9]\d*/); // lit run (positive S)
  expect(g).toMatch(/G1 X13 Y[\d.]+ S0/); // run-down past the end, beam off
});

test("missing pixels are reported, not silently dropped", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  const e1 = doc.add(new RasterImageEntity("img-not-loaded", { x: 0, y: 0 }, 10, 10, 0));
  expect(generateLaserGCode([engraveOp([e1.id])], doc)).toMatch(/pixels not loaded/);
});

test("a rotated image engraves along its tilted rows (no longer refused)", () => {
  const id = registerGrid([
    [0, 0],
    [0, 0],
  ]); // solid black 2×2
  const axis = new CADDocument({ width: 100, height: 100 });
  const ea = axis.add(new RasterImageEntity(id, { x: 10, y: 10 }, 10, 10, 0));
  const ga = generateLaserGCode([engraveOp([ea.id], { rasterLineInterval: 2 })], axis);

  const rot = new CADDocument({ width: 100, height: 100 });
  const er = rot.add(new RasterImageEntity(id, { x: 10, y: 10 }, 10, 10, Math.PI / 2)); // 90°
  const gr = generateLaserGCode([engraveOp([er.id], { rasterLineInterval: 2 })], rot);

  expect(gr).not.toMatch(/rotated/); // not skipped
  expect(gr).toMatch(/G1 [^\n]*S[1-9]/); // still burns a lit run
  expect(gr).not.toBe(ga); // rotation actually changed the coordinates

  // At 90° a local row (constant y, x sweeping) maps to a VERTICAL run in world:
  // world x = 10 - ly is constant along the run, world y = 10 + lx varies. Find a
  // lit move and confirm its predecessor shares X but differs in Y (a vertical sweep).
  const lit = gr.split("\n").findIndex((l) => /G1 .*S[1-9]/.test(l));
  const a = gr.split("\n")[lit - 1],
    b = gr.split("\n")[lit];
  const xOf = (l: string) => l.match(/X(-?[\d.]+)/)?.[1];
  const yOf = (l: string) => l.match(/Y(-?[\d.]+)/)?.[1];
  expect(xOf(a)).toBe(xOf(b)); // same X (vertical run)
  expect(yOf(a)).not.toBe(yOf(b)); // Y changed
});

// --- output-size checkpoint -------------------------------------------------
// The thing I flagged: "bounded" must mean "practical", not just "finite". A
// raster's move count is rows × runs-per-row, where runs-per-row is bounded by
// the number of distinct power levels in the row — NOT the pixel count. These
// pin that down so a regression that explodes the output (e.g. a run per pixel)
// fails loudly.

test("output size: a solid image is one run per row (rows = height / line interval)", () => {
  // Solid black 50×40mm at 0.2mm rows → 200 rows, each a single full-width run.
  const id = registerGrid([[0, 0, 0, 0]]); // tiny solid; physical size drives row count
  const doc = new CADDocument({ width: 100, height: 100 });
  const ent = doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, 50, 40, 0));
  const g = generateLaserGCode(
    [engraveOp([ent.id], { rasterLineInterval: 0.2, rasterDotPitch: 0.2 })],
    doc,
  );

  const litMoves = [...g.matchAll(/^G1 .*S\d/gm)].length;
  expect(litMoves).toBe(200); // exactly one lit run per scan row, not per dot
});

test("output size: a 50×40mm photo-like gradient stays bounded by tone levels, not megapixels", () => {
  // A 256-wide horizontal gradient (0..255) → at 1% power quantisation a row has
  // ~100 distinct power levels max, regardless of how wide it is in dots.
  const grad = Array.from({ length: 256 }, (_, x) => x);
  const id = registerGrid([grad]); // 256×1 source; tiled vertically by resampling
  const doc = new CADDocument({ width: 100, height: 100 });
  const ent = doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, 50, 40, 0));
  const g = generateLaserGCode(
    [engraveOp([ent.id], { rasterLineInterval: 0.2, rasterDotPitch: 0.2 })],
    doc,
  );

  const rows = 200; // 40mm / 0.2mm
  const litMoves = [...g.matchAll(/^G1 .*S\d/gm)].length;
  // Per-row runs are capped by distinct power levels (≤100), not the 250 dots.
  expect(litMoves).toBeLessThanOrEqual(rows * 110);
  expect(litMoves).toBeGreaterThan(rows); // it does vary, so more than one run/row
});
