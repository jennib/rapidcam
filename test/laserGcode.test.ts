/**
 * Laser G-code generation tests. The laser path is the fixed-Z branch of the
 * tool family: no spindle, no Z plunge — just beam on/off (M4/M5), power as an
 * `S` word, and pass repeats. These verify it reuses the same XY geometry while
 * never emitting a Z move, and that generateGCode dispatches to it by machineKind.
 */

import { test, expect } from "vitest";
import { generateLaserGCode, laserPreviewPaths } from "../src/cam/lasergcode";
import { generateGCode } from "../src/cam/gcode";
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
