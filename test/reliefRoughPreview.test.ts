import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { RasterImageEntity } from "../src/model/entities";
import { rasterizeStock } from "../src/cam/stockRasterizer";
import { registerEmbeddedImage } from "../src/core/imageManager";
import type { CAMOperation } from "../src/cam/types";

let n = 0;
const solid = (gray: number) => {
  const id = `img-rrp-${n++}`;
  registerEmbeddedImage({
    id,
    name: id,
    width: 4,
    height: 4,
    data: btoa(String.fromCharCode(...new Array(16).fill(gray))),
  });
  return id;
};

const roughOp = (entityIds: string[], over: Partial<CAMOperation> = {}): CAMOperation => ({
  id: "rr",
  name: "rough",
  type: "relief-rough",
  entityIds,
  side: "outside",
  toolType: "end-mill",
  toolNumber: 1,
  diameter: 2,
  feedrate: 1500,
  plungeRate: 300,
  spindleSpeed: 18000,
  safeZ: 5,
  depth: -3,
  stepdown: 1,
  stepover: 0.4,
  finishAllowance: 0.5,
  ...over,
});

function setup(gray: number, over: Partial<CAMOperation> = {}) {
  const id = solid(gray);
  const doc = new CADDocument({ width: 60, height: 60 });
  doc.stockThickness = 10;
  doc.add(new RasterImageEntity(id, { x: 10, y: 10 }, 20, 20, 0));
  const op = roughOp([doc.entities.find((e) => e.type === "image")!.id], over);
  return rasterizeStock([op], doc);
}

test("rough preview: a black image is cleared to the last step, leaving the finish allowance", () => {
  const hm = setup(0); // black = roughed deepest
  const carved = hm.stockT - Math.min(...hm.data);
  // depth 3, allowance 0.5 → roughing removes down to −2.5 (the finish pass takes the rest).
  expect(carved).toBeGreaterThan(2.0);
  expect(carved).toBeLessThanOrEqual(2.5 + 1e-6); // never into the 0.5mm allowance
  expect(Math.max(...hm.data)).toBeCloseTo(hm.stockT, 6); // stock outside the image untouched
});

test("rough preview: a flat end mill DOES carve (unlike the ball-nose-only finish)", () => {
  const hm = setup(0, { toolType: "end-mill" });
  expect(hm.stockT - Math.min(...hm.data)).toBeGreaterThan(2.0);
});

test("rough preview: a white image removes nothing", () => {
  const hm = setup(255);
  expect(Math.min(...hm.data)).toBeCloseTo(hm.stockT, 6);
});

test("rough preview: the staircase floor never dips below depth − allowance", () => {
  const hm = setup(0, { depth: -4, stepdown: 1.5, finishAllowance: 0.6 });
  const carved = hm.stockT - Math.min(...hm.data);
  expect(carved).toBeLessThanOrEqual(4 - 0.6 + 1e-6); // ≤ 3.4mm, the roughing floor
});
