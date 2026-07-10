/**
 * Positioned stock (Phase 2.1): a `stockRect` places a flat blank within the work
 * area (canvas). The material footprint and the WCS origin then follow the stock,
 * not the whole canvas. A document with no stockRect (legacy) is unchanged — that
 * neutrality is enforced by test/golden.test.ts.
 */
import { test, expect } from "vitest";
import { CADDocument, resolveOrigin, stockFootprint } from "../src/model/document";
import { RectEntity } from "../src/model/entities";
import { generateGCode } from "../src/cam/gcode";
import { serializeDoc, applyFile } from "../src/io/fileio";
import type { CAMOperation } from "../src/cam/types";

function profileOp(entityIds: string[]): CAMOperation {
  return {
    id: "op",
    name: "cut",
    type: "profile",
    side: "outside",
    entityIds,
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 6,
    feedrate: 1000,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -2,
    stepdown: 2,
    stepover: 0.4,
  };
}

test("stockFootprint follows the stockRect when set, else the canvas", () => {
  const doc = new CADDocument({ width: 300, height: 200 });
  expect(stockFootprint(doc)).toEqual({ width: 300, height: 200 }); // legacy → canvas
  doc.stockRect = { x: 20, y: 15, width: 120, height: 80 };
  expect(stockFootprint(doc)).toEqual({ width: 120, height: 80 }); // → the blank
});

test("a positioned stock puts the WCS origin on the stock, not the work-area corner", () => {
  const doc = new CADDocument({ width: 300, height: 200 });
  doc.stockRect = { x: 20, y: 15, width: 120, height: 80 };

  // Front-left-top → datum at the stock's lower-left corner (20,15).
  doc.origin = { x: "left", y: "front", z: "top" };
  expect(resolveOrigin(doc)).toEqual({ ox: 20, oy: 15, zOffset: 0 });

  // Center → stock centre (20+60, 15+40).
  doc.origin = { x: "center", y: "center", z: "top" };
  expect(resolveOrigin(doc)).toEqual({ ox: 80, oy: 55, zOffset: 0 });

  // Right/back → far corner of the stock.
  doc.origin = { x: "right", y: "back", z: "top" };
  expect(resolveOrigin(doc)).toEqual({ ox: 140, oy: 95, zOffset: 0 });
});

test("stock is the box (not the canvas) in the derived doc.stock", () => {
  const doc = new CADDocument({ width: 300, height: 200 });
  doc.stockThickness = 12;
  doc.stockRect = { x: 5, y: 5, width: 100, height: 60 };
  expect(doc.stock).toEqual({ kind: "box", width: 100, height: 60, thickness: 12 });
});

test("G-code coordinates shift so they're relative to the positioned stock", () => {
  // A rectangle drawn at work-area (30,25)-(90,75); stock blank starts at (20,15).
  // With a left/front origin on the stock, the cut's near corner lands at
  // (30-20, 25-15) = (10, 10) in the program.
  const doc = new CADDocument({ width: 300, height: 200 });
  doc.stockRect = { x: 20, y: 15, width: 120, height: 80 };
  const r = doc.add(new RectEntity({ x: 30, y: 25 }, { x: 90, y: 75 }));
  doc.operations = [profileOp([r.id])];
  const g = generateGCode(doc.operations, doc);
  // outside profile of a 6mm tool → offset out 3mm, so the near corner is (7,7).
  expect(g).toMatch(/X7 Y7\b/);
  expect(g).toMatch(/; Stock: 120 × 80 × 10mm/); // header reports the blank, not the canvas
});

test("stockRect round-trips through .rcam serialize/apply; absent stays null", () => {
  const doc = new CADDocument({ width: 300, height: 200 });
  doc.stockRect = { x: 20, y: 15, width: 120, height: 80 };
  const file = serializeDoc(doc, "positioned");
  const doc2 = new CADDocument({ width: 10, height: 10 });
  applyFile(doc2, file);
  expect(doc2.stockRect).toEqual({ x: 20, y: 15, width: 120, height: 80 });

  const flat = new CADDocument({ width: 200, height: 100 });
  const flatFile = serializeDoc(flat, "flat") as Record<string, unknown>;
  expect("stockRect" in flatFile).toBe(false); // omitted when unset
  const flat2 = new CADDocument({ width: 10, height: 10 });
  applyFile(flat2, flatFile as never);
  expect(flat2.stockRect).toBeNull();
});
