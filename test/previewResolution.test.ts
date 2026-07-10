import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { rasterizeStock } from "../src/cam/stockRasterizer";

/**
 * Guards the preview raster's adaptive resolution (stockRasterizer.ts). Cut
 * walls read cleanly only when the height field is fine enough; the rasterizer
 * targets 4 cells/mm but steps down toward the historical 2 so a huge stock
 * never allocates an unbounded grid. These assert the grid dimensions the 3D
 * preview mesh is built from — no GPU required.
 */
const MAX_CELLS = 4_000_000;

function gridFor(mm: number) {
  const doc = new CADDocument({ width: mm, height: mm });
  doc.stockThickness = 12;
  const hm = rasterizeStock([], doc);
  return hm;
}

test("typical stock rasterizes at the full 4 cells/mm", () => {
  const hm = gridFor(120);
  expect(hm.gridW).toBe(480); // ceil(120 * 4)
  expect(hm.gridH).toBe(480);
});

test("mid-size stock steps down to 3 cells/mm to stay under budget", () => {
  const hm = gridFor(600);
  expect(hm.gridW).toBe(1800); // ceil(600 * 3); 4 cells/mm would exceed the budget
  expect(hm.gridW * hm.gridH).toBeLessThanOrEqual(MAX_CELLS);
});

test("huge stock never drops below the historical 2 cells/mm", () => {
  const hm = gridFor(2000);
  expect(hm.gridW).toBe(4000); // floored at 2 cells/mm — never coarser than before
});
