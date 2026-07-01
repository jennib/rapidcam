import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { RasterImageEntity } from "../src/model/entities";
import { evaluateAll, makeVariable } from "../src/model/variables";
import { serializeDoc, applyFile } from "../src/io/fileio";
import { registerEmbeddedImage, type EmbeddedImage } from "../src/core/imageManager";

const emb: EmbeddedImage = { id: "img-p1", name: "x", width: 2, height: 2, data: btoa(String.fromCharCode(0, 255, 255, 0)) };

test("image width/height/angle formulas evaluate + re-evaluate from variables", () => {
  const img = new RasterImageEntity("img-p1", { x: 0, y: 0 }, 10, 10, 0);
  img.widthExpr = "plateW/2";
  img.heightExpr = "plateW/4";
  img.angleExpr = "tilt";               // degrees
  const vars = [makeVariable("plateW", "100", "mm"), makeVariable("tilt", "30", "mm")];

  evaluateAll(vars, [], "mm", [img]);
  expect(img.widthMM).toBe(50);
  expect(img.heightMM).toBe(25);
  expect(img.angle).toBeCloseTo((30 * Math.PI) / 180, 9);

  // Change a variable → the image resizes on the next evaluate.
  vars[0].expr = "200";
  evaluateAll(vars, [], "mm", [img]);
  expect(img.widthMM).toBe(100);
  expect(img.heightMM).toBe(50);
});

test("a literal (no expr) image is left untouched by evaluateAll", () => {
  const img = new RasterImageEntity("img-p1", { x: 0, y: 0 }, 33, 17, 0.5);
  evaluateAll([makeVariable("plateW", "100", "mm")], [], "mm", [img]);
  expect([img.widthMM, img.heightMM, img.angle]).toEqual([33, 17, 0.5]);
});

test("image formula fields round-trip through save/load and duplicate", () => {
  registerEmbeddedImage(emb);
  const doc = new CADDocument({ width: 200, height: 150 });
  const e = new RasterImageEntity("img-p1", { x: 5, y: 6 }, 40, 20, 0);
  e.widthExpr = "plateW/2"; e.heightExpr = "plateW/4"; e.angleExpr = "tilt";
  doc.add(e);
  expect(e.duplicate().widthExpr).toBe("plateW/2");

  const doc2 = new CADDocument({ width: 1, height: 1 });
  applyFile(doc2, serializeDoc(doc, "expr"));
  const ie = doc2.entities.find((x) => x.type === "image") as RasterImageEntity;
  expect([ie.widthExpr, ie.heightExpr, ie.angleExpr]).toEqual(["plateW/2", "plateW/4", "tilt"]);
});

test("aspect-locked width formula derives height from the current proportions", () => {
  const img = new RasterImageEntity("img-p1", { x: 0, y: 0 }, 40, 20, 0); // aspect 2:1
  img.aspectLocked = true;
  img.widthExpr = "plateW"; // only width is a formula → height follows
  evaluateAll([makeVariable("plateW", "100", "mm")], [], "mm", [img]);
  expect(img.widthMM).toBe(100);
  expect(img.heightMM).toBe(50); // 100 / (40/20)

  // Two explicit formulas win over the lock (both sides independent).
  const img2 = new RasterImageEntity("img-p1", { x: 0, y: 0 }, 40, 20, 0);
  img2.aspectLocked = true; img2.widthExpr = "plateW"; img2.heightExpr = "plateW/5";
  evaluateAll([makeVariable("plateW", "100", "mm")], [], "mm", [img2]);
  expect([img2.widthMM, img2.heightMM]).toEqual([100, 20]);
});

test("aspectLocked round-trips (and legacy files default to true)", () => {
  registerEmbeddedImage(emb);
  const doc = new CADDocument({ width: 200, height: 150 });
  const e = new RasterImageEntity("img-p1", { x: 5, y: 6 }, 40, 20, 0);
  e.aspectLocked = false;
  doc.add(e);
  const doc2 = new CADDocument({ width: 1, height: 1 });
  applyFile(doc2, serializeDoc(doc, "al"));
  expect((doc2.entities.find((x) => x.type === "image") as RasterImageEntity).aspectLocked).toBe(false);
});

test("renaming a variable rewrites the image's formulas", () => {
  const doc = new CADDocument({ width: 200, height: 150 });
  const e = new RasterImageEntity("img-p1", { x: 0, y: 0 }, 40, 20, 0);
  e.widthExpr = "plateW/2"; e.angleExpr = "plateW - tilt";
  doc.add(e);
  doc.renameVariableRefs("plateW", "boardW");
  expect(e.widthExpr).toBe("boardW/2");
  expect(e.angleExpr).toBe("boardW - tilt");
});
