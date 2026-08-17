/**
 * What the steep/shallow pass COSTS, on a model big enough to hurt.
 *
 * Sibling of `scripts/relief-dilation-cost.ts`. The pass runs at op time on the
 * UI thread — `reliefImage` posts through it and `rasRelief` previews through it
 * — so its cost is a freeze the user feels, not a batch job.
 *
 * ## Run it BUNDLED, or the answer is wrong by 2.4×
 *
 *     npx esbuild scripts/steep-cost.ts --bundle --platform=node \
 *       --format=esm --outfile=.tmp/cost.mjs && node .tmp/cost.mjs
 *
 * Under `npx tsx` this reports 12.5 s where the shipped bundle takes 5.1 s. The
 * loader's own `__name` wrappers and TextDecoder work are 35% of the profile,
 * and they are attributed to `steep.ts` because that is the file being
 * instrumented. Measuring through tsx made a 1.7× optimisation read as 1.1×,
 * which is how it nearly got discarded as not worth the code.
 *
 * `S=0.15 node .tmp/cost.mjs` overrides the stepover.
 */

import { rasterField } from "../src/cam/rasterEngrave";
import { steepSplit } from "../src/cam/steep";
import { toolContactField } from "../src/cam/toolProfile";
import type { CAMOperation } from "../src/cam/types";

const DEPTH = 20;
const MM = 200;
const S = Number(process.env.S ?? 0.15);
const N = Math.round(MM / S);

// Lumpy on purpose: the cost is driven by how many contours come out, and a
// smooth dome yields a handful of rings where a real carving yields thousands.
// This shape is ~63% steep, which is about as bad as a relief gets before it
// stops being a relief at all (see plinthRatio, Phase 1.5).
const height = (x: number, y: number): number =>
  Math.max(
    0,
    Math.min(DEPTH, DEPTH / 2 + 8 * Math.sin(x / 7) * Math.cos(y / 6) + 4 * Math.sin(x / 2.5)),
  );

const data = new Float32Array(N * N);
for (let py = 0; py < N; py++)
  for (let px = 0; px < N; px++) {
    const x = ((px + 0.5) * MM) / N;
    const y = MM - ((py + 0.5) * MM) / N;
    data[py * N + px] = Math.min(1, Math.max(0, height(x, y) / DEPTH));
  }

const op = {
  id: "s",
  name: "steep",
  type: "engrave",
  entityIds: ["e"],
  side: "outside",
  toolType: "ball-nose",
  toolNumber: 1,
  diameter: 3,
  feedrate: 1500,
  plungeRate: 300,
  spindleSpeed: 18000,
  safeZ: 5,
  depth: -DEPTH,
  stepdown: DEPTH,
  stepover: 0.4,
  rasterLineInterval: S,
  rasterDotPitch: S,
  reliefSteepPass: true,
} as unknown as CAMOperation;

console.log(
  `${MM}×${MM}mm, ${DEPTH}mm deep, ${S}mm stepover → ${N}×${N} = ` +
    `${(((N * N) / 1e6) as number).toFixed(1)}M cells, ${Math.floor(DEPTH / S)} levels`,
);

let t = Date.now();
const field = rasterField(
  { width: N, height: N, data },
  { widthMM: MM, heightMM: MM, lineIntervalMM: S, dotPitchMM: S, whiteThreshold: 1.01 },
);
console.log(`  rasterField       ${String(Date.now() - t).padStart(6)}ms`);

t = Date.now();
const contact = toolContactField(field, op, DEPTH);
console.log(`  toolContactField  ${String(Date.now() - t).padStart(6)}ms`);

t = Date.now();
const split = steepSplit(contact, op, DEPTH);
const ms = Date.now() - t;
console.log(`  steepSplit        ${String(ms).padStart(6)}ms`);

if (split.kind === "split") {
  let pts = 0;
  for (const p of split.paths) pts += p.pts.length;
  console.log(
    `  → ${((100 * split.cells) / split.total).toFixed(1)}% steep · ` +
      `${split.paths.length} contours · ${pts} points · ${((1000 * ms) / pts).toFixed(2)}µs/point`,
  );
} else {
  console.log(`  → ${split.kind}`);
}
