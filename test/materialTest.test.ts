/**
 * Laser material-test generator: a power×speed grid of engrave-fill cells (+
 * labels) with one CAM op per cell carrying that cell's power/feed.
 */
import { test, expect } from "vitest";
import { generateMaterialTest, MATERIAL_TEST_DEFAULTS } from "../src/cam/materialTest";
import { generateLaserGCode } from "../src/cam/lasergcode";
import { CADDocument } from "../src/model/document";
import { RectEntity } from "../src/model/entities";

const params = (over = {}) => ({
  ...MATERIAL_TEST_DEFAULTS,
  powerMin: 20, powerMax: 100, powerSteps: 5,
  speedMin: 200, speedMax: 1200, speedSteps: 5,
  origin: { x: 20, y: 15 },
  fontId: "test-font", // non-empty so labels generate without a loaded font
  ...over,
});

test("generates one engrave-fill cell per power×speed combination", () => {
  const { entities, operations } = generateMaterialTest(params());
  // 5×5 cells (+ 5+5 labels), 25 cell ops + 1 labels op.
  const cells = entities.filter((e) => e instanceof RectEntity);
  expect(cells.length).toBe(25);
  expect(entities.length).toBe(25 + 10);
  expect(operations.length).toBe(26);
  for (const op of operations.slice(0, 25)) {
    expect(op.type).toBe("engrave");
    expect(op.laserFill).toBe(true);
    expect(op.laserPasses).toBe(1);
  }
});

test("sweeps power across rows and speed across columns", () => {
  const { operations } = generateMaterialTest(params());
  // The corners of the sweep should be present.
  expect(operations.some((o) => o.laserPower === 20 && o.feedrate === 200)).toBe(true);
  expect(operations.some((o) => o.laserPower === 100 && o.feedrate === 1200)).toBe(true);
  // Distinct power and feed values = the step counts.
  const powers = new Set(operations.slice(0, 25).map((o) => o.laserPower));
  const feeds = new Set(operations.slice(0, 25).map((o) => o.feedrate));
  expect(powers.size).toBe(5);
  expect(feeds.size).toBe(5);
});

test("a single power/speed step collapses to the minimum", () => {
  const { operations } = generateMaterialTest(params({ powerSteps: 1, speedSteps: 1, fontId: "" }));
  expect(operations.length).toBe(1); // one cell, no labels (fontId empty)
  expect(operations[0].laserPower).toBe(20);
  expect(operations[0].feedrate).toBe(200);
});

test("cut mode makes profile (outline) cells with the chosen pass count", () => {
  const { operations } = generateMaterialTest(params({ mode: "cut", cutPasses: 3 }));
  const cells = operations.slice(0, 25);
  for (const op of cells) {
    expect(op.type).toBe("profile");
    expect(op.laserFill).toBeUndefined();
    expect(op.laserPasses).toBe(3);
  }
  // The labels op is still a (single-pass) engrave.
  expect(operations[25].type).toBe("engrave");
  expect(operations[25].laserPasses).toBe(1);
});

test("the generated grid posts to laser G-code with the swept powers", () => {
  const { entities, operations } = generateMaterialTest(params());
  const doc = new CADDocument({ width: 300, height: 300 });
  doc.machineKind = "laser";
  doc.origin = { x: "left", y: "front", z: "top" };
  for (const e of entities) doc.entities.push(e);

  const g = generateLaserGCode(operations, doc);
  expect(g).toContain("M4 S200");  // 20% of default max 1000
  expect(g).toContain("M4 S1000"); // 100%
});
