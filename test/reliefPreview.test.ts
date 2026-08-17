import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { RasterImageEntity } from "../src/model/entities";
import { rasterizeStock } from "../src/cam/stockRasterizer";
import { registerEmbeddedImage } from "../src/core/imageManager";
import type { CAMOperation } from "../src/cam/types";

let n = 0;
const solid = (gray: number) => {
  const id = `img-rp-${n++}`;
  registerEmbeddedImage({
    id,
    name: id,
    width: 4,
    height: 4,
    data: btoa(String.fromCharCode(...new Array(16).fill(gray))),
  });
  return id;
};

const reliefOp = (entityIds: string[], over: Partial<CAMOperation> = {}): CAMOperation => ({
  id: "r",
  name: "relief",
  type: "engrave",
  entityIds,
  side: "outside",
  toolType: "ball-nose",
  toolNumber: 1,
  diameter: 2,
  feedrate: 1500,
  plungeRate: 300,
  spindleSpeed: 18000,
  safeZ: 5,
  depth: -3,
  stepdown: 3,
  stepover: 0.4,
  rasterLineInterval: 0.5,
  rasterDotPitch: 0.5,
  ...over,
});

function setup(gray: number, over: Partial<CAMOperation> = {}) {
  const id = solid(gray);
  const doc = new CADDocument({ width: 60, height: 60 });
  doc.stockThickness = 10;
  doc.add(new RasterImageEntity(id, { x: 10, y: 10 }, 20, 20, 0));
  const op = reliefOp([doc.entities.find((e) => e.type === "image")!.id], over);
  return rasterizeStock([op], doc);
}

test("relief preview: a black image carves the height field down to the relief depth", () => {
  const hm = setup(0); // black = deepest
  const carved = hm.stockT - Math.min(...hm.data);
  expect(carved).toBeGreaterThan(2.8); // ~3mm deep (a touch shy from the 0.5mm grid)
  expect(carved).toBeLessThanOrEqual(3 + 1e-6); // but never deeper than the relief depth
  // Stock outside the image footprint stays uncut.
  expect(Math.max(...hm.data)).toBeCloseTo(hm.stockT, 6);
});

test("relief preview: a white image removes nothing (stays at the surface)", () => {
  const hm = setup(255);
  expect(Math.min(...hm.data)).toBeCloseTo(hm.stockT, 6);
});

test("relief preview: a flat end mill carves nothing (mirrors the G-code skip)", () => {
  const hm = setup(0, { toolType: "end-mill" });
  expect(Math.min(...hm.data)).toBeCloseTo(hm.stockT, 6);
});

test("relief preview: invert carves the light areas instead", () => {
  const hm = setup(255, { rasterInvert: true }); // white→deep under invert
  expect(hm.stockT - Math.min(...hm.data)).toBeGreaterThan(2.8);
});

// --- steep/shallow split ------------------------------------------------------

/** A 32×32 cone height map (255 = top of model = no cut). */
function coneImage(slope: number, depth: number): string {
  const N = 32;
  const px: number[] = [];
  for (let py = 0; py < N; py++)
    for (let x = 0; x < N; x++) {
      const h = Math.max(0, depth - slope * Math.hypot(x + 0.5 - 16, N - py - 0.5 - 16));
      px.push(Math.round(255 * Math.min(1, h / depth)));
    }
  const id = `img-rp-${n++}`;
  registerEmbeddedImage({ id, name: id, width: N, height: N, data: btoa(String.fromCharCode(...px)) });
  return id;
}

function coneStock(over: Partial<CAMOperation> = {}) {
  const doc = new CADDocument({ width: 60, height: 60 });
  doc.stockThickness = 10;
  doc.add(new RasterImageEntity(coneImage(2, 6), { x: 10, y: 10 }, 32, 32, 0));
  const op = reliefOp([doc.entities.find((e) => e.type === "image")!.id], {
    depth: -6,
    stepdown: 6,
    diameter: 3,
    rasterLineInterval: 1,
    rasterDotPitch: 1,
    ...over,
  });
  return rasterizeStock([op], doc);
}

test("relief preview: the steep pass previews the passes it will actually cut", () => {
  // Not a cosmetic difference: with the split on, the wall is cut by contours at
  // discrete Z rather than by rows, so a preview that kept stamping the raster
  // would be a picture of a program that is no longer posted.
  const plain = coneStock();
  const steep = coneStock({ reliefSteepPass: true });
  expect(steep.data).not.toEqual(plain.data);

  // Both still carve the cone to its full depth and no further — the split
  // changes HOW the wall is reached, not where the surface is.
  for (const hm of [plain, steep]) {
    expect(hm.stockT - Math.min(...hm.data)).toBeGreaterThan(5.5);
    expect(Math.min(...hm.data)).toBeGreaterThanOrEqual(hm.stockT - 6 - 1e-6);
  }
});

test("relief preview: with nothing steep, the split leaves the picture untouched", () => {
  // The mirror of the byte-identical G-code guard: a shallow model must preview
  // exactly as before, or the split is perturbing something it shouldn't.
  const doc = () => {
    const d = new CADDocument({ width: 60, height: 60 });
    d.stockThickness = 10;
    d.add(new RasterImageEntity(coneImage(0.2, 3), { x: 10, y: 10 }, 32, 32, 0));
    return d;
  };
  const shallow = (over: Partial<CAMOperation>) => {
    const d = doc();
    return rasterizeStock(
      [
        reliefOp([d.entities.find((e) => e.type === "image")!.id], {
          depth: -3,
          stepdown: 3,
          diameter: 3,
          rasterLineInterval: 1,
          rasterDotPitch: 1,
          ...over,
        }),
      ],
      d,
    );
  };
  const off = shallow({});
  expect(shallow({ reliefSteepPass: true }).data).toEqual(off.data);
  expect(off.stockT - Math.min(...off.data)).toBeGreaterThan(2); // it did carve
});
