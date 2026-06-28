import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { RasterImageEntity } from "../src/model/entities";
import { serializeDoc, applyFile } from "../src/io/fileio";
import {
  registerEmbeddedImage, getImageGrid, isImageResolvable, type EmbeddedImage,
} from "../src/core/imageManager";

// A 2×2 greyscale checker: top row [black, white], bottom row [white, black].
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const emb: EmbeddedImage = { id: "img-test1", name: "checker", width: 2, height: 2, data: b64([0, 255, 255, 0]) };

test("registerEmbeddedImage makes the pixels resolvable as a 0..1 grid", () => {
  registerEmbeddedImage(emb);
  expect(isImageResolvable("img-test1")).toBe(true);
  const grid = getImageGrid("img-test1")!;
  expect([grid.width, grid.height]).toEqual([2, 2]);
  expect([...grid.data]).toEqual([0, 1, 1, 0]); // 0=black .. 1=white
});

test("RasterImageEntity geometry: corners, bounds, hit-test, translate, duplicate", () => {
  const e = new RasterImageEntity("img-test1", { x: 10, y: 20 }, 30, 15, 0);
  expect(e.corners()).toEqual([
    { x: 10, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 35 }, { x: 10, y: 35 },
  ]);
  expect(e.bounds()).toEqual({ min: { x: 10, y: 20 }, max: { x: 40, y: 35 } });
  expect(e.distanceTo({ x: 25, y: 27 })).toBe(0);          // inside → selectable anywhere
  expect(e.distanceTo({ x: 45, y: 27 })).toBeCloseTo(5, 6); // 5mm right of the edge

  e.translate({ x: 1, y: 2 });
  expect(e.position).toEqual({ x: 11, y: 22 });

  const d = e.duplicate();
  expect(d.id).not.toBe(e.id);
  expect([d.imageId, d.widthMM, d.heightMM]).toEqual(["img-test1", 30, 15]);
});

test("an image entity + its pixels survive a save/load round-trip", () => {
  registerEmbeddedImage(emb);
  const doc = new CADDocument({ width: 200, height: 150 });
  doc.add(new RasterImageEntity("img-test1", { x: 5, y: 6 }, 40, 20, 0.25));

  const file = serializeDoc(doc, "img");
  // The greyscale bytes are embedded in the file (like fonts).
  expect(file.images).toHaveLength(1);
  expect(file.images![0].id).toBe("img-test1");
  expect(file.images![0].data).toBe(emb.data);

  const doc2 = new CADDocument({ width: 1, height: 1 });
  applyFile(doc2, file);
  const ie = doc2.entities.find((e) => e.type === "image") as RasterImageEntity;
  expect([ie.imageId, ie.widthMM, ie.heightMM, ie.angle]).toEqual(["img-test1", 40, 20, 0.25]);
  expect(ie.position).toEqual({ x: 5, y: 6 });
});

test("a document with no image entity embeds no images array", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  expect(serializeDoc(doc, "empty").images).toBeUndefined();
});
