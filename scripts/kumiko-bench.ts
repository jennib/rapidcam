/**
 * Kumiko cost on the MAIN THREAD, in Node — build vs. commit vs. CAM estimate.
 *
 * The dialog re-probes on a 150ms debounce and calls `kumiko.build()` inline
 * (ui/generatorDialog.ts `reprobe`); Update calls `regenerateFeature()` inline;
 * and the CAM bar then estimates each op by generating its FULL G-code
 * (ui/camBar/opEstimateManager.ts `runOpEstimateChunk`). All three block the
 * main thread, so a slow one is a frozen tab with no repaint.
 *
 * The estimate manager chunks one OP per turn — which buys nothing when a single
 * op is the expensive thing, and kumiko's suggested inside-profile carries one
 * target per opening (1236 at the densest legal panel).
 *
 * Run: npx tsx scripts/kumiko-bench.ts
 */
import { CADDocument } from "../src/model/document";
import { generateGCode } from "../src/cam/gcode";
import { estimateGCodeTime } from "../src/cam/timeEstimate";
import { kumiko } from "../src/generators/kumiko";
import { runGenerator, regenerateFeature } from "../src/generators/index";
import { Sketch } from "../src/generators/sketch";
import { solve } from "../src/solver/solver";

const ms = (t: number) => `${t.toFixed(1)}ms`.padStart(10);

function buildOnly(params: Record<string, number>): number {
  const t = performance.now();
  kumiko.build(new Sketch({ params }));
  return performance.now() - t;
}

function report(label: string, params: Record<string, number>) {
  buildOnly(params);
  const build = buildOnly(params);

  const doc = new CADDocument({ width: 1200, height: 1200 }, "mm");
  doc.stockThickness = 6;

  const t0 = performance.now();
  runGenerator(doc, kumiko, params, { createOps: true });
  const insert = performance.now() - t0;

  const t1 = performance.now();
  solve(doc);
  const solveMs = performance.now() - t1;

  const featureId = doc.features[doc.features.length - 1]?.id;
  const t2 = performance.now();
  if (featureId) regenerateFeature(doc, featureId, { ...params, bar: 2.5 });
  const regen = performance.now() - t2;

  // What opEstimateManager does, per op, in ONE synchronous chunk.
  let gcodeMs = 0;
  let estMs = 0;
  let bytes = 0;
  for (const op of doc.operations) {
    const t3 = performance.now();
    const g = generateGCode([op], doc, {});
    gcodeMs += performance.now() - t3;
    bytes += g.length;
    const t4 = performance.now();
    estimateGCodeTime(g);
    estMs += performance.now() - t4;
  }

  console.log(`\n=== ${label} ===`);
  console.log(`  ${doc.entities.length} entities, ${doc.operations.length} ops, ` +
    `${doc.operations[0]?.entityIds.length ?? 0} targets on op 1`);
  console.log(`  gen.build()      : ${ms(build)}  every debounced keystroke`);
  console.log(`  runGenerator()   : ${ms(insert)}  Insert`);
  console.log(`  regenerateFeat() : ${ms(regen)}  Update`);
  console.log(`  solve()          : ${ms(solveMs)}`);
  console.log(`  generateGCode()  : ${ms(gcodeMs)}  <-- CAM estimate, ONE chunk`);
  console.log(`  estimateGCode()  : ${ms(estMs)}  (${(bytes / 1e6).toFixed(1)} MB of G-code)`);
  console.log(`  WORST BLOCK      : ${ms(Math.max(build, insert, regen, gcodeMs, estMs))}`);
}

report("defaults", {});
report("dense (worst legal panel)", {
  pattern: 0, width: 400, height: 400, pitch: 30, bar: 2, frame: 5,
});
