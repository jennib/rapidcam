import { test, expect } from "vitest";
import { generateLaserGCode } from "../src/cam/lasergcode";
import { CADDocument } from "../src/model/document";
import { LineEntity, RectEntity } from "../src/model/entities";
import type { CAMOperation } from "../src/cam/types";

function laserDoc(): CADDocument {
  const doc = new CADDocument({ width: 200, height: 100 });
  doc.machineKind = "laser";
  doc.origin = { x: "left", y: "front", z: "top" };
  return doc;
}
function op(over: Partial<CAMOperation>): CAMOperation {
  return {
    id: "op",
    name: "score",
    type: "score",
    entityIds: [],
    side: "outside",
    toolNumber: 1,
    diameter: 0,
    feedrate: 1200,
    plungeRate: 300,
    spindleSpeed: 0,
    safeZ: 5,
    depth: -3,
    stepdown: 1.5,
    stepover: 0.4,
    laserPower: 15,
    laserPasses: 1,
    ...over,
  };
}

test("a score op produces a real toolpath at its (low) power, no Z, no skip note", () => {
  const doc = laserDoc();
  doc.entities.push(new LineEntity({ x: 10, y: 10 }, { x: 60, y: 40 }, "L1"));
  const g = generateLaserGCode([op({ entityIds: ["L1"], laserPower: 15 })], doc);
  expect(g).toContain("S150"); // 15% of 1000 — the low fold-line power
  expect(g).not.toMatch(/no laser equivalent/); // it IS a laser op
  expect(g).not.toMatch(/^G[01] Z/m); // fixed-Z beam, never a Z move
  expect(g).toMatch(/G1 X/); // beam actually travels
});

test("a score follows the centreline — no kerf offset (unlike a Cut)", () => {
  const doc = laserDoc();
  doc.entities.push(new RectEntity({ x: 10, y: 10 }, { x: 50, y: 30 }, "R1"));

  const scored = generateLaserGCode([op({ entityIds: ["R1"] })], doc);
  // Centreline: the exact rect corners appear verbatim (no offset).
  for (const c of [
    [10, 10],
    [50, 10],
    [50, 30],
    [10, 30],
  ]) {
    expect(scored).toContain(`X${c[0]} Y${c[1]}`);
  }

  // A Cut (outside profile) with kerf offsets the path outward, so the raw
  // corners no longer appear — proving score ≠ cut.
  const cut = generateLaserGCode(
    [op({ type: "profile", side: "outside", kerfWidth: 1, entityIds: ["R1"] })],
    doc,
  );
  expect(cut).not.toContain("X10 Y10");
});

test("a score follows an open path (a fold line need not be closed)", () => {
  const doc = laserDoc();
  doc.entities.push(new LineEntity({ x: 0, y: 50 }, { x: 100, y: 50 }, "fold"));
  const g = generateLaserGCode([op({ entityIds: ["fold"] })], doc);
  expect(g).toContain("X0 Y50");
  expect(g).toContain("X100 Y50");
});
