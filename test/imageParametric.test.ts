import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { RasterImageEntity } from "../src/model/entities";
import { solve } from "../src/solver/solver";
import { evaluateAll, makeVariable } from "../src/model/variables";
import { serializeDoc, applyFile } from "../src/io/fileio";
import { registerEmbeddedImage, type EmbeddedImage } from "../src/core/imageManager";

const emb: EmbeddedImage = {
  id: "img-p1",
  name: "x",
  width: 2,
  height: 2,
  data: btoa(String.fromCharCode(0, 255, 255, 0)),
};

function resolve(doc: CADDocument) {
  evaluateAll(doc.variables, doc.dimensions, doc.displayUnit);
  return solve(doc);
}

test("image width/height/angle bindings drive (and re-drive) from variables", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  const img = doc.add(new RasterImageEntity("img-p1", { x: 0, y: 0 }, 10, 10, 0));
  doc.variables.push(makeVariable("plateW", "100", "mm"), makeVariable("tilt", "30", "mm"));
  doc.bindings.push(
    { id: "bw", entityId: img.id, scalarKey: "w", expr: "plateW/2" },
    { id: "bh", entityId: img.id, scalarKey: "h", expr: "plateW/4" },
    { id: "ba", entityId: img.id, scalarKey: "angle", expr: "tilt", scale: Math.PI / 180 },
  );

  resolve(doc);
  expect(img.widthMM).toBeCloseTo(50, 3);
  expect(img.heightMM).toBeCloseTo(25, 3);
  expect(img.angle).toBeCloseTo((30 * Math.PI) / 180, 6);

  // Change a variable → the image resizes on the next solve.
  doc.variables[0].expr = "200";
  resolve(doc);
  expect(img.widthMM).toBeCloseTo(100, 3);
  expect(img.heightMM).toBeCloseTo(50, 3);
});

test("an unbound image is left untouched by solve", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  const img = doc.add(new RasterImageEntity("img-p1", { x: 0, y: 0 }, 33, 17, 0.5));
  doc.variables.push(makeVariable("plateW", "100", "mm"));
  resolve(doc);
  expect([img.widthMM, img.heightMM, img.angle]).toEqual([33, 17, 0.5]);
});

test("image scalar bindings round-trip through save/load", () => {
  registerEmbeddedImage(emb);
  const doc = new CADDocument({ width: 200, height: 150 });
  const e = doc.add(new RasterImageEntity("img-p1", { x: 5, y: 6 }, 40, 20, 0));
  doc.bindings.push(
    { id: "bw", entityId: e.id, scalarKey: "w", expr: "plateW/2" },
    { id: "ba", entityId: e.id, scalarKey: "angle", expr: "tilt", scale: Math.PI / 180 },
  );
  const doc2 = new CADDocument({ width: 1, height: 1 });
  applyFile(doc2, serializeDoc(doc, "b"));
  expect(doc2.bindings).toEqual([
    { id: "bw", entityId: e.id, scalarKey: "w", expr: "plateW/2" },
    { id: "ba", entityId: e.id, scalarKey: "angle", expr: "tilt", scale: Math.PI / 180 },
  ]);
});

test("legacy image formula fields (widthExpr/heightExpr/angleExpr) migrate to bindings on load", () => {
  registerEmbeddedImage(emb);
  const doc = new CADDocument({ width: 200, height: 150 });
  doc.add(new RasterImageEntity("img-p1", { x: 5, y: 6 }, 40, 20, 0));
  // Hand-craft a pre-unification file: inject the retired *Expr fields.
  const file = structuredClone(serializeDoc(doc, "legacy"));
  const ie = file.entities!.find((x) => (x as { type: string }).type === "image") as Record<
    string,
    unknown
  >;
  ie.widthExpr = "plateW/2";
  ie.heightExpr = "plateW/4";
  ie.angleExpr = "tilt";

  const doc2 = new CADDocument({ width: 1, height: 1 });
  applyFile(doc2, file);
  const b = doc2.bindings;
  expect(b.find((x) => x.scalarKey === "w")?.expr).toBe("plateW/2");
  expect(b.find((x) => x.scalarKey === "h")?.expr).toBe("plateW/4");
  const ang = b.find((x) => x.scalarKey === "angle");
  expect(ang?.expr).toBe("tilt");
  expect(ang?.scale).toBeCloseTo(Math.PI / 180, 9); // degree formula → radian DOF

  // …and the migrated bindings actually drive the image.
  doc2.variables.push(makeVariable("plateW", "100", "mm"), makeVariable("tilt", "30", "mm"));
  resolve(doc2);
  const mig = doc2.entities.find((x) => x.type === "image") as RasterImageEntity;
  expect(mig.widthMM).toBeCloseTo(50, 3);
  expect(mig.heightMM).toBeCloseTo(25, 3);
  expect(mig.angle).toBeCloseTo((30 * Math.PI) / 180, 6);
});

test("aspectLocked round-trips (and legacy files default to true)", () => {
  registerEmbeddedImage(emb);
  const doc = new CADDocument({ width: 200, height: 150 });
  const e = new RasterImageEntity("img-p1", { x: 5, y: 6 }, 40, 20, 0);
  e.aspectLocked = false;
  doc.add(e);
  const doc2 = new CADDocument({ width: 1, height: 1 });
  applyFile(doc2, serializeDoc(doc, "al"));
  expect((doc2.entities.find((x) => x.type === "image") as RasterImageEntity).aspectLocked).toBe(
    false,
  );
});

test("renaming a variable rewrites an image's binding formula", () => {
  const doc = new CADDocument({ width: 200, height: 150 });
  const e = doc.add(new RasterImageEntity("img-p1", { x: 0, y: 0 }, 40, 20, 0));
  doc.bindings.push(
    { id: "bw", entityId: e.id, scalarKey: "w", expr: "plateW/2" },
    { id: "ba", entityId: e.id, scalarKey: "angle", expr: "plateW - tilt", scale: Math.PI / 180 },
  );
  doc.renameVariableRefs("plateW", "boardW");
  expect(doc.bindings[0].expr).toBe("boardW/2");
  expect(doc.bindings[1].expr).toBe("boardW - tilt");
});
