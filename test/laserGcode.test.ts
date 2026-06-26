/**
 * Laser G-code generation tests. The laser path is the fixed-Z branch of the
 * tool family: no spindle, no Z plunge — just beam on/off (M4/M5), power as an
 * `S` word, and pass repeats. These verify it reuses the same XY geometry while
 * never emitting a Z move, and that generateGCode dispatches to it by machineKind.
 */

import { test, expect } from "vitest";
import { generateLaserGCode, laserPreviewPaths } from "../src/cam/lasergcode";
import { generateGCode } from "../src/cam/gcode";
import { serializeDoc, applyFile } from "../src/io/fileio";
import type { CAMOperation } from "../src/cam/types";
import { CADDocument } from "../src/model/document";
import { LineEntity, RectEntity, CircleEntity } from "../src/model/entities";

function laserDoc(): CADDocument {
  const doc = new CADDocument({ width: 200, height: 100 });
  doc.machineKind = "laser";
  doc.origin = { x: "left", y: "front", z: "top" };
  return doc;
}

function baseOp(over: Partial<CAMOperation>): CAMOperation {
  return {
    id: "op1", name: "cut", type: "engrave", entityIds: [], side: "outside",
    toolNumber: 1, diameter: 0, feedrate: 1200, plungeRate: 300, spindleSpeed: 0,
    safeZ: 5, depth: -3, stepdown: 1.5, stepover: 0.4,
    laserPower: 80, laserPasses: 1,
    ...over,
  };
}

// 1) No Z, beam on/off, program end ------------------------------------------
test("engrave emits beam on/off and no Z motion", () => {
  const doc = laserDoc();
  doc.entities.push(new LineEntity({ x: 10, y: 10 }, { x: 50, y: 30 }, "L1"));
  const op = baseOp({ type: "engrave", entityIds: ["L1"] });

  const g = generateLaserGCode([op], doc);
  expect(g).toContain("M4 S800");        // 80% of default 1000
  expect(g).toContain("M5");
  expect(g).toContain("M30 ; end program");
  // Travel to start (beam off) then a cut move.
  expect(g).toContain("G0 X10 Y10");
  expect(g).toMatch(/G1 X50 Y30 F1200/);
  // A laser never moves in Z — no motion line may carry a Z word.
  for (const line of g.split("\n")) {
    if (/^G[0-3]/.test(line)) expect(line).not.toMatch(/Z/);
  }
});

// 2) Power scaling honours an explicit max ------------------------------------
test("power percentage scales to S against laserMaxPower", () => {
  const doc = laserDoc();
  doc.entities.push(new LineEntity({ x: 0, y: 0 }, { x: 10, y: 0 }, "L1"));
  const op = baseOp({ type: "engrave", entityIds: ["L1"], laserPower: 50 });

  const g = generateLaserGCode([op], doc, { laserMaxPower: 255 });
  expect(g).toContain("M4 S128"); // round(0.5 * 255)
});

// 3) Pass count repeats the trace --------------------------------------------
test("laserPasses repeats the cut path", () => {
  const doc = laserDoc();
  doc.entities.push(new LineEntity({ x: 0, y: 0 }, { x: 10, y: 0 }, "L1"));
  const op = baseOp({ type: "engrave", entityIds: ["L1"], laserPasses: 3 });

  const g = generateLaserGCode([op], doc);
  const travels = g.split("\n").filter((l) => l.startsWith("G0 X0 Y0"));
  expect(travels.length).toBe(3); // one travel-to-start per pass
});

// 4) Profile kerf compensation grows an outside circle ------------------------
test("outside profile offsets a circle outward by half the kerf", () => {
  const doc = laserDoc();
  doc.entities.push(new CircleEntity({ x: 50, y: 50 }, 10, "C1"));
  const op = baseOp({ type: "profile", side: "outside", entityIds: ["C1"], kerfWidth: 1 });

  const g = generateLaserGCode([op], doc);
  // radius 10 + kerf/2 (0.5) = 10.5 → the G2 carries I-10.5.
  expect(g).toMatch(/G2 .*I-10\.5 J0/);
});

// 5) Volumetric op types are skipped loudly -----------------------------------
test("a non-laser op type is skipped with a note, not emitted", () => {
  const doc = laserDoc();
  doc.entities.push(new RectEntity({ x: 0, y: 0 }, { x: 20, y: 20 }, "R1"));
  const op = baseOp({ type: "pocket", entityIds: ["R1"] });

  const g = generateLaserGCode([op], doc);
  expect(g).toContain("no laser equivalent");
  expect(g).not.toContain("M4 S"); // beam never turned on for a skipped op
});

// 6) generateGCode dispatches by machineKind ----------------------------------
test("generateGCode routes a laser document to the laser generator", () => {
  const doc = laserDoc();
  doc.entities.push(new RectEntity({ x: 0, y: 0 }, { x: 20, y: 20 }, "R1"));
  const op = baseOp({ type: "profile", side: "outside", entityIds: ["R1"] });

  const g = generateGCode([op], doc);
  expect(g).toContain("M4 S");      // laser preamble, not a spindle M3
  expect(g).not.toContain("M3 S");  // would be the mill spindle command
});

// 7) Mill documents are unaffected -------------------------------------------
test("a mill document still emits spindle G-code", () => {
  const doc = new CADDocument({ width: 200, height: 100 });
  doc.entities.push(new RectEntity({ x: 0, y: 0 }, { x: 20, y: 20 }, "R1"));
  const op = baseOp({ type: "profile", side: "outside", entityIds: ["R1"], spindleSpeed: 18000 });

  const g = generateGCode([op], doc);
  expect(g).toContain("M3 S18000");
  expect(g).not.toContain("M4 S");
});

// 8) Flat preview paths -------------------------------------------------------
test("preview yields an open path for an engraved line", () => {
  const doc = laserDoc();
  doc.entities.push(new LineEntity({ x: 10, y: 10 }, { x: 50, y: 30 }, "L1"));
  const op = baseOp({ type: "engrave", entityIds: ["L1"] });

  const paths = laserPreviewPaths([op], doc);
  expect(paths.length).toBe(1);
  expect(paths[0].closed).toBe(false);
  expect(paths[0].pts).toEqual([{ x: 10, y: 10 }, { x: 50, y: 30 }]);
});

test("preview reflects profile kerf — outside circle samples at the grown radius", () => {
  const doc = laserDoc();
  doc.entities.push(new CircleEntity({ x: 50, y: 50 }, 10, "C1"));
  const op = baseOp({ type: "profile", side: "outside", entityIds: ["C1"], kerfWidth: 1 });

  const paths = laserPreviewPaths([op], doc);
  expect(paths.length).toBe(1);
  expect(paths[0].closed).toBe(true);
  // every sampled point sits on the kerf-compensated radius (10 + 0.5).
  for (const p of paths[0].pts) {
    expect(Math.hypot(p.x - 50, p.y - 50)).toBeCloseTo(10.5, 6);
  }
});

test("preview skips op types with no laser equivalent", () => {
  const doc = laserDoc();
  doc.entities.push(new RectEntity({ x: 0, y: 0 }, { x: 20, y: 20 }, "R1"));
  const op = baseOp({ type: "pocket", entityIds: ["R1"] });

  expect(laserPreviewPaths([op], doc)).toEqual([]);
});

// 9) Area-fill engrave --------------------------------------------------------
test("fill engrave outlines and floods a closed rectangle", () => {
  const doc = laserDoc();
  doc.entities.push(new RectEntity({ x: 0, y: 0 }, { x: 10, y: 10 }, "R1"));
  const op = baseOp({ type: "engrave", entityIds: ["R1"], laserFill: true, laserFillSpacing: 1 });

  const g = generateLaserGCode([op], doc);
  expect(g).toContain("Engrave (fill)");
  expect(g).toContain("M4 S800");
  // ~10mm tall / 1mm spacing → on the order of 10 interior scan rows; each row
  // is a travel (G0) + a cut (G1). The outline alone would be a handful of moves.
  const cuts = g.split("\n").filter((l) => l.startsWith("G1 "));
  expect(cuts.length).toBeGreaterThan(8);

  // Preview exposes the outline (closed) plus many open fill segments.
  const paths = laserPreviewPaths([op], doc);
  expect(paths.some((p) => p.closed)).toBe(true);
  expect(paths.filter((p) => !p.closed).length).toBeGreaterThan(8);
});

test("fill skips an open shape with a note", () => {
  const doc = laserDoc();
  doc.entities.push(new LineEntity({ x: 0, y: 0 }, { x: 10, y: 0 }, "L1"));
  const op = baseOp({ type: "engrave", entityIds: ["L1"], laserFill: true });

  const g = generateLaserGCode([op], doc);
  expect(g).toContain("fill needs a closed shape");
});

// 10) An over-large inside kerf warns instead of silently dropping the cut -----
test("inside profile collapsed by kerf emits a note, not silence", () => {
  const doc = laserDoc();
  doc.entities.push(new CircleEntity({ x: 50, y: 50 }, 2, "C1"));
  // kerf 10 → inside radius 2 - 5 = -3 ≤ 0, so nothing can be cut.
  const op = baseOp({ type: "profile", side: "inside", entityIds: ["C1"], kerfWidth: 10 });

  const g = generateLaserGCode([op], doc);
  expect(g).toContain("vanished under inside kerf");
  expect(g).not.toMatch(/^G2 /m); // no actual arc emitted
});

// 11) Laser settings survive a .rcam save/load round-trip ----------------------
test("machineKind and laser op fields round-trip through serialize/apply", () => {
  const doc = laserDoc();
  doc.entities.push(new CircleEntity({ x: 50, y: 50 }, 10, "C1"));
  doc.entities.push(new RectEntity({ x: 0, y: 0 }, { x: 20, y: 20 }, "R1"));
  doc.operations.push(baseOp({ type: "profile", side: "outside", entityIds: ["C1"],
    laserPower: 90, laserPasses: 3, kerfWidth: 0.25 }));
  doc.operations.push(baseOp({ type: "engrave", entityIds: ["R1"],
    laserFill: true, laserFillSpacing: 0.3 }));

  // Serialize → JSON → parse → apply into a fresh document.
  const file = JSON.parse(JSON.stringify(serializeDoc(doc, "Laser job")));
  expect(file.machineKind).toBe("laser");

  const loaded = new CADDocument({ width: 200, height: 100 });
  applyFile(loaded, file);

  expect(loaded.machineKind).toBe("laser");
  const cut = loaded.operations.find((o) => o.type === "profile")!;
  expect(cut.laserPower).toBe(90);
  expect(cut.laserPasses).toBe(3);
  expect(cut.kerfWidth).toBe(0.25);
  const fill = loaded.operations.find((o) => o.type === "engrave")!;
  expect(fill.laserFill).toBe(true);
  expect(fill.laserFillSpacing).toBe(0.3);
});

// 12) Selectable laser post-processors ----------------------------------------
function engraveLine(postId?: string) {
  const doc = laserDoc();
  if (postId) doc.postProcessor = postId;
  doc.entities.push(new LineEntity({ x: 0, y: 0 }, { x: 10, y: 0 }, "L1"));
  return generateLaserGCode([baseOp({ type: "engrave", entityIds: ["L1"], laserPower: 80 })], doc);
}

test("GRBL constant post emits M3 (not M4) at full scale", () => {
  const g = engraveLine("grbl-constant");
  expect(g).toContain("M3 S800");
  expect(g).not.toContain("M4 S");
});

test("Marlin post scales power to 0–255", () => {
  const g = engraveLine("marlin");
  expect(g).toContain("M3 S204"); // round(0.8 * 255)
});

test("LinuxCNC laser post drives the beam as a PWM spindle (M3/M5)", () => {
  const g = engraveLine("linuxcnc-laser");
  expect(g).toContain("M3 S800");
  expect(g).toContain("M5");
});

test("Smoothie post carries inline S (0–1) on each cut move, no modal M3/M4", () => {
  const g = engraveLine("smoothie");
  expect(g).not.toMatch(/M[34] S/);          // power is not modal
  expect(g).toMatch(/G1 X10 Y0 F1200 S0\.8/); // it rides on the cut move
  expect(g).toContain("M5 ; laser off");
});

test("a legacy laser doc with postProcessor 'grbl' maps to the GRBL dynamic head", () => {
  const g = engraveLine("grbl"); // pre-variant laser files stored plain "grbl"
  expect(g).toContain("M4 S800");
});
