/**
 * Per-layer beam recipes: a laser layer carries power/speed/passes, and the
 * operations cutting geometry on that layer take those numbers at toolpath time.
 * The colour-driven workflow — cut on black, score on red — with one place to
 * re-tune after a test cut.
 *
 * This is the laser mirror of `toolId` + `resolveOpTool`, so the rules under
 * test are the same ones: the shared definition wins, the op's inline fields are
 * the fallback, and an op that has forked keeps its own.
 *
 * Every "the layer's numbers replaced the op's" assertion is paired with a
 * positive control on the value that must now be present — a G-code check for
 * the ABSENCE of `S800` also passes when the generator emits nothing at all.
 */

import { test, expect } from "vitest";
import { generateLaserGCode, laserPreviewPaths } from "../src/cam/lasergcode";
import { generateMaterialTest } from "../src/cam/materialTest";
import { opLayerId, resolveOpLaser, type CAMOperation, type LaserRecipe } from "../src/cam/types";
import { CADDocument } from "../src/model/document";
import { LineEntity, RectEntity } from "../src/model/entities";

function laserDoc(): CADDocument {
  const doc = new CADDocument({ width: 200, height: 100 });
  doc.machineKind = "laser";
  doc.origin = { x: "left", y: "front", z: "top" };
  return doc;
}

/** Add a second layer and return its id. */
function addLayer(doc: CADDocument, id: string, laser?: LaserRecipe): string {
  doc.layers.push({ id, name: id, color: "#ff0000", visible: true, locked: false, laser });
  return id;
}

function baseOp(over: Partial<CAMOperation>): CAMOperation {
  return {
    id: "op1",
    name: "cut",
    type: "engrave",
    entityIds: [],
    side: "outside",
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 0,
    feedrate: 1200,
    plungeRate: 300,
    spindleSpeed: 0,
    safeZ: 5,
    depth: -3,
    stepdown: 1.5,
    stepover: 0.4,
    laserPower: 80,
    laserPasses: 1,
    ...over,
  };
}

const RECIPE: LaserRecipe = { feedrate: 300, laserPower: 100, laserPasses: 3 };

// --- resolution rules --------------------------------------------------------

test("an op whose geometry sits on one recipe-bearing layer takes the layer's numbers", () => {
  const doc = laserDoc();
  doc.layers[0].laser = RECIPE;
  doc.entities.push(new LineEntity({ x: 0, y: 0 }, { x: 10, y: 0 }, "L1"));
  const op = baseOp({ entityIds: ["L1"] });

  const r = resolveOpLaser(op, doc.layers, doc.entities);
  expect(r.laserPower).toBe(100);
  expect(r.feedrate).toBe(300);
  expect(r.laserPasses).toBe(3);
  // The op it was derived from is untouched — resolution returns a copy, so the
  // authored operation still shows the user's own numbers in the dialog.
  expect(op.laserPower).toBe(80);
});

test("a layer with no recipe leaves the op exactly as authored", () => {
  const doc = laserDoc();
  doc.entities.push(new LineEntity({ x: 0, y: 0 }, { x: 10, y: 0 }, "L1"));
  const op = baseOp({ entityIds: ["L1"] });

  // Every file written before layer recipes existed looks like this.
  expect(resolveOpLaser(op, doc.layers, doc.entities)).toBe(op);
});

test("an op spanning two layers keeps its own settings — there is no single right answer", () => {
  const doc = laserDoc();
  doc.layers[0].laser = RECIPE;
  const red = addLayer(doc, "layer-red", { feedrate: 900, laserPower: 15, laserPasses: 1 });

  const a = new LineEntity({ x: 0, y: 0 }, { x: 10, y: 0 }, "L1");
  const b = new LineEntity({ x: 0, y: 5 }, { x: 10, y: 5 }, "L2");
  b.layerId = red;
  doc.entities.push(a, b);

  const op = baseOp({ entityIds: ["L1", "L2"] });
  expect(opLayerId(op.entityIds, doc.entities)).toBeNull();
  expect(resolveOpLaser(op, doc.layers, doc.entities).laserPower).toBe(80);
});

test("laserOverride forks the op off its layer", () => {
  const doc = laserDoc();
  doc.layers[0].laser = RECIPE;
  doc.entities.push(new LineEntity({ x: 0, y: 0 }, { x: 10, y: 0 }, "L1"));

  const following = baseOp({ entityIds: ["L1"] });
  const forked = baseOp({ entityIds: ["L1"], laserOverride: true });

  // Positive control: the same op WITHOUT the flag does follow, so this is
  // testing the flag rather than a resolution that never happens.
  expect(resolveOpLaser(following, doc.layers, doc.entities).laserPower).toBe(100);
  expect(resolveOpLaser(forked, doc.layers, doc.entities).laserPower).toBe(80);
});

test("an op referencing geometry that no longer exists is left alone, not guessed at", () => {
  const doc = laserDoc();
  doc.layers[0].laser = RECIPE;
  doc.entities.push(new LineEntity({ x: 0, y: 0 }, { x: 10, y: 0 }, "L1"));

  const op = baseOp({ entityIds: ["L1", "deleted-entity"] });
  expect(opLayerId(op.entityIds, doc.entities)).toBeNull();
  expect(resolveOpLaser(op, doc.layers, doc.entities).laserPower).toBe(80);
});

test("an op targeting nothing has no layer", () => {
  const doc = laserDoc();
  doc.layers[0].laser = RECIPE;
  expect(opLayerId(baseOp({ entityIds: [] }).entityIds, doc.entities)).toBeNull();
});

test("kerf and air assist fall back to the op when the recipe omits them", () => {
  const doc = laserDoc();
  doc.layers[0].laser = { feedrate: 300, laserPower: 100, laserPasses: 1 };
  doc.entities.push(new LineEntity({ x: 0, y: 0 }, { x: 10, y: 0 }, "L1"));

  const op = baseOp({ entityIds: ["L1"], kerfWidth: 0.2, airAssist: true });
  const r = resolveOpLaser(op, doc.layers, doc.entities);
  expect(r.kerfWidth).toBe(0.2);
  expect(r.airAssist).toBe(true);
  expect(r.laserPower).toBe(100); // control: the recipe really did apply
});

test("a recipe that pins kerf and air assist overrides the op's", () => {
  const doc = laserDoc();
  doc.layers[0].laser = {
    feedrate: 300,
    laserPower: 100,
    laserPasses: 1,
    kerfWidth: 0.15,
    airAssist: false,
  };
  doc.entities.push(new LineEntity({ x: 0, y: 0 }, { x: 10, y: 0 }, "L1"));

  const r = resolveOpLaser(baseOp({ entityIds: ["L1"], kerfWidth: 0.2, airAssist: true }), doc.layers, doc.entities);
  expect(r.kerfWidth).toBe(0.15);
  expect(r.airAssist).toBe(false);
});

// --- it reaches the actual output -------------------------------------------

test("the layer's power and feed reach the emitted G-code", () => {
  const doc = laserDoc();
  doc.layers[0].laser = RECIPE;
  doc.entities.push(new LineEntity({ x: 10, y: 10 }, { x: 50, y: 30 }, "L1"));

  const g = generateLaserGCode([baseOp({ entityIds: ["L1"] })], doc);

  // Positive: the layer's 100% (S1000 of the default 1000 max) and 300mm/min.
  expect(g).toContain("M4 S1000");
  expect(g).toMatch(/G1 X50 Y30 F300\b/);
  // Negative, meaningful only alongside the two above: the op's own 80%/1200
  // are gone rather than the program being empty.
  expect(g).not.toContain("S800");
  expect(g).not.toContain("F1200");
});

test("the layer's pass count reaches the emitted G-code", () => {
  const doc = laserDoc();
  doc.entities.push(new LineEntity({ x: 10, y: 10 }, { x: 50, y: 30 }, "L1"));
  const op = baseOp({ entityIds: ["L1"], laserPasses: 1 });

  const once = generateLaserGCode([op], doc);
  doc.layers[0].laser = RECIPE; // 3 passes
  const thrice = generateLaserGCode([op], doc);

  const cuts = (g: string) => g.split("\n").filter((l) => l.startsWith("G1 X50 Y30")).length;
  expect(cuts(once)).toBe(1);
  expect(cuts(thrice)).toBe(3);
});

test("two layers cut at their own settings in one program", () => {
  const doc = laserDoc();
  doc.layers[0].name = "Cut";
  doc.layers[0].laser = { feedrate: 300, laserPower: 100, laserPasses: 1 };
  const red = addLayer(doc, "layer-score", { feedrate: 1800, laserPower: 15, laserPasses: 1 });

  const cut = new RectEntity({ x: 0, y: 0 }, { x: 40, y: 20 }, "R1");
  const score = new LineEntity({ x: 5, y: 10 }, { x: 35, y: 10 }, "L1");
  score.layerId = red;
  doc.entities.push(cut, score);

  const g = generateLaserGCode(
    [
      baseOp({ id: "o1", name: "cut", type: "profile", entityIds: ["R1"] }),
      baseOp({ id: "o2", name: "score", type: "engrave", entityIds: ["L1"] }),
    ],
    doc,
  );

  // Both recipes are present, at their own power, in the one program.
  expect(g).toContain("M4 S1000"); // 100% cut
  expect(g).toContain("S150"); // 15% score
  expect(g).toMatch(/F300\b/);
  expect(g).toMatch(/F1800\b/);
});

test("the on-canvas preview resolves recipes the same way the generator does", () => {
  const doc = laserDoc();
  doc.entities.push(new RectEntity({ x: 0, y: 0 }, { x: 40, y: 20 }, "R1"));
  const op = baseOp({ type: "profile", entityIds: ["R1"], kerfWidth: 0 });

  // A kerf on the recipe must move the previewed path, or the preview is
  // showing something the machine won't cut.
  const plain = laserPreviewPaths([op], doc);
  doc.layers[0].laser = { feedrate: 300, laserPower: 100, laserPasses: 1, kerfWidth: 4 };
  const kerfed = laserPreviewPaths([op], doc);

  const spanX = (ps: { pts: { x: number; y: number }[] }[]) => {
    const xs = ps.flatMap((p) => p.pts.map((q) => q.x));
    return Math.max(...xs) - Math.min(...xs);
  };
  expect(plain.length).toBeGreaterThan(0); // control: there is a path at all
  // "outside" profile with a 4mm kerf pushes the path out by half the kerf each side.
  expect(spanX(kerfed)).toBeCloseTo(spanX(plain) + 4, 6);
});

// --- things that must NOT follow a layer -------------------------------------

test("a material test grid keeps its swept power and speed", () => {
  const doc = laserDoc();
  // A recipe on the layer the test lands on would be catastrophic: every cell
  // identical, and the user reads a meaningless grid as a calibration result.
  doc.layers[0].laser = RECIPE;

  const { entities, operations } = generateMaterialTest({
    mode: "engrave",
    cutPasses: 1,
    powerMin: 20,
    powerMax: 100,
    powerSteps: 3,
    speedMin: 500,
    speedMax: 2500,
    speedSteps: 3,
    cellSize: 8,
    gap: 2,
    fillSpacing: 0.2,
    origin: { x: 0, y: 0 },
    labels: false, // the label op isn't a swept cell; keep the grid to the 9
    labelPower: 30,
    labelSpeed: 1500,
  });

  // The grid's geometry must actually be IN the document, on the layer holding
  // the recipe — otherwise resolution bails on unknown ids and this test passes
  // no matter what the opt-out does. (It did exactly that until mutation
  // testing caught it.)
  doc.entities.push(...entities);
  expect(doc.entities.every((e) => e.layerId === doc.layers[0].id)).toBe(true);

  const cells = operations.filter((o) => o.laserFill);
  expect(cells.length).toBe(9); // control: the grid really was built

  const resolved = cells.map((o) => resolveOpLaser(o, doc.layers, doc.entities));
  expect(new Set(resolved.map((o) => o.laserPower)).size).toBe(3);
  expect(new Set(resolved.map((o) => o.feedrate)).size).toBe(3);
});

// --- persistence -------------------------------------------------------------

test("a layer recipe survives snapshot/restore without sharing the object", () => {
  const doc = laserDoc();
  doc.layers[0].laser = { ...RECIPE };

  const snap = doc.snapshot();
  // Undo captured the recipe; editing the live layer in place must not rewrite it.
  doc.layers[0].laser.laserPower = 42;
  expect(snap.layers?.[0].laser?.laserPower).toBe(100);

  doc.restore(snap);
  expect(doc.layers[0].laser?.laserPower).toBe(100);
  expect(doc.layers[0].laser).not.toBe(snap.layers?.[0].laser);
});
