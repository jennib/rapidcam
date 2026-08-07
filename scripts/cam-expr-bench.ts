/**
 * Cost of re-evaluating CAM `paramExprs` on the DRAG path.
 *
 * `runSolve()` calls `evaluateAll()` unconditionally, including for the pinned
 * drag solves that run every frame — so every formula on every operation is
 * re-parsed and re-evaluated at frame rate. This measures whether that matters
 * before anyone optimises it on a hunch.
 *
 * Run: npx tsx scripts/cam-expr-bench.ts
 */
import { CADDocument } from "../src/model/document";
import { evaluateAll, makeVariable } from "../src/model/variables";
import type { CAMOperation } from "../src/cam/types";

function docWith(ops: number, exprsPerOp: number): CADDocument {
  const doc = new CADDocument({ width: 600, height: 400 }, "mm");
  doc.stockThickness = 12;
  doc.addVariable(makeVariable("baseFeed", "1000", "mm"));
  doc.addVariable(makeVariable("factor", "1.2", "mm"));

  const exprs: Record<string, string>[] = [
    { depth: "-stock" },
    { depth: "-stock", feedrate: "baseFeed * factor" },
    { depth: "-stock", feedrate: "baseFeed * factor", stepdown: "stock / 4" },
    {
      depth: "-stock",
      feedrate: "baseFeed * factor",
      stepdown: "stock / 4",
      plungeRate: "baseFeed / 3",
    },
  ];

  for (let i = 0; i < ops; i++) {
    doc.operations.push({
      id: `op${i}`,
      name: `Op ${i}`,
      type: "profile",
      entityIds: [],
      side: "outside",
      toolType: "end-mill",
      toolNumber: 1,
      diameter: 6,
      feedrate: 1000,
      plungeRate: 300,
      spindleSpeed: 18000,
      safeZ: 5,
      depth: -5,
      stepdown: 1.5,
      stepover: 0.4,
      paramExprs: { ...exprs[Math.min(exprsPerOp, exprs.length) - 1] },
    } as CAMOperation);
  }
  return doc;
}

function bench(label: string, doc: CADDocument, frames: number): void {
  // Warm up so we time steady-state, not first-parse.
  for (let i = 0; i < 200; i++)
    evaluateAll(doc.variables, doc.dimensions, doc.displayUnit, doc.stockThickness, doc.operations);

  const t0 = performance.now();
  for (let i = 0; i < frames; i++)
    evaluateAll(doc.variables, doc.dimensions, doc.displayUnit, doc.stockThickness, doc.operations);
  const ms = performance.now() - t0;

  const perFrame = ms / frames;
  const budget = (perFrame / 16.7) * 100; // share of a 60fps frame
  console.log(
    `${label.padEnd(34)} ${perFrame.toFixed(4)} ms/frame   ${budget.toFixed(2)}% of a 16.7ms frame`,
  );
}

const FRAMES = 2000;
console.log(`\nevaluateAll() cost per drag frame (${FRAMES} frames each)\n`);
bench("no operations at all", docWith(0, 1), FRAMES);
bench("5 ops x 1 expr", docWith(5, 1), FRAMES);
bench("20 ops x 3 exprs", docWith(20, 3), FRAMES);
bench("50 ops x 4 exprs (heavy)", docWith(50, 4), FRAMES);
bench("200 ops x 4 exprs (absurd)", docWith(200, 4), FRAMES);
console.log("");
