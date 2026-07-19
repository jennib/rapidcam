import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { ArcEntity, CircleEntity, PolylineEntity } from "../src/model/entities";
import { makeConstraint } from "../src/model/constraints";
import { type CAMOperation, DEFAULTS } from "../src/cam/types";
import { Sketch, type ParamSpec, type Pt } from "../src/generators/sketch";
import { boxJoint } from "../src/generators/boxJoint";
import { gear } from "../src/generators/gear";
import { box, comb, type CombSpec } from "../src/generators/box";
import {
  GENERATORS,
  type Generator,
  centreOffset,
  findFeatureForEntities,
  nudgeOffset,
  regenerateFeature,
  runGenerator,
} from "../src/generators/index";
import { applyFile, serializeDoc } from "../src/io/fileio";
import { dialogWarnings } from "../src/ui/generatorDialog";

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

// --- s.key() stable identity ------------------------------------------------

test("keyed entities keep their ids when the emit order changes", () => {
  const testGen: Generator = {
    id: "test-key-gen",
    name: "Test Key Gen",
    build(s) {
      const swap = s.param("swap", 0, {});
      const emitA = () => {
        s.key("a");
        return s.circle({ x: 0, y: 0 }, 5);
      };
      const emitB = () => {
        s.key("b");
        return s.circle({ x: 20, y: 0 }, 3);
      };
      return swap ? [emitB(), emitA()] : [emitA(), emitB()];
    },
  };
  GENERATORS[testGen.id] = testGen;
  try {
    const doc = new CADDocument({ width: 200, height: 200 });
    const res = runGenerator(doc, testGen, {});
    const aId = res.feature.keyIds!["a"];
    const bId = res.feature.keyIds!["b"];

    regenerateFeature(doc, res.feature.id, { swap: 1 });
    // Ids follow the KEY, not the emit position — radius identifies which
    // logical entity each id points at.
    expect(res.feature.keyIds!["a"]).toBe(aId);
    expect(res.feature.keyIds!["b"]).toBe(bId);
    const a = doc.entities.find((e) => e.id === aId) as CircleEntity;
    expect(a.radius).toBe(5);
  } finally {
    delete GENERATORS[testGen.id];
  }
});

test("after a partial delete, ops on other keyed entities stay attached", () => {
  const doc = new CADDocument({ width: 500, height: 500 });
  const res = runGenerator(doc, GENERATORS["finger-box"], {});
  const leftWallId = res.feature.keyIds!["left-wall"];
  const rightWallId = res.feature.keyIds!["right-wall"];
  doc.operations.push(minimalOp([rightWallId]));

  doc.remove(leftWallId);
  expect(res.feature.keyIds!["left-wall"]).toBeUndefined(); // pruned with the entity

  regenerateFeature(doc, res.feature.id, { height: 45 });
  // The right wall kept its id via its key (index matching would have shifted
  // every wall after the deleted one by a position)…
  expect(res.feature.keyIds!["right-wall"]).toBe(rightWallId);
  expect(doc.operations.at(-1)!.entityIds).toEqual([rightWallId]);
  // …and the deleted wall came back as a NEW entity; the group is whole again.
  const newLeft = res.feature.keyIds!["left-wall"];
  expect(newLeft).toBeDefined();
  expect(newLeft).not.toBe(leftWallId);
  expect(doc.groups[0].entityIds).toHaveLength(9);
});

test("keyIds persist through serialize → applyFile and don't alias snapshots", () => {
  const doc = new CADDocument({ width: 500, height: 500 });
  const res = runGenerator(doc, GENERATORS["finger-box"], {});
  expect(Object.keys(res.feature.keyIds!)).toHaveLength(9);

  const file = serializeDoc(doc, "box");
  const reloaded = new CADDocument({ width: 500, height: 500 });
  applyFile(reloaded, file);
  expect(reloaded.features[0].keyIds).toEqual(res.feature.keyIds);

  const snap = doc.snapshot();
  const orig = res.feature.keyIds!["bottom"];
  res.feature.keyIds!["bottom"] = "mutated";
  doc.restore(snap);
  expect(doc.features[0].keyIds!["bottom"]).toBe(orig);
});

test("sketch keys: duplicates and unconsumed keys throw at build time", () => {
  const s = new Sketch();
  s.key("x");
  s.circle({ x: 0, y: 0 }, 1);
  expect(() => s.key("x")).toThrow(/duplicate/);
  s.key("y");
  expect(() => s.key("z")).toThrow(/never consumed/);
});

test("clearance note appears only when clearance > 0", () => {
  const s0 = new Sketch();
  boxJoint.build(s0);
  expect(s0.notes.some((n) => n.includes("mating face"))).toBe(false);
  const s1 = new Sketch({ params: { clearance: 1 } });
  boxJoint.build(s1);
  expect(s1.notes.some((n) => n.includes("mating face"))).toBe(true);
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

// --- M6: mating-edge self-verification (box corner comb complementarity) ---

/** Reconstruct horizontal runs from a comb()'s raw point list: a run is a
 *  maximal horizontal advance (same y, x changes); risers (same x, y changes)
 *  and the degenerate duplicate points comb() emits at its pinned ends (when
 *  insetStart/insetEnd are 0) collapse to nothing under this walk. */
function runsOf(pts: Pt[]): { x0: number; x1: number; y: number }[] {
  const runs: { x0: number; x1: number; y: number }[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (a.y === b.y && a.x !== b.x) runs.push({ x0: a.x, x1: b.x, y: a.y });
  }
  return runs;
}

test("comb: front/back vs. side corner phases stay complementary across a height×fingerWidth×clearance grid", () => {
  const t = 6;
  for (const height of [40, 50, 63.7]) {
    for (const fingerW of [5, 8, 12]) {
      for (const clearance of [0, 0.2, 0.4]) {
        const base: Omit<CombSpec, "firstActive"> = {
          fingerW,
          depth: t,
          protrude: false,
          insetStart: 0,
          insetEnd: 0,
          clearance,
        };
        const runsFB = runsOf(comb(height, { ...base, firstActive: false }));
        const runsSide = runsOf(comb(height, { ...base, firstActive: true }));

        // (a) same run count on both edges, matching comb()'s own finger count.
        const n = Math.max(2, Math.round(height / fingerW));
        expect(runsFB).toHaveLength(n);
        expect(runsSide).toHaveLength(n);

        // (b) complementary pattern: wherever FB is active, Side is inactive.
        for (let i = 0; i < n; i++) {
          expect(runsFB[i].y === -t).toBe(!(runsSide[i].y === -t));
        }

        // (d) active runs sit at exactly y = -t (notches recede, don't protrude);
        // ends are pinned to the full span.
        for (const r of [...runsFB, ...runsSide]) expect(r.y === 0 || r.y === -t).toBe(true);
        expect(runsFB[0].x0).toBeCloseTo(0, 9);
        expect(runsFB[n - 1].x1).toBeCloseTo(height, 9);
        expect(runsSide[0].x0).toBeCloseTo(0, 9);
        expect(runsSide[n - 1].x1).toBeCloseTo(height, 9);

        // (c) every interior boundary is exactly `clearance` wider on one side
        // than the other, alternating by parity — each notch is clearance/2
        // wider per mating face than its counterpart's tab. Boundaries are read
        // off the shared run edges (run k-1's x1 === run k's x0).
        for (let k = 1; k < n; k++) {
          expect(runsFB[k].x0).toBeCloseTo(runsFB[k - 1].x1, 9); // contiguous, no gap
          expect(runsSide[k].x0).toBeCloseTo(runsSide[k - 1].x1, 9);
          const fbBoundary = runsFB[k - 1].x1;
          const sideBoundary = runsSide[k - 1].x1;
          const expectedDelta = k % 2 === 0 ? clearance : -clearance;
          expect(fbBoundary - sideBoundary).toBeCloseTo(expectedDelta, 9);
        }
      }
    }
  }
});

test("finger-box: front-wall and left-wall have equal vertex counts (complementary combs; catches phase regressions)", () => {
  const doc = new CADDocument({ width: 400, height: 400 });
  const res = runGenerator(doc, GENERATORS["finger-box"], {});
  const frontId = res.feature.keyIds!["front-wall"];
  const leftId = res.feature.keyIds!["left-wall"];
  const front = doc.entities.find((e) => e.id === frontId) as PolylineEntity;
  const left = doc.entities.find((e) => e.id === leftId) as PolylineEntity;
  expect(front.points.length).toBe(left.points.length);
});

// --- M2/M5: dialogWarnings (thickness-vs-stock, laser kerf × clearance) ----

function spec(name: string, value: number): ParamSpec {
  return { name, value, def: value };
}

test("dialogWarnings: thickness param mismatched with stock thickness warns", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  doc.stockThickness = 10;
  const warnings = dialogWarnings([spec("thickness", 6)], { thickness: 6 }, doc);
  expect(warnings.some((w) => w.includes("≠ stock thickness"))).toBe(true);
});

test("dialogWarnings: thickness matching stock (within 1e-3 float dust) warns not at all", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  doc.stockThickness = 6;
  const warnings = dialogWarnings([spec("thickness", 6.0005)], { thickness: 6.0005 }, doc);
  expect(warnings).toHaveLength(0);
});

test("dialogWarnings: a generator with no thickness param (gear) never warns about stock", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  doc.stockThickness = 10;
  const specs = [spec("teeth", 20), spec("module", 2), spec("bore", 6)];
  const params = { teeth: 20, module: 2, bore: 6 };
  expect(dialogWarnings(specs, params, doc)).toHaveLength(0);
});

test("dialogWarnings: laser + clearance 0 recommends kerf compensation", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  doc.machineKind = "laser";
  const warnings = dialogWarnings([spec("clearance", 0)], { clearance: 0 }, doc);
  expect(warnings.some((w) => /kerf compensation/.test(w))).toBe(true);
});

test("dialogWarnings: laser + clearance > 0 warns clearance stacks with kerf", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  doc.machineKind = "laser";
  const warnings = dialogWarnings([spec("clearance", 0.2)], { clearance: 0.2 }, doc);
  expect(warnings.some((w) => /clearance adds to it/.test(w))).toBe(true);
});

test("dialogWarnings: mill + clearance never triggers the laser kerf warning", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  doc.machineKind = "mill";
  const warnings = dialogWarnings([spec("clearance", 0.2)], { clearance: 0.2 }, doc);
  expect(warnings).toHaveLength(0);
});

// --- P4: nudgeOffset — repeated inserts used to stack dead-centre ----------

/** Combined bbox of the live entities behind `ids` (mirrors nudgeOffset's own
 *  per-group bbox math, but against the doc directly for test assertions). */
function boundsOfIds(doc: CADDocument, ids: readonly string[]) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const id of ids) {
    const e = doc.entities.find((e) => e.id === id);
    if (!e) continue;
    const b = e.bounds();
    minX = Math.min(minX, b.min.x);
    minY = Math.min(minY, b.min.y);
    maxX = Math.max(maxX, b.max.x);
    maxY = Math.max(maxY, b.max.y);
  }
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

test("nudgeOffset jumps past a blocking feature in one step", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  // Manually plant one "existing feature": a circle bbox [0,0]-[50,50], grouped
  // and linked from a feature, exactly as runGenerator would record it.
  const existing = new CircleEntity({ x: 25, y: 25 }, 25);
  doc.add(existing);
  const group = { id: "g1", name: "Existing", entityIds: [existing.id] };
  doc.groups.push(group);
  doc.features.push({ id: "f1", generatorId: "x", params: {}, groupId: group.id });

  const bounds = { min: { x: 0, y: 0 }, max: { x: 50, y: 50 } };
  const start = { x: 0, y: 0 }; // candidate lands exactly on the existing feature
  const nudged = nudgeOffset(doc, bounds, start);
  // One jump to just past the blocker's right edge (50) + the 10mm margin —
  // a fixed small step would need several tries and exhaust on big blockers.
  expect(nudged).toEqual({ x: 60, y: 0 });
});

test("nudgeOffset places a small part beside a large centred one (row-wrap layout)", () => {
  // The live-repro case the fixed-step walk failed: a big box at centre, then
  // small gears — each must land in free space, not pile at an exhausted offset.
  const doc = new CADDocument({ width: 800, height: 800 });
  runGenerator(doc, GENERATORS["finger-box"], {});
  const g1 = runGenerator(doc, GENERATORS["spur-gear"], { teeth: 12, module: 2, bore: 0 });
  const g2 = runGenerator(doc, GENERATORS["spur-gear"], { teeth: 12, module: 2, bore: 0 });

  const boxes = doc.features.map((f) =>
    boundsOfIds(doc, doc.groups.find((g) => g.id === f.groupId)!.entityIds),
  );
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const overlap =
        a.min.x < b.max.x && a.max.x > b.min.x && a.min.y < b.max.y && a.max.y > b.min.y;
      expect(overlap).toBe(false);
    }
  }
  expect(g1.feature.offset).not.toEqual(g2.feature.offset);
});

test("nudgeOffset returns unshifted when nothing exists to collide with", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const start = { x: 42, y: 7 };
  const nudged = nudgeOffset(doc, { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } }, start);
  expect(nudged).toEqual(start);
});

test("two identical box inserts: the second feature's group bbox does not overlap the first's", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const gen = GENERATORS["finger-box"];
  // Small dimensions: the box net's combined bbox (walls stacked in a column
  // plus the bottom off to the side, see box.ts) must fit within 8 shifts of
  // 15 mm each — the default 100×60×40 net is wide enough that even 8 shifts
  // can't clear it, which isn't what this test is after (it's covered
  // separately by the "bounded" exhaustion test below).
  const params = { length: 15, width: 15, height: 15, thickness: 1, fingerWidth: 2 };
  const first = runGenerator(doc, gen, params);
  const second = runGenerator(doc, gen, params);

  const b1 = boundsOfIds(doc, first.group.entityIds);
  const b2 = boundsOfIds(doc, second.group.entityIds);
  const overlap = b1.min.x < b2.max.x && b1.max.x > b2.min.x && b1.min.y < b2.max.y && b1.max.y > b2.min.y;
  expect(overlap).toBe(false);
});

test("nudgeOffset stacks at centre when the work area has no free room", () => {
  // A default box net nearly fills a 300×300 work area: no jump or row-wrap
  // can clear it, so every later insert stacks visibly at the centred start
  // instead of wandering off the stock.
  const doc = new CADDocument({ width: 300, height: 300 });
  const gen = GENERATORS["finger-box"];

  // centreOffset only depends on the incoming geometry's bounds and the doc's
  // canvas size, not on what's already on the document, so this probe gives
  // the same "start" every one of the runs below would independently compute.
  const probe = new Sketch({ params: {} });
  gen.build(probe);
  const start = centreOffset(doc, probe.entities);

  for (let i = 0; i < 12; i++) {
    const res = runGenerator(doc, gen, {});
    const off = res.feature.offset!;
    expect(off.x).toBeCloseTo(start.x, 9);
    expect(off.y).toBeCloseTo(start.y, 9);
  }
});

test("regenerateFeature preserves a nudged insert's offset exactly (footprint stays put)", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const gen = GENERATORS["finger-box"];
  const params = { length: 15, width: 15, height: 15, thickness: 1, fingerWidth: 2 };
  const first = runGenerator(doc, gen, params);
  const second = runGenerator(doc, gen, params); // overlaps the first's footprint → gets nudged
  expect(second.feature.offset).not.toEqual(first.feature.offset);

  const before = boundsOfIds(doc, second.group.entityIds);
  const again = regenerateFeature(doc, second.feature.id, { thickness: 5 });
  const after = boundsOfIds(doc, again!.group.entityIds);
  expect(after.min.x).toBeCloseTo(before.min.x, 6);
  expect(after.min.y).toBeCloseTo(before.min.y, 6);
  expect(again!.feature.offset).toEqual(second.feature.offset);
});
