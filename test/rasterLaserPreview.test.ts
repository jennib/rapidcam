import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { CircleEntity, RasterImageEntity, RectEntity } from "../src/model/entities";
import { LASER_BURN_DEPTH_MM, rasterizeStock } from "../src/cam/stockRasterizer";
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

test("an area-fill engrave burns SOLID in the preview, not just its outline", () => {
  // The preview must remove the material the beam removes. The rasterizer used
  // to stroke only the entity outline for an engrave, whatever `laserFill` said,
  // so a solid fill previewed as hollow lettering while the posted program
  // filled it — the picture and the program disagreed. It now asks the laser
  // generator for the geometry it will actually burn (laserFillGeometry).
  const mk = (fill: boolean) => {
    const doc = new CADDocument({ width: 60, height: 60 });
    doc.machineKind = "laser";
    const r = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 40, y: 40 }));
    const op = engraveOp({
      entityIds: [r.id],
      ...(fill ? { laserFill: true, laserFillSpacing: 0.2 } : {}),
    });
    const hm = rasterizeStock([op], doc);
    // Centre of the 20mm square — interior, well clear of the outline stroke.
    const cx = Math.round((30 / 60) * (hm.gridW - 1));
    const cy = Math.round((30 / 60) * (hm.gridH - 1));
    let cutCells = 0;
    for (const v of hm.data) if (v < hm.stockT - 1e-6) cutCells++;
    return { centre: hm.stockT - hm.data[cy * hm.gridW + cx], cutCells };
  };

  const outline = mk(false);
  const filled = mk(true);
  // Guard: the outline case really did burn something, so the contrast is real.
  expect(outline.cutCells).toBeGreaterThan(0);
  expect(outline.centre).toBe(0); // hollow — only the ring is burned
  expect(filled.centre).toBeCloseTo(LASER_BURN_DEPTH_MM, 6); // solid to the burn depth
  // A filled 20x20 square covers far more cells than its outline alone.
  expect(filled.cutCells).toBeGreaterThan(outline.cutCells * 4);
});
