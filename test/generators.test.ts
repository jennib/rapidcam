import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { ArcEntity, CircleEntity, PolylineEntity } from "../src/model/entities";
import { makeConstraint } from "../src/model/constraints";
import { type CAMOperation, DEFAULTS } from "../src/cam/types";
import { Sketch } from "../src/generators/sketch";
import { boxJoint } from "../src/generators/boxJoint";
import { gear } from "../src/generators/gear";
import { box } from "../src/generators/box";
import {
  GENERATORS,
  type Generator,
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

  // Same feature + group records, fresh geometry UNDER THE SAME ID (id-stable
  // regeneration: references to generated geometry survive a param edit).
  expect(again!.feature.id).toBe(first.feature.id);
  expect(again!.group.id).toBe(first.group.id);
  expect(doc.features.length).toBe(1);
  expect(doc.groups.length).toBe(1);
  expect(doc.entities.some((e) => e.id === firstEntityId)).toBe(true);
  expect(again!.group.entityIds).toEqual([firstEntityId]);
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

// --- id-stable regeneration (WP1) ------------------------------------------

/** Minimal valid mill profile op targeting `entityIds` (DEFAULTS for the rest). */
function minimalOp(entityIds: string[]): CAMOperation {
  return {
    ...DEFAULTS,
    id: "cam-test-1",
    name: "Test profile",
    type: "profile",
    entityIds,
    side: "outside",
  };
}

test("regenerateFeature keeps every entity id stable across a param edit", () => {
  const doc = new CADDocument({ width: 400, height: 400 });
  const first = runGenerator(doc, GENERATORS["finger-box"], {});
  const idsBefore = [...first.group.entityIds];
  expect(idsBefore).toHaveLength(9);

  const again = regenerateFeature(doc, first.feature.id, { thickness: 5, fingerWidth: 10 });
  expect(again!.group.entityIds).toEqual(idsBefore);
  // The live entities really carry those ids, not just the group record.
  for (const id of idsBefore) expect(doc.entities.some((e) => e.id === id)).toBe(true);
});

test("a CAM op on generated geometry survives a regeneration", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const res = runGenerator(doc, GENERATORS["box-joint"], { fingers: 4 });
  const panelId = res.group.entityIds[0];
  doc.operations.push(minimalOp([panelId]));

  regenerateFeature(doc, res.feature.id, { fingers: 8 });
  expect(doc.operations[0].entityIds).toEqual([panelId]);
  // The surviving id resolves to the REBUILT geometry (8 fingers → 16 points
  // on the combed top, i.e. within `thickness` of the panel's top edge).
  const panel = doc.entities.find((e) => e.id === panelId) as PolylineEntity;
  const top = panel.bounds().max.y;
  expect(panel.points.filter((p) => p.y >= top - 6 - 1e-9).length).toBe(16);
});

test("a constraint on generated geometry survives a regeneration", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const res = runGenerator(doc, GENERATORS["box-joint"], { fingers: 4 });
  doc.addConstraint(makeConstraint("fixed", { entities: [res.group.entityIds[0]] }));

  regenerateFeature(doc, res.feature.id, { fingers: 6 });
  expect(doc.constraints).toHaveLength(1);
});

test("gear bore growth/shrink reconciles entities and keeps the body id", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  const res = runGenerator(doc, GENERATORS["spur-gear"], { teeth: 12, module: 2, bore: 0 });
  expect(res.group.entityIds).toHaveLength(1);
  const bodyId = res.group.entityIds[0];
  doc.operations.push(minimalOp([bodyId]));

  // Grow: the bore appears as a new entity; the body keeps its id.
  const grown = regenerateFeature(doc, res.feature.id, { bore: 6 });
  expect(grown!.group.entityIds).toHaveLength(2);
  expect(grown!.group.entityIds[0]).toBe(bodyId);
  const boreId = grown!.group.entityIds[1];

  // Shrink: the bore goes away; the body id and its op survive.
  const shrunk = regenerateFeature(doc, res.feature.id, { bore: 0 });
  expect(shrunk!.group.entityIds).toEqual([bodyId]);
  expect(doc.entities.some((e) => e.id === boreId)).toBe(false);
  expect(doc.operations[0].entityIds).toEqual([bodyId]);
});

test("deleting all of a feature's entities drops the group and the feature", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const res = runGenerator(doc, GENERATORS["box-joint"], {});
  doc.batchRemove(res.group.entityIds);
  expect(doc.groups).toHaveLength(0);
  expect(doc.features).toHaveLength(0);
});

test("deleting part of a feature trims the group membership in place", () => {
  const doc = new CADDocument({ width: 400, height: 400 });
  const res = runGenerator(doc, GENERATORS["finger-box"], {});
  const victim = res.group.entityIds[3];
  doc.remove(victim);
  // Same GroupDef object (held references stay live), trimmed membership.
  expect(res.group.entityIds).toHaveLength(8);
  expect(res.group.entityIds).not.toContain(victim);
  expect(doc.features).toHaveLength(1);
});

test("generator-declared variables are not duplicated across regenerations", () => {
  const testGen: Generator = {
    id: "test-var-gen",
    name: "Test Var Gen",
    build(s) {
      const r = s.param("r", 5, { min: 1 });
      s.variable("testR", "5");
      return [s.circle({ x: 0, y: 0 }, r)];
    },
  };
  GENERATORS[testGen.id] = testGen;
  try {
    const doc = new CADDocument({ width: 200, height: 200 });
    const res = runGenerator(doc, testGen, {});
    regenerateFeature(doc, res.feature.id, { r: 8 });
    regenerateFeature(doc, res.feature.id, { r: 9 });
    expect(doc.variables.filter((v) => v.name === "testR")).toHaveLength(1);
  } finally {
    delete GENERATORS[testGen.id];
  }
});

test("a pure-survivor regeneration emits exactly one change", () => {
  const doc = new CADDocument({ width: 400, height: 400 });
  const res = runGenerator(doc, GENERATORS["finger-box"], {});
  let emits = 0;
  const off = doc.onChange(() => emits++);
  regenerateFeature(doc, res.feature.id, { thickness: 5 });
  off();
  expect(emits).toBe(1);
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

// --- WP5+WP6: int/step params, notes, joint clearance ----------------------

test("Sketch.param rounds an int param FIRST, then clamps (rounding can exit the range)", () => {
  const s1 = new Sketch({ params: { n: 6.7 } });
  expect(s1.param("n", 5, { int: true })).toBe(7);
  expect(s1.params[0].value).toBe(7);
  expect(s1.params[0].int).toBe(true);

  // 100.4 rounds to 100, which is past max: the clamp must win.
  const s2 = new Sketch({ params: { n: 100.4 } });
  expect(s2.param("n", 5, { max: 12, int: true })).toBe(12);
  expect(s2.params[0].value).toBe(12);
});

test("gear notes an involute undercut warning below ~17 teeth, none at 20", () => {
  const low = new Sketch({ params: { teeth: 12, module: 2, bore: 0 } });
  gear.build(low);
  expect(low.notes.some((n) => /undercut/i.test(n))).toBe(true);

  const ok = new Sketch({ params: { teeth: 20, module: 2, bore: 0 } });
  gear.build(ok);
  expect(ok.notes.some((n) => /undercut/i.test(n))).toBe(false);
});

test("boxJoint clearance widens every slot and narrows interior tabs by exactly the clearance", () => {
  const width = 100,
    height = 50,
    thickness = 6,
    fingers = 5, // odd, so BOTH slots land strictly interior (edges are always tabs)
    clearance = 1;
  const s = new Sketch({ params: { width, height, thickness, fingers, clearance } });
  const [h] = boxJoint.build(s);
  const poly = h.entity as PolylineEntity;
  const w = width / fingers;

  // Panel footprint is unaffected by clearance — only interior boundaries move.
  const b = poly.bounds();
  expect(b.min).toEqual({ x: 0, y: 0 });
  expect(b.max.x).toBeCloseTo(width);
  expect(b.max.y).toBeCloseTo(height);

  // poly.points = [{0,0}, {width,0}, ...reversed top profile]; undo the reversal
  // to recover the original left→right run order, where run i occupies
  // topProfile[2i] (start) and topProfile[2i+1] (end).
  const topProfile = poly.points.slice(2).slice().reverse();
  for (let i = 0; i < fingers; i++) {
    const a = topProfile[2 * i];
    const bp = topProfile[2 * i + 1];
    const span = Math.abs(bp.x - a.x);
    const isTab = i % 2 === 0;
    if (isTab) {
      if (i > 0 && i < fingers - 1) expect(span).toBeCloseTo(w - clearance); // interior tab
    } else {
      expect(span).toBeCloseTo(w + clearance); // every slot (all interior here)
    }
  }
});

test("box clearance keeps wall bounds fixed (notches recede inward) but widens the groove/bottom fit", () => {
  const t = 6,
    clearance = 1;
  const s = new Sketch({
    params: { length: 100, width: 60, height: 40, thickness: t, fingerWidth: 12, clearance },
  });
  const parts = box.build(s);
  const size = (h: (typeof parts)[number]) => {
    const b = h.entity.bounds();
    return { w: b.max.x - b.min.x, h: b.max.y - b.min.y };
  };

  const front = size(parts[0]);
  expect(front.w).toBeCloseTo(100, 3); // length, unchanged
  expect(front.h).toBeCloseTo(40, 3); // height, unchanged

  const bottom = size(parts[4]);
  expect(bottom.w).toBeCloseTo(100 - t - clearance, 3);
  expect(bottom.h).toBeCloseTo(60 - t - clearance, 3);

  const frontGroove = size(parts[5]);
  expect(frontGroove.w).toBeCloseTo(100 - 2 * t, 3);
  expect(frontGroove.h).toBeCloseTo(t + clearance, 3);
});

test("clearance = 0 is byte-identical to a build with no clearance override (regression guard)", () => {
  const bjParams = { width: 120, height: 50, thickness: 6, fingers: 6 };
  const bjWith = boxJoint.build(new Sketch({ params: { ...bjParams, clearance: 0 } }));
  const bjWithout = boxJoint.build(new Sketch({ params: bjParams }));
  expect((bjWith[0].entity as PolylineEntity).points).toEqual(
    (bjWithout[0].entity as PolylineEntity).points,
  );

  const boxParams = { length: 100, width: 60, height: 40, thickness: 6, fingerWidth: 12 };
  const boxWith = box.build(new Sketch({ params: { ...boxParams, clearance: 0 } }));
  const boxWithout = box.build(new Sketch({ params: boxParams }));
  expect(boxWith.length).toBe(boxWithout.length);
  for (let i = 0; i < boxWith.length; i++) {
    expect((boxWith[i].entity as PolylineEntity).points).toEqual(
      (boxWithout[i].entity as PolylineEntity).points,
    );
  }
});
