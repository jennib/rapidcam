import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { CircleEntity, RasterImageEntity } from "../src/model/entities";
import { makeConstraint } from "../src/model/constraints";
import { solve } from "../src/solver/solver";
import { serializeDoc, applyFile } from "../src/io/fileio";

const near = (p: { x: number; y: number }, x: number, y: number, d = 3) => {
  expect(p.x).toBeCloseTo(x, d); expect(p.y).toBeCloseTo(y, d);
};

test("image exposes 4 corners + centre as keyed derived points (rotation-aware)", () => {
  const img = new RasterImageEntity("img", { x: 10, y: 20 }, 40, 20, 0);
  near(img.getPoint("c0"), 10, 20);
  near(img.getPoint("c1"), 50, 20);
  near(img.getPoint("c2"), 50, 40);
  near(img.getPoint("c3"), 10, 40);
  near(img.getPoint("center"), 30, 30);

  // Rotated 90° CCW about the anchor: local +x → world +y.
  const rot = new RasterImageEntity("img", { x: 0, y: 0 }, 40, 20, Math.PI / 2);
  near(rot.getPoint("c1"), 0, 40);   // (40,0) local → (0,40) world
  near(rot.getPoint("center"), -10, 20);

  // All five are pickable + snappable with their keys.
  expect(img.pickablePoints().map((p) => p.key).sort()).toEqual(["c0", "c1", "c2", "c3", "center"]);
  expect(img.snapPoints().map((s) => s.key).sort()).toEqual(["c0", "c1", "c2", "c3", "center"]);
});

test("coincident image corner ↔ circle centre translates the image onto it", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  const img = doc.add(new RasterImageEntity("img", { x: 10, y: 10 }, 40, 20, 0));
  const circ = doc.add(new CircleEntity({ x: 120, y: 90 }, 5));
  doc.addConstraint(makeConstraint("fixedPoint", { points: [{ entityId: circ.id, key: "c" }], params: [120, 90] }));
  doc.addConstraint(makeConstraint("coincident", { points: [{ entityId: img.id, key: "c0" }, { entityId: circ.id, key: "c" }] }));

  const r = solve(doc);
  expect(r.converged).toBe(true);
  near(img.getPoint("c0"), 120, 90);          // corner landed on the hole
  expect(img.widthMM).toBeCloseTo(40, 3);     // pure translation — size/rotation unchanged
  expect(img.heightMM).toBeCloseTo(20, 3);
  expect(img.angle).toBeCloseTo(0, 3);
});

test("coincident image centre ↔ circle centre centres the image on the hole", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  const img = doc.add(new RasterImageEntity("img", { x: 0, y: 0 }, 40, 20, 0));
  const circ = doc.add(new CircleEntity({ x: 100, y: 100 }, 5));
  doc.addConstraint(makeConstraint("fixedPoint", { points: [{ entityId: circ.id, key: "c" }], params: [100, 100] }));
  doc.addConstraint(makeConstraint("coincident", { points: [{ entityId: img.id, key: "center" }, { entityId: circ.id, key: "c" }] }));

  expect(solve(doc).converged).toBe(true);
  near(img.getPoint("center"), 100, 100);
  near(img.getPoint("c0"), 80, 90);           // anchor = centre − (w/2,h/2)
});

test("an unbound image is rigid under constraints — a corner constraint moves the whole image, size/angle preserved", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  const img = doc.add(new RasterImageEntity("img", { x: 10, y: 10 }, 20, 20, 0)); // c0=(10,10) c2=(30,30)
  // Pin c0 and c2 CONSISTENTLY with the current size (a pure +40,+40 translation).
  doc.addConstraint(makeConstraint("fixedPoint", { points: [{ entityId: img.id, key: "c0" }], params: [50, 50] }));
  doc.addConstraint(makeConstraint("fixedPoint", { points: [{ entityId: img.id, key: "c2" }], params: [70, 70] }));

  const r = solve(doc);
  expect(r.converged).toBe(true);
  near(img.getPoint("c0"), 50, 50);
  near(img.getPoint("c2"), 70, 70);
  expect(img.widthMM).toBeCloseTo(20, 3);  // rigid — size unchanged
  expect(img.heightMM).toBeCloseTo(20, 3);
  expect(img.angle).toBeCloseTo(0, 3);     // and un-rotated
});

test("moving the constraint target reflows the constrained image", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  const img = doc.add(new RasterImageEntity("img", { x: 0, y: 0 }, 30, 20, 0));
  const circ = doc.add(new CircleEntity({ x: 50, y: 50 }, 5));
  const fixC = makeConstraint("fixedPoint", { points: [{ entityId: circ.id, key: "c" }], params: [50, 50] });
  doc.addConstraint(fixC);
  doc.addConstraint(makeConstraint("coincident", { points: [{ entityId: img.id, key: "c2" }, { entityId: circ.id, key: "c" }] }));
  solve(doc);
  near(img.getPoint("c2"), 50, 50);

  // Move the hole; the image's constrained corner follows on the next solve.
  fixC.params = [80, 70];
  (circ as CircleEntity).center = { x: 80, y: 70 };
  expect(solve(doc).converged).toBe(true);
  near(img.getPoint("c2"), 80, 70);
});

test("an image-corner constraint round-trips through save/load and still solves", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  const img = doc.add(new RasterImageEntity("img", { x: 0, y: 0 }, 30, 20, 0));
  const circ = doc.add(new CircleEntity({ x: 60, y: 40 }, 5));
  doc.addConstraint(makeConstraint("fixedPoint", { points: [{ entityId: circ.id, key: "c" }], params: [60, 40] }));
  doc.addConstraint(makeConstraint("coincident", { points: [{ entityId: img.id, key: "c0" }, { entityId: circ.id, key: "c" }] }));

  const doc2 = new CADDocument({ width: 1, height: 1 });
  applyFile(doc2, serializeDoc(doc, "ic"));
  expect(doc2.constraints.some((c) => c.type === "coincident" && c.points.some((p) => p.key === "c0"))).toBe(true);
  expect(solve(doc2).converged).toBe(true);
  const img2 = doc2.entities.find((e) => e.type === "image")!;
  near(img2.getPoint("c0"), 60, 40);
});
