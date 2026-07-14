import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { ArcEntity, PolylineEntity } from "../src/model/entities";
import { Sketch } from "../src/generators/sketch";
import { boxJoint } from "../src/generators/boxJoint";
import {
  GENERATORS,
  findFeatureForEntities,
  regenerateFeature,
  runGenerator,
} from "../src/generators/index";
import { applyFile, serializeDoc } from "../src/io/fileio";

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
  // A re-editable feature was recorded with its full parameter set.
  expect(doc.features).toContain(res.feature);
  expect(res.feature.generatorId).toBe("box-joint");
  expect(res.feature.groupId).toBe(res.group.id);
  expect(res.feature.params.fingers).toBe(4);
});

test("runGenerator centres the part in the work area (not at the WCS origin)", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  const res = runGenerator(doc, GENERATORS["box-joint"], { width: 120, height: 50 });
  const b = res.handles[0].entity.bounds();
  const cx = (b.min.x + b.max.x) / 2;
  const cy = (b.min.y + b.max.y) / 2;
  expect(cx).toBeCloseTo(100); // 200/2
  expect(cy).toBeCloseTo(100);
  expect(res.feature.offset).toBeDefined();
});

test("regenerateFeature keeps the part where it sits (offset preserved)", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  const first = runGenerator(doc, GENERATORS["box-joint"], { width: 120, height: 50, fingers: 4 });
  const before = first.handles[0].entity.bounds();

  const again = regenerateFeature(doc, first.feature.id, { fingers: 10 });
  const after = again!.handles[0].entity.bounds();
  // Same footprint (width/height unchanged) → same placement, not back at origin.
  expect(after.min.x).toBeCloseTo(before.min.x);
  expect(after.min.y).toBeCloseTo(before.min.y);
  expect(again!.feature.offset).toEqual(first.feature.offset);
});

test("regenerateFeature rebuilds geometry in place, keeping feature identity", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const first = runGenerator(doc, GENERATORS["box-joint"], { width: 120, fingers: 4 });
  const firstEntityId = first.group.entityIds[0];

  const again = regenerateFeature(doc, first.feature.id, { fingers: 8 });
  expect(again).not.toBeNull();

  // Same feature + group records, fresh geometry.
  expect(again!.feature.id).toBe(first.feature.id);
  expect(again!.group.id).toBe(first.group.id);
  expect(doc.features.length).toBe(1);
  expect(doc.groups.length).toBe(1);
  expect(doc.entities.some((e) => e.id === firstEntityId)).toBe(false); // old geometry gone
  expect(again!.feature.params.fingers).toBe(8);
  expect(again!.feature.params.width).toBe(120); // untouched param preserved through merge
});

test("findFeatureForEntities maps a selected entity back to its feature", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const res = runGenerator(doc, GENERATORS["box-joint"], { fingers: 4 });
  const memberId = res.group.entityIds[0];

  expect(findFeatureForEntities(doc, [memberId])).toBe(res.feature);
  expect(findFeatureForEntities(doc, ["not-a-real-id"])).toBeNull();
});

test("features survive a serialize → applyFile round-trip", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const res = runGenerator(doc, GENERATORS["box-joint"], { fingers: 5 });

  const file = serializeDoc(doc, "box");
  const reloaded = new CADDocument({ width: 300, height: 300 });
  applyFile(reloaded, file);

  expect(reloaded.features).toHaveLength(1);
  const f = reloaded.features[0];
  expect(f.id).toBe(res.feature.id);
  expect(f.generatorId).toBe("box-joint");
  expect(f.params.fingers).toBe(5);
  expect(f.groupId).toBe(res.group.id);
  // And the feature can be regenerated after reload.
  const regen = regenerateFeature(reloaded, f.id, { fingers: 3 });
  expect(regen!.feature.params.fingers).toBe(3);
});
