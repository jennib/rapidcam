import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { ArcEntity, CircleEntity, PolylineEntity } from "../src/model/entities";
import { Sketch } from "../src/generators/sketch";
import { boxJoint } from "../src/generators/boxJoint";
import { gear } from "../src/generators/gear";
import { box } from "../src/generators/box";
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

test("spur gear emits an involute body + bore with correct pitch/tip/root radii", () => {
  const s = new Sketch({ params: { teeth: 20, module: 2, pressureAngle: 20, bore: 6 } });
  const [body, boreH] = gear.build(s);
  const poly = body.entity as PolylineEntity;
  expect(poly.closed).toBe(true);

  const radii = poly.points.map((p) => Math.hypot(p.x, p.y));
  expect(Math.max(...radii)).toBeCloseTo(22, 1); // addendum: rp+m = 20+2
  expect(Math.min(...radii)).toBeCloseTo(17.5, 1); // dedendum: rp-1.25m = 20-2.5

  // Tip-land points recur exactly once per tooth (rotational periodicity).
  const tipPts = radii.filter((r) => Math.abs(r - 22) < 1e-6).length;
  expect(tipPts).toBe(20 * 5);

  const bore = boreH.entity as CircleEntity;
  expect(bore.type).toBe("circle");
  expect(bore.radius).toBeCloseTo(3);
  expect(bore.center).toEqual({ x: 0, y: 0 });
});

test("runGenerator centres a multi-entity feature (gear body + bore) together", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  const res = runGenerator(doc, GENERATORS["spur-gear"], { teeth: 12, module: 2, bore: 6 });
  expect(res.handles.length).toBe(2);
  // Gear is symmetric about its origin, so its centre lands on the work centre,
  // and the bore stays concentric with the body.
  const bore = res.handles[1].entity as CircleEntity;
  expect(bore.center.x).toBeCloseTo(100);
  expect(bore.center.y).toBeCloseTo(100);
});

test("drawer-style box emits 4 walls + bottom + 4 grooves, correctly sized", () => {
  const t = 6;
  const s = new Sketch({
    params: { length: 100, width: 60, height: 40, thickness: t, fingerWidth: 12 },
  });
  const parts = box.build(s);
  expect(parts).toHaveLength(9); // 4 walls, bottom, 4 grooves
  for (const h of parts) {
    const p = h.entity as PolylineEntity;
    expect(p).toBeInstanceOf(PolylineEntity);
    expect(p.closed).toBe(true);
  }

  const size = (h: (typeof parts)[number]) => {
    const b = h.entity.bounds();
    return { w: b.max.x - b.min.x, h: b.max.y - b.min.y };
  };
  // Corner combs recede inward, so a wall's box stays its exact face size.
  const front = size(parts[0]);
  expect(front.w).toBeCloseTo(100, 3); // length
  expect(front.h).toBeCloseTo(40, 3); // height
  // Bottom is a plain panel sized to enter the grooves: (length−t)×(width−t).
  const bottom = size(parts[4]);
  expect(bottom.w).toBeCloseTo(94, 3);
  expect(bottom.h).toBeCloseTo(54, 3);
  // A groove is a channel inset t from the corners: (faceW−2t) × t.
  const frontGroove = size(parts[5]);
  expect(frontGroove.w).toBeCloseTo(100 - 2 * t, 3); // 88
  expect(frontGroove.h).toBeCloseTo(t, 3); // 6
});

test("box grooves commit onto a separate 'Groove pockets' layer", () => {
  const doc = new CADDocument({ width: 400, height: 400 });
  const res = runGenerator(doc, GENERATORS["finger-box"], {});
  const layer = doc.layers.find((l) => l.name === "Groove pockets");
  expect(layer).toBeDefined();

  const ents = res.group.entityIds.map((id) => doc.entities.find((e) => e.id === id)!);
  // First 5 (walls + bottom) are NOT on the groove layer; the last 4 (grooves) are.
  expect(ents.slice(0, 5).every((e) => e.layerId !== layer!.id)).toBe(true);
  expect(ents.slice(5).every((e) => e.layerId === layer!.id)).toBe(true);
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
