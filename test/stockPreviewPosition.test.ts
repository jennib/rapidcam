import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { CircleEntity, RectEntity } from "../src/model/entities";
import { rasterizeStock } from "../src/cam/stockRasterizer";
import type { CAMOperation } from "../src/cam/types";

test("3D preview: positioned stockRect offsets cuts so they render relative to stock origin", () => {
  // 300x250 sheet, with a 200x150 stock blank placed at offset (50, 50)
  const doc = new CADDocument({ width: 300, height: 250 });
  doc.stockRect = { x: 50, y: 50, width: 200, height: 150 };
  doc.stockThickness = 10;

  // A circle drawn at Sheet position (60, 60), which is (10, 10) relative to the stock blank.
  const circle = doc.add(new CircleEntity({ x: 60, y: 60 }, 5));

  const op: CAMOperation = {
    id: "op1",
    name: "drill",
    type: "drill",
    side: "outside",
    entityIds: [circle.id],
    toolType: "drill",
    toolNumber: 1,
    diameter: 10,
    feedrate: 300,
    plungeRate: 300,
    spindleSpeed: 3000,
    safeZ: 5,
    depth: -5,
    stepdown: 5,
    stepover: 0.4,
  };

  const hm = rasterizeStock([op], doc);
  expect(hm.stockW).toBe(200);
  expect(hm.stockH).toBe(150);

  const res = hm.gridW / hm.stockW;
  // In stock coordinates, the hole center should be at (10, 10) * res
  const expectedStockCenterX = (60 - 50) * res;
  const expectedStockCenterY = (60 - 50) * res;

  const idx = Math.round(expectedStockCenterY) * hm.gridW + Math.round(expectedStockCenterX);
  expect(hm.data[idx]).toBeLessThan(doc.stockThickness - 1e-6);

  // The un-offset sheet position (60, 60) * res should NOT be drilled (it's at stock position 60, not 10)
  const wrongIdx = Math.round(60 * res) * hm.gridW + Math.round(60 * res);
  expect(hm.data[wrongIdx]).toBe(doc.stockThickness);
});

test("3D preview: pocket and profile on positioned stockRect render inside stock boundaries", () => {
  const doc = new CADDocument({ width: 300, height: 250 });
  doc.stockRect = { x: 50, y: 50, width: 200, height: 150 };
  doc.stockThickness = 10;

  // Rect spanning sheet (55, 55) to (95, 95) -> stock (5, 5) to (45, 45)
  const rect = doc.add(new RectEntity({ x: 55, y: 55 }, { x: 95, y: 95 }));

  const pocketOp: CAMOperation = {
    id: "op2",
    name: "pocket",
    type: "pocket",
    side: "inside",
    entityIds: [rect.id],
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 4,
    feedrate: 300,
    plungeRate: 300,
    spindleSpeed: 3000,
    safeZ: 5,
    depth: -3,
    stepdown: 3,
    stepover: 0.4,
  };

  const hm = rasterizeStock([pocketOp], doc);
  const res = hm.gridW / hm.stockW;

  // Center of the pocket in stock coords: (55 + 20 - 50, 55 + 20 - 50) = (25, 25)
  const stockCenterX = 25 * res;
  const stockCenterY = 25 * res;
  const centerIdx = Math.round(stockCenterY) * hm.gridW + Math.round(stockCenterX);
  expect(hm.data[centerIdx]).toBeLessThan(doc.stockThickness - 1e-6);
});
