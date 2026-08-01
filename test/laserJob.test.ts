/**
 * Building a laser job from the layer list — "cut on black, score on red" as a
 * single action rather than one hand-made toolpath per colour.
 *
 * The rule under test that is easiest to get wrong: a layer's `kind` is read
 * HERE, when operations are built, and is deliberately not applied live the way
 * power/speed are (see cam/laserJob.ts for why). So these assert what the
 * builder produces, and `laserLayerRecipe.test.ts` asserts what stays live.
 */

import { test, expect } from "vitest";
import { buildJobFromLayers } from "../src/cam/laserJob";
import { generateLaserGCode } from "../src/cam/lasergcode";
import { CADDocument } from "../src/model/document";
import { LineEntity, RectEntity, CircleEntity, RasterImageEntity } from "../src/model/entities";
import type { LaserRecipe } from "../src/cam/types";

function laserDoc(): CADDocument {
  const doc = new CADDocument({ width: 300, height: 200 });
  doc.machineKind = "laser";
  doc.origin = { x: "left", y: "front", z: "top" };
  return doc;
}

function layer(doc: CADDocument, id: string, name: string, laser?: LaserRecipe): string {
  doc.layers.push({ id, name, color: "#888888", visible: true, locked: false, laser });
  return id;
}

const CUT: LaserRecipe = { kind: "cut", feedrate: 300, laserPower: 100, laserPasses: 3 };
const SCORE: LaserRecipe = { kind: "score", feedrate: 1800, laserPower: 15, laserPasses: 1 };

/** A two-colour job: an outline to cut, a fold line to score. */
function twoColourDoc(): CADDocument {
  const doc = laserDoc();
  doc.layers[0].name = "Cut";
  doc.layers[0].laser = { ...CUT };
  const scoreId = layer(doc, "l-score", "Score", { ...SCORE });

  doc.entities.push(new RectEntity({ x: 10, y: 10 }, { x: 110, y: 80 }, "R1"));
  const fold = new LineEntity({ x: 60, y: 10 }, { x: 60, y: 80 }, "L1");
  fold.layerId = scoreId;
  doc.entities.push(fold);
  return doc;
}

test("one operation per layer with a job kind, in layer order", () => {
  const { operations, skipped } = buildJobFromLayers(twoColourDoc());

  expect(operations.map((o) => o.name)).toEqual(["Cut", "Score"]);
  expect(operations[0].type).toBe("profile");
  expect(operations[1].type).toBe("score");
  expect(operations[0].entityIds).toEqual(["R1"]);
  expect(operations[1].entityIds).toEqual(["L1"]);
  expect(skipped).toEqual([]);
});

test("each operation carries its layer's beam settings", () => {
  const { operations } = buildJobFromLayers(twoColourDoc());
  expect(operations[0]).toMatchObject({ laserPower: 100, feedrate: 300, laserPasses: 3 });
  expect(operations[1]).toMatchObject({ laserPower: 15, feedrate: 1800, laserPasses: 1 });
});

test("a layer with a recipe but no kind tunes, it is not a job", () => {
  const doc = laserDoc();
  doc.layers[0].laser = { feedrate: 300, laserPower: 100, laserPasses: 1 }; // no kind
  doc.entities.push(new RectEntity({ x: 0, y: 0 }, { x: 10, y: 10 }, "R1"));

  const { operations, skipped } = buildJobFromLayers(doc);
  expect(operations).toEqual([]);
  // Silent: it is not an error, and reporting every tuning layer as "skipped"
  // would bury the reports that matter.
  expect(skipped).toEqual([]);
});

test("workholding is never cut, however it is configured", () => {
  const doc = laserDoc();
  doc.layers[0].laser = { ...CUT };
  doc.layers[0].fixture = true;
  doc.entities.push(new RectEntity({ x: 0, y: 0 }, { x: 10, y: 10 }, "R1"));

  const { operations, skipped } = buildJobFromLayers(doc);
  expect(operations).toEqual([]);
  expect(skipped).toEqual([{ layer: "Default", why: "workholding layers are not cut" }]);
});

test("an empty layer is reported, not silently dropped", () => {
  const doc = laserDoc();
  doc.layers[0].name = "Cut";
  doc.layers[0].laser = { ...CUT };
  // No geometry at all.
  const { operations, skipped } = buildJobFromLayers(doc);
  expect(operations).toEqual([]);
  expect(skipped).toEqual([{ layer: "Cut", why: "no geometry on it" }]);
});

test("a hidden layer is not cut", () => {
  const doc = laserDoc();
  doc.layers[0].name = "Cut";
  doc.layers[0].laser = { ...CUT };
  doc.entities.push(new RectEntity({ x: 0, y: 0 }, { x: 10, y: 10 }, "R1"));
  expect(buildJobFromLayers(doc).operations).toHaveLength(1); // control: visible = cut

  doc.layers[0].visible = false;
  const { operations, skipped } = buildJobFromLayers(doc);
  expect(operations).toEqual([]);
  expect(skipped).toEqual([{ layer: "Cut", why: "the layer is hidden" }]);
});

test("construction geometry is not cut", () => {
  const doc = laserDoc();
  doc.layers[0].laser = { ...CUT };
  const real = new RectEntity({ x: 0, y: 0 }, { x: 10, y: 10 }, "R1");
  const guide = new LineEntity({ x: 0, y: 0 }, { x: 50, y: 50 }, "G1");
  guide.isConstruction = true;
  doc.entities.push(real, guide);

  expect(buildJobFromLayers(doc).operations[0].entityIds).toEqual(["R1"]);
});

test("kerf is taken only on a cut, and follows the recipe's side", () => {
  const doc = laserDoc();
  doc.layers[0].laser = { ...CUT, kerfWidth: 0.2, side: "inside" };
  const scoreId = layer(doc, "l-s", "Score", { ...SCORE, kerfWidth: 0.2 });
  doc.entities.push(new RectEntity({ x: 0, y: 0 }, { x: 10, y: 10 }, "R1"));
  const l = new LineEntity({ x: 0, y: 0 }, { x: 5, y: 0 }, "L1");
  l.layerId = scoreId;
  doc.entities.push(l);

  const [cut, score] = buildJobFromLayers(doc).operations;
  expect(cut.kerfWidth).toBe(0.2);
  expect(cut.side).toBe("inside");
  // A score is a centreline — carrying a kerf there would imply a compensation
  // the generator never applies.
  expect(score.kerfWidth).toBeUndefined();
});

// --- kerf direction ----------------------------------------------------------
//
// The bug these were written for: a cut layer holding an outline AND a hole got
// one operation with one side, so with a kerf set the hole was traced OUTSIDE
// its own contour and finished a full kerf oversize. Silently wrong parts.

/** An outline with a hole in it, on one cut layer. */
function plateWithHole(kerfWidth: number): CADDocument {
  const doc = laserDoc();
  doc.layers[0].name = "Cut";
  doc.layers[0].laser = { ...CUT, laserPasses: 1, kerfWidth };
  doc.entities.push(new RectEntity({ x: 20, y: 20 }, { x: 120, y: 100 }, "outline"));
  doc.entities.push(new CircleEntity({ x: 70, y: 60 }, 10, "hole"));
  return doc;
}

/** Radii the program actually traces circles at (|I| of each G2). */
function tracedRadii(g: string): number[] {
  return [...g.matchAll(/G2 X[\d.-]+ Y[\d.-]+ I([\d.-]+)/g)].map((m) => Math.abs(+m[1]));
}

test("a kerf-compensated cut splits into holes and outline, holes first", () => {
  const { operations } = buildJobFromLayers(plateWithHole(2));

  expect(operations.map((o) => o.name)).toEqual(["Cut (holes)", "Cut"]);
  expect(operations[0].entityIds).toEqual(["hole"]);
  expect(operations[0].side).toBe("inside");
  expect(operations[1].entityIds).toEqual(["outline"]);
  expect(operations[1].side).toBe("outside");
});

test("the hole is traced INSIDE its contour, so it finishes at the drawn size", () => {
  const doc = plateWithHole(2);
  const g = generateLaserGCode(buildJobFromLayers(doc).operations, doc);

  // A 10mm-radius hole with a 2mm kerf: the beam centreline must run at r=9,
  // removing 1mm either side to finish at 10. Tracing at 11 (the bug) finishes
  // the hole 4mm oversize.
  expect(tracedRadii(g)).toContain(9);
  expect(tracedRadii(g)).not.toContain(11);
});

test("with no kerf there is nothing to compensate, so the layer stays one operation", () => {
  const { operations } = buildJobFromLayers(plateWithHole(0));
  expect(operations).toHaveLength(1);
  expect(operations[0].entityIds.sort()).toEqual(["hole", "outline"]);
  // Control: the same document WITH a kerf does split.
  expect(buildJobFromLayers(plateWithHole(2)).operations).toHaveLength(2);
});

test("an explicit side overrides the automatic call", () => {
  const doc = plateWithHole(2);
  doc.layers[0].laser!.side = "outside";
  const { operations } = buildJobFromLayers(doc);
  // The user has said what they want; don't second-guess them by splitting.
  expect(operations).toHaveLength(1);
  expect(operations[0].side).toBe("outside");
});

test("nesting alternates: a plug inside a hole is cut outside again", () => {
  // Even-odd, not "anything enclosed is a hole". A washer-in-a-hole is depth 2
  // and is a part in its own right, so its kerf goes outward like any outline —
  // treating it as a hole would make it a kerf undersize.
  const doc = laserDoc();
  doc.layers[0].name = "Cut";
  doc.layers[0].laser = { ...CUT, laserPasses: 1, kerfWidth: 1 };
  doc.entities.push(new RectEntity({ x: 0, y: 0 }, { x: 200, y: 200 }, "outline")); // depth 0
  doc.entities.push(new CircleEntity({ x: 100, y: 100 }, 60, "hole")); // depth 1
  doc.entities.push(new CircleEntity({ x: 100, y: 100 }, 20, "plug")); // depth 2

  const { operations } = buildJobFromLayers(doc);
  expect(operations.map((o) => o.name)).toEqual(["Cut (holes)", "Cut"]);
  expect(operations[0].entityIds).toEqual(["hole"]);
  expect(operations[0].side).toBe("inside");
  expect(operations[1].entityIds.sort()).toEqual(["outline", "plug"]);
  expect(operations[1].side).toBe("outside");
});

test("a layer of holes only is cut inside, without an empty outline operation", () => {
  const doc = laserDoc();
  doc.layers[0].name = "Holes";
  doc.layers[0].laser = { ...CUT, laserPasses: 1, kerfWidth: 1 };
  doc.entities.push(new CircleEntity({ x: 40, y: 40 }, 5, "h1"));
  doc.entities.push(new CircleEntity({ x: 80, y: 40 }, 5, "h2"));

  const { operations } = buildJobFromLayers(doc);
  // Neither circle contains the other, so both are outer contours.
  expect(operations).toHaveLength(1);
  expect(operations[0].side).toBe("outside");
});

test('a layer holding only what this job cannot do says so, instead of "no geometry"', () => {
  const doc = laserDoc();
  doc.layers[0].name = "Cut";
  doc.layers[0].laser = { ...CUT };
  doc.entities.push(new RasterImageEntity("img-1", { x: 0, y: 0 }, 50, 50, 0, false, false, "IMG"));

  const { skipped } = buildJobFromLayers(doc);
  // "no geometry on it" would send someone hunting for shapes sitting in plain
  // sight on the canvas.
  expect(skipped[0].why).toMatch(/cannot be cut|can only be engraved/);
  expect(skipped[0].why).not.toBe("no geometry on it");
});

test("a filled engrave is an engrave with fill switched on", () => {
  const doc = laserDoc();
  doc.layers[0].laser = { kind: "fill", feedrate: 900, laserPower: 40, laserPasses: 1 };
  doc.entities.push(new CircleEntity({ x: 50, y: 50 }, 20, "C1"));

  const [op] = buildJobFromLayers(doc).operations;
  expect(op.type).toBe("engrave");
  expect(op.laserFill).toBe(true);
  expect(op.laserFillSpacing).toBeGreaterThan(0);
});

test("a plain engrave does NOT switch fill on", () => {
  const doc = laserDoc();
  doc.layers[0].laser = { kind: "engrave", feedrate: 900, laserPower: 40, laserPasses: 1 };
  doc.entities.push(new CircleEntity({ x: 50, y: 50 }, 20, "C1"));

  const [op] = buildJobFromLayers(doc).operations;
  expect(op.type).toBe("engrave"); // control: it is the same op type as above
  expect(op.laserFill).toBeUndefined();
});

test("the built job posts a program that cuts both layers at their own settings", () => {
  const doc = twoColourDoc();
  const { operations } = buildJobFromLayers(doc);
  doc.operations = operations;

  const g = generateLaserGCode(operations, doc);

  // Positive controls first: both layers are really in the program.
  expect(g).toContain("M4 S1000"); // cut at 100%
  expect(g).toContain("S150"); // score at 15%
  expect(g).toMatch(/F300\b/);
  expect(g).toMatch(/F1800\b/);
  // The cut repeats three times; the score once.
  const foldMoves = g.split("\n").filter((l) => /^G1 X60 Y80\b/.test(l)).length;
  expect(foldMoves).toBe(1);
});

test("rebuilding is idempotent — geometry is not cut twice", () => {
  // The action replaces the op list rather than appending. A laser tracing the
  // same contour a second time scorches the part, so this is worth pinning.
  const doc = twoColourDoc();
  const first = buildJobFromLayers(doc).operations;
  doc.operations = first;
  const second = buildJobFromLayers(doc).operations;

  expect(second).toHaveLength(first.length);
  expect(second.map((o) => o.entityIds)).toEqual(first.map((o) => o.entityIds));
});
