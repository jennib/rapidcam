import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { ArcEntity, PolylineEntity } from "../src/model/entities";
import { Sketch } from "../src/generators/sketch";
import { boxJoint } from "../src/generators/boxJoint";
import { GENERATORS, runGenerator } from "../src/generators/index";

test("Sketch takes angles in degrees and converts to internal radians", () => {
  const s = new Sketch();
  const h = s.arc({ x: 0, y: 0 }, 10, 0, 90);
  const arc = h.entity as ArcEntity;
  expect(arc.startAngle).toBeCloseTo(0);
  expect(arc.endAngle).toBeCloseTo(Math.PI / 2);
  // Handle exposes normalized start/end points regardless of the field names.
  expect(h.start.x).toBeCloseTo(10);
  expect(h.end.y).toBeCloseTo(10);
});

test("Sketch.param honours host overrides and clamps to the declared range", () => {
  const s = new Sketch({ params: { fingers: 999 } });
  expect(s.param("fingers", 6, { max: 12 })).toBe(12); // override, clamped
  expect(s.param("width", 120, { min: 1 })).toBe(120); // default
  expect(s.params.map((p) => p.name)).toEqual(["fingers", "width"]);
});

test("Sketch.textToPath without a flattener throws a clear error", () => {
  const s = new Sketch();
  expect(() => s.textToPath("hi", { font: "x", size: 5, at: { x: 0, y: 0 } })).toThrow(/flatten/);
});

test("box joint emits one closed outline with the right comb geometry", () => {
  const s = new Sketch({ params: { width: 120, height: 50, thickness: 6, fingers: 6 } });
  const [h] = boxJoint.build(s);
  const poly = h.entity as PolylineEntity;

  expect(poly).toBeInstanceOf(PolylineEntity);
  expect(poly.closed).toBe(true);

  // Panel spans the full width and no finger pokes above the top edge; slots cut
  // down by exactly the material thickness.
  const b = poly.bounds();
  expect(b.min).toEqual({ x: 0, y: 0 });
  expect(b.max.x).toBeCloseTo(120);
  expect(b.max.y).toBeCloseTo(50); // tabs flush with top
  const minTopY = Math.min(...poly.points.filter((p) => p.y > 0).map((p) => p.y));
  expect(minTopY).toBeCloseTo(44); // 50 - 6 thickness at slot bottoms

  // 6 fingers → 6 horizontal runs of 2 points each on the top profile.
  expect(poly.points.filter((p) => p.y >= 44).length).toBe(12);
});

test("runGenerator commits geometry as a single grouped feature", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  const before = doc.entities.length;
  const res = runGenerator(doc, GENERATORS["box-joint"], { fingers: 4 });

  expect(doc.entities.length).toBe(before + 1);
  expect(doc.groups).toContain(res.group);
  expect(res.group.name).toBe("Box Joint Panel");
  expect(res.group.entityIds).toEqual([res.handles[0].id]);
  // The sketch's params are available for a host to build an editor / re-run.
  expect(res.sketch.params.find((p) => p.name === "fingers")?.value).toBe(4);
});
