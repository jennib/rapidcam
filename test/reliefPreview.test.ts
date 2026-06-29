import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { RasterImageEntity } from "../src/model/entities";
import { rasterizeStock } from "../src/cam/stockRasterizer";
import { registerEmbeddedImage } from "../src/core/imageManager";
import type { CAMOperation } from "../src/cam/types";

let n = 0;
const solid = (gray: number) => {
  const id = `img-rp-${n++}`;
  registerEmbeddedImage({ id, name: id, width: 4, height: 4, data: btoa(String.fromCharCode(...new Array(16).fill(gray))) });
  return id;
};

const reliefOp = (entityIds: string[], over: Partial<CAMOperation> = {}): CAMOperation => ({
  id: "r", name: "relief", type: "engrave", entityIds, side: "outside",
  toolType: "ball-nose", toolNumber: 1, diameter: 2,
  feedrate: 1500, plungeRate: 300, spindleSpeed: 18000, safeZ: 5,
  depth: -3, stepdown: 3, stepover: 0.4,
  rasterLineInterval: 0.5, rasterDotPitch: 0.5, ...over,
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
  expect(carved).toBeGreaterThan(2.8);          // ~3mm deep (a touch shy from the 0.5mm grid)
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
