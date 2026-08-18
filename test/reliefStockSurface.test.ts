/**
 * The stock model must change the MOTION and not the PART.
 *
 * `reliefStockFloor` lets a finish pass skip what roughing already removed. Every
 * way that can go wrong shows up as one of two failures, and a test that checks
 * only one of them passes vacuously:
 *
 * - Skip too much and the finish leaves stock standing — a bump on the part. The
 *   surface assertion catches that.
 * - Skip nothing (the floor comes back blank, the predicate is never consulted,
 *   an exception is swallowed) and the surface is perfect while the feature does
 *   nothing at all. The motion assertion catches that.
 *
 * Both were live risks here: the shipped emitter dropped a measured 279,548 feed
 * moves to 9,401 on a fixture like this one, and a 30x drop is either the whole
 * point or a finish that has stopped cutting. Only rendering the surface tells
 * the two apart, which is why this reads the height field rather than the G-code.
 */
import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { RasterImageEntity } from "../src/model/entities";
import { rasterizeStock } from "../src/cam/stockRasterizer";
import { generateGCode } from "../src/cam/gcode";
import { registerEmbeddedImage } from "../src/core/imageManager";
import type { CAMOperation } from "../src/cam/types";

const W = 120,
  H = 120,
  MM = 40,
  DEPTH = 12,
  STOCK = 20;

/** A dome on a full-depth plinth: bulk for roughing, curvature for finishing. */
function targetDepth(xmm: number, ymm: number): number {
  const r = Math.hypot(xmm - MM / 2, ymm - MM / 2);
  const R = 16;
  if (r > R) return 1;
  return 1 - (Math.sqrt(Math.max(0, R * R - r * r)) / R) * 0.85;
}

function buildDoc(): { doc: CADDocument; entId: string } {
  const bytes: number[] = [];
  for (let py = 0; py < H; py++)
    for (let px = 0; px < W; px++)
      bytes.push(
        Math.round(255 * (1 - targetDepth(((px + 0.5) / W) * MM, ((H - py - 0.5) / H) * MM))),
      );
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  registerEmbeddedImage({ id: "stock-surf", name: "stock-surf", width: W, height: H, data: btoa(bin) });

  const doc = new CADDocument({ width: MM, height: MM });
  doc.stockThickness = STOCK;
  const ent = new RasterImageEntity("stock-surf", { x: 0, y: 0 }, MM, MM, 0);
  doc.add(ent);
  return { doc, entId: ent.id };
}

const roughOp = (entId: string): CAMOperation => ({
  id: "r1", name: "rough", type: "relief-rough", entityIds: [entId], side: "outside",
  toolType: "end-mill", toolNumber: 2, diameter: 6, feedrate: 2000, plungeRate: 500,
  spindleSpeed: 18000, safeZ: 5, depth: -DEPTH, stepdown: 2, stepover: 0.4, finishAllowance: 0.5,
});

const finishOp = (entId: string): CAMOperation => ({
  id: "f1", name: "finish", type: "engrave", entityIds: [entId], side: "outside",
  toolType: "ball-nose", toolNumber: 1, diameter: 3, feedrate: 2000, plungeRate: 500,
  spindleSpeed: 18000, safeZ: 5, depth: -DEPTH, stepdown: 2, stepover: 0.1,
});

const countG1 = (g: string): number => {
  let n = g.startsWith("G1 ") ? 1 : 0;
  for (let i = g.indexOf("\nG1 "); i !== -1; i = g.indexOf("\nG1 ", i + 1)) n++;
  return n;
};

test("a rest-aware finish cuts the MODEL, measured against the model itself", () => {
  const a = buildDoc();
  const withRough = rasterizeStock([roughOp(a.entId), finishOp(a.entId)], a.doc);
  expect(withRough.gridW).toBeGreaterThan(0); // a 0x0 map agrees with anything

  // Absolute, not relative. Comparing this run against a lone-finish run is the
  // obvious test and it is fooled by any fault that hits BOTH runs: seeding the
  // stock floor from the target instead of the blank makes the two agree
  // perfectly while neither cuts the part. Measure against the dome equation.
  const res = withRough.gridW / withRough.stockW;
  let sum = 0;
  let n = 0;
  let worst = 0;
  for (let gy = 0; gy < withRough.gridH; gy++)
    for (let gx = 0; gx < withRough.gridW; gx++) {
      const xmm = (gx + 0.5) / res;
      const ymm = (gy + 0.5) / res;
      if (xmm >= MM || ymm >= MM) continue;
      const want = STOCK - targetDepth(xmm, ymm) * DEPTH;
      const over = withRough.data[gy * withRough.gridW + gx] - want; // >0 = left standing
      sum += Math.abs(over);
      worst = Math.max(worst, over);
      n++;
    }
  expect(n).toBeGreaterThan(1000);
  // Mean measured at 0.127mm when this shipped; the residual is the ⌀3 ball's own
  // 1.5mm fillet in the concave ring where the dome meets the plinth, which no
  // ball-nose can cut sharp. A finish that skipped real stock moves this by mm.
  expect(sum / n).toBeLessThan(0.35);
  // The worst single cell is that fillet (2.105mm measured). Cap it well below
  // one roughing stepdown + allowance (2.5mm), which is what standing rough
  // stock would look like.
  expect(worst).toBeLessThan(2.5);
});

test("...while emitting dramatically less motion — the surface match is not vacuous", () => {
  const a = buildDoc();
  const b = buildDoc();
  // The finish op's OWN motion, with and without a roughing pass ahead of it.
  const paired = generateGCode([roughOp(a.entId), finishOp(a.entId)], a.doc);
  const lone = generateGCode([finishOp(b.entId)], b.doc);

  const roughOnly = generateGCode([roughOp(a.entId)], a.doc);
  const pairedFinishMoves = countG1(paired) - countG1(roughOnly);

  expect(countG1(lone)).toBeGreaterThan(50_000); // the staircase it used to always cut
  // Measured 9,401 vs 279,548 when this shipped. Assert the ORDER, not the number,
  // so a legitimate change to spacing or run-merging doesn't fail this.
  expect(pairedFinishMoves).toBeLessThan(countG1(lone) / 5);
  expect(pairedFinishMoves).toBeGreaterThan(1000); // but it must still be cutting
});

test("with no roughing ahead of it the floor is the uncut blank, so nothing is skipped", () => {
  // Generated ONCE. An earlier draft posted this program three times to also
  // check determinism, which pushed the file past the 30s timeout under parallel
  // load — a benchmark with an assertion on it, and the config comment says not
  // to write one. Determinism is not what is at risk here anyway; the staircase
  // is.
  const a = buildDoc();
  const lone = generateGCode([finishOp(a.entId)], a.doc);

  // The unconditional staircase, still unconditional: with no prior op the stock
  // floor is the uncut blank, so every pass runs and nothing is skipped. If the
  // floor were seeded from the target instead, this collapses to one pass.
  const passes = Math.ceil(DEPTH / 2);
  const approaches = lone.split(/\r?\n/).filter((l) => l.startsWith("G0 Z")).length;
  expect(approaches).toBeGreaterThan(passes);
  expect(countG1(lone)).toBeGreaterThan(50_000);
});
