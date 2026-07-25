import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { CircleEntity, RasterImageEntity } from "../src/model/entities";
import { rasterizeStock } from "../src/cam/stockRasterizer";
import { registerEmbeddedImage } from "../src/core/imageManager";
import type { CAMOperation } from "../src/cam/types";

/**
 * A laser vector engrave must rasterize into a CONTINUOUS burn in the 3D-preview
 * height field — not the "spotty" dashed ring that a sub-cell beam stamp used to
 * produce (a 0.1 mm dot is ~0.2 cells at RES 4, so a swept line fell between grid
 * cells and marked nothing). Guards the one-cell stamp floor in makeStampFn.
 *
 * The preview harness (e2e/preview.e2e.ts) feeds a synthetic height field, so it
 * bypasses the stamp rasterizer — this unit test is what actually covers it.
 */
const engraveOp = (over: Partial<CAMOperation>): CAMOperation => ({
  id: "e",
  name: "engrave",
  type: "engrave",
  entityIds: [],
  side: "outside",
  toolType: "end-mill",
  toolNumber: 1,
  diameter: 1,
  feedrate: 900,
  plungeRate: 250,
  spindleSpeed: 0,
  safeZ: 5,
  depth: -2,
  stepdown: 2,
  stepover: 0.4,
  ...over,
});

test("laser vector engrave rasterizes a continuous ring (not spotty dots)", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.machineKind = "laser";
  doc.stockThickness = 6;
  const circle = doc.add(new CircleEntity({ x: 50, y: 50 }, 30));

  const hm = rasterizeStock([engraveOp({ entityIds: [circle.id] })], doc);

  const res = hm.gridW / hm.stockW; // cells per mm (RES; integer for this stock)
  const marked = (col: number, row: number): boolean => {
    if (col < 0 || row < 0 || col >= hm.gridW || row >= hm.gridH) return false;
    return hm.data[row * hm.gridW + col] < hm.stockT - 1e-6;
  };
  // Walk the ring; at each angle require a marked cell within the 3×3
  // neighbourhood of the ideal ring cell. A continuous burn covers every angle;
  // the old sub-cell stamp left large gaps.
  const SAMPLES = 720;
  let covered = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const a = (i / SAMPLES) * 2 * Math.PI;
    const wx = 50 + 30 * Math.cos(a);
    const wy = 50 + 30 * Math.sin(a);
    const col = Math.round(wx * res);
    const row = Math.round(wy * res);
    let hit = false;
    for (let dr = -1; dr <= 1 && !hit; dr++)
      for (let dc = -1; dc <= 1 && !hit; dc++) if (marked(col + dc, row + dr)) hit = true;
    if (hit) covered++;
  }
  expect(covered / SAMPLES).toBeGreaterThan(0.99);
});

test("a dithered laser image engrave previews as TONE, identical to greyscale (no black smear)", () => {
  // Regression: the 3-D height field is coarser than the dot pitch, so binarising a
  // dither pattern here fattened every dot to ≥1 cell and smeared a ~50%-density
  // photo into a solid full-depth (near-black) burn. The field must show tone.
  const grad = Array.from({ length: 32 }, (_, x) => Math.round((x / 31) * 255)); // black→white
  registerEmbeddedImage({
    id: "img-dither-prev",
    name: "grad",
    width: 32,
    height: 1,
    data: btoa(String.fromCharCode(...grad)),
  });
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.machineKind = "laser";
  doc.stockThickness = 6;
  const ent = doc.add(new RasterImageEntity("img-dither-prev", { x: 10, y: 10 }, 40, 30, 0));

  const base = engraveOp({ entityIds: [ent.id], rasterLineInterval: 0.5, rasterDotPitch: 0.5 });
  const grey = rasterizeStock([base], doc);
  const dithered = rasterizeStock([{ ...base, rasterDither: "floyd-steinberg" }], doc);

  // The preview shows graded depths (a gradient of burn), not two levels (uncut / full).
  const distinctDepths = new Set([...grey.data]);
  expect(distinctDepths.size).toBeGreaterThan(3);
  // And dithering leaves the 3-D field unchanged — tone, not a solid block.
  expect(dithered.data).toEqual(grey.data);
});
