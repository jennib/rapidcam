import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity, PolylineEntity } from "../src/model/entities";
import { makeConstraint, segmentRef, lineRefEntityId, constraintEntityIds } from "../src/model/constraints";
import { solve } from "../src/solver/solver";
import { sub, cross, dot, normalize, len } from "../src/core/vec2";

const dir = (a: { x: number; y: number }, b: { x: number; y: number }) => normalize(sub(b, a));

test("segmentRef / lineRefEntityId round-trip", () => {
  const r = segmentRef("poly-7", 2);
  expect(r).toBe("poly-7#2");
  expect(lineRefEntityId(r)).toBe("poly-7");
  expect(lineRefEntityId("line-3")).toBe("line-3");
});

test("constraintEntityIds strips the segment suffix (so delete-prune works)", () => {
  const c = makeConstraint("parallel", { entities: [segmentRef("poly-1", 0), "line-2"] });
  expect(constraintEntityIds(c).sort()).toEqual(["line-2", "poly-1"]);
});

test("horizontal constraint on a polyline segment levels that segment", () => {
  const doc = new CADDocument({ width: 300, height: 200 });
  const poly = doc.add(new PolylineEntity([{ x: 0, y: 0 }, { x: 100, y: 37 }, { x: 150, y: 80 }], false)) as PolylineEntity;
  doc.addConstraint(makeConstraint("horizontal", { entities: [segmentRef(poly.id, 0)] }));
  const r = solve(doc);
  expect(r.converged).toBe(true);
  expect(Math.abs(poly.points[0].y - poly.points[1].y)).toBeLessThan(1e-4);
});

test("parallel constraint makes a polyline segment parallel to a line", () => {
  const doc = new CADDocument({ width: 300, height: 200 });
  const poly = doc.add(new PolylineEntity([{ x: 0, y: 0 }, { x: 100, y: 5 }, { x: 120, y: 60 }], false)) as PolylineEntity;
  const line = doc.add(new LineEntity({ x: 0, y: 100 }, { x: 50, y: 130 })) as LineEntity;
  doc.addConstraint(makeConstraint("parallel", { entities: [segmentRef(poly.id, 0), line.id] }));
  const r = solve(doc);
  expect(r.converged).toBe(true);
  const seg = dir(poly.points[0], poly.points[1]);
  expect(Math.abs(cross(seg, dir(line.a, line.b)))).toBeLessThan(1e-3);
});

test("perpendicular constraint between two polyline segments", () => {
  const doc = new CADDocument({ width: 300, height: 200 });
  const poly = doc.add(new PolylineEntity([{ x: 0, y: 0 }, { x: 100, y: 10 }, { x: 90, y: 70 }], false)) as PolylineEntity;
  doc.addConstraint(makeConstraint("perpendicular", { entities: [segmentRef(poly.id, 0), segmentRef(poly.id, 1)] }));
  const r = solve(doc);
  expect(r.converged).toBe(true);
  const s0 = dir(poly.points[0], poly.points[1]);
  const s1 = dir(poly.points[1], poly.points[2]);
  expect(Math.abs(dot(s0, s1))).toBeLessThan(1e-3);
});

test("equal-length constraint matches a polyline segment to a line", () => {
  const doc = new CADDocument({ width: 300, height: 200 });
  const poly = doc.add(new PolylineEntity([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 60 }], false)) as PolylineEntity;
  const line = doc.add(new LineEntity({ x: 0, y: 100 }, { x: 100, y: 100 })) as LineEntity; // length 100
  doc.addConstraint(makeConstraint("equal", { entities: [segmentRef(poly.id, 0), line.id] }));
  const r = solve(doc);
  expect(r.converged).toBe(true);
  const segLen = len(sub(poly.points[1], poly.points[0]));
  const lineLen = len(sub(line.b, line.a));
  expect(Math.abs(segLen - lineLen)).toBeLessThan(1e-2);
});

test("closed polyline: last segment wraps to the first vertex", () => {
  const doc = new CADDocument({ width: 300, height: 200 });
  const poly = doc.add(new PolylineEntity([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }], true)) as PolylineEntity;
  // segment index 2 wraps v2 -> v0; make it vertical
  doc.addConstraint(makeConstraint("vertical", { entities: [segmentRef(poly.id, 2)] }));
  const r = solve(doc);
  expect(r.converged).toBe(true);
  expect(Math.abs(poly.points[2].x - poly.points[0].x)).toBeLessThan(1e-4);
});
