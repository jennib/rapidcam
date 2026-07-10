import { test, expect } from "vitest";
import { resolveTabCount, computeTabRegions } from "../src/cam/tabs";
import { generateGCode } from "../src/cam/gcode";
import { CADDocument } from "../src/model/document";
import { RectEntity } from "../src/model/entities";
import type { CAMOperation } from "../src/cam/types";

test("resolveTabCount: fixed count vs one-per-spacing", () => {
  expect(resolveTabCount(200, 3, undefined)).toBe(3); // count mode
  expect(resolveTabCount(200, 3, 0)).toBe(3); // spacing 0 → count
  expect(resolveTabCount(200, 3, 40)).toBe(5); // 200/40
  expect(resolveTabCount(80, 99, 40)).toBe(2); // spacing wins over count
  expect(resolveTabCount(30, 99, 40)).toBe(1); // always at least one
  expect(resolveTabCount(200, 3.6, undefined)).toBe(4); // count rounds
});

test("by-spacing puts proportionally more tabs on a longer perimeter", () => {
  const small = resolveTabCount(200, 0, 50); // 4
  const big = resolveTabCount(400, 0, 50); // 8
  expect(computeTabRegions(200, small, 4)).toHaveLength(4);
  expect(computeTabRegions(400, big, 4)).toHaveLength(8);
});

test("tabs on a through-cut are held in real stock, not the spoilboard", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  doc.stockThickness = 10;
  doc.add(new RectEntity({ x: 0, y: 0 }, { x: 100, y: 100 }));
  const op: CAMOperation = {
    id: "p",
    name: "cut",
    type: "profile",
    entityIds: [doc.entities.find((e) => e.type === "rectangle")!.id],
    side: "outside",
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 3,
    feedrate: 1000,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -12,
    stepdown: 3,
    stepover: 0.4, // 2mm past the 10mm stock (through-cut)
    tabs: { enabled: true, count: 4, width: 6, height: 2 },
  };
  const g = generateGCode([op], doc);
  // Tab bridges ride at stock-bottom + height = -10 + 2 = -8, leaving 2mm of REAL
  // material. Measured from the cut floor they would sit at -12 + 2 = -10 (the stock
  // bottom) and hold nothing — that level must NOT be a tab bridge.
  expect(g).toMatch(/G1 Z-8 F/);
  expect(g).not.toMatch(/G1 Z-10 F/);
});

test("a profile with spacing tabs emits tab segments through the G-code", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  doc.add(new RectEntity({ x: 0, y: 0 }, { x: 100, y: 100 })); // perimeter 400
  const op: CAMOperation = {
    id: "p",
    name: "cut",
    type: "profile",
    entityIds: [doc.entities.find((e) => e.type === "rectangle")!.id],
    side: "outside",
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 3,
    feedrate: 1000,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -2,
    stepdown: 2,
    stepover: 0.4,
    tabs: { enabled: true, strategy: "spacing", count: 4, spacing: 50, width: 5, height: 1 },
  };
  const g = generateGCode([op], doc);
  // Tab segments cut at depth + height = -1 (not the full -2); they appear because
  // 400mm / 50mm ≈ 8 tabs were placed.
  expect(g).toMatch(/G1 Z-1\b/);
  expect((g.match(/G1 Z-1\b/g) || []).length).toBeGreaterThanOrEqual(8);
});
