/**
 * Does the stock model actually save feed? Measure the finish pass before (no
 * roughing op ahead — the old staircase from the stock top) and after (a ⌀12
 * rough ahead) on a 60×60 mm relief, 20 mm deep: a radial dome with two 5 mm
 * channels cut to full depth, which the ⌀12 flat cannot enter.
 *
 * Run: npx tsx scripts/relief-stock-probe.ts
 */
import { CADDocument } from "../src/model/document";
import { RasterImageEntity } from "../src/model/entities";
import { generateGCode } from "../src/cam/gcode";
import { registerEmbeddedImage } from "../src/core/imageManager";
import type { CAMOperation } from "../src/cam/types";

const MM = 60;
const DEPTH = 20;
const PX = 120; // 0.5 mm/pixel

// Radial dome (apex at the centre = surface; full depth at the rim), with two
// 5 mm channels across the middle forced to full depth.
const bytes = new Uint8Array(PX * PX);
for (let py = 0; py < PX; py++)
  for (let px = 0; px < PX; px++) {
    const x = ((px + 0.5) * MM) / PX;
    const y = MM - ((py + 0.5) * MM) / PX;
    const dx = (x - MM / 2) / (MM / 2);
    const dy = (y - MM / 2) / (MM / 2);
    let level = Math.min(1, Math.sqrt(dx * dx + dy * dy));
    if (Math.abs(x - MM / 2) < 2.5 || Math.abs(y - MM / 2) < 2.5) level = 1;
    bytes[py * PX + px] = Math.round(255 * (1 - level));
  }

registerEmbeddedImage({
  id: "probe",
  name: "probe",
  width: PX,
  height: PX,
  data: btoa(String.fromCharCode(...bytes)),
});

const doc = new CADDocument({ width: MM + 20, height: MM + 20 });
doc.add(new RasterImageEntity("probe", { x: 10, y: 10 }, MM, MM, 0));
const entId = doc.entities.find((e) => e.type === "image")!.id;

const rough: CAMOperation = {
  id: "rr",
  name: "Rough",
  type: "relief-rough",
  entityIds: [entId],
  side: "outside",
  toolType: "end-mill",
  toolNumber: 1,
  diameter: 12,
  feedrate: 2000,
  plungeRate: 500,
  spindleSpeed: 18000,
  safeZ: 5,
  depth: -DEPTH,
  stepdown: 3,
  stepover: 0.4, // pitch = 4.8 mm
  finishAllowance: 0.5,
};

function finishOp(): CAMOperation {
  return {
    id: "rf",
    name: "Finish",
    type: "engrave",
    entityIds: [entId],
    side: "outside",
    toolType: "ball-nose",
    toolNumber: 2,
    diameter: 3,
    feedrate: 2000,
    plungeRate: 500,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -DEPTH,
    stepdown: 1,
    stepover: 0.4,
    rasterLineInterval: 0.3,
    rasterDotPitch: 0.3,
  };
}

/** Lateral G1 feed travel, mm — G0 rapids update position but add no feed. */
function feedMM(g: string): number {
  let x = 0;
  let y = 0;
  let d = 0;
  for (const line of g.split("\n")) {
    const m = /^G([01])\b.*?X(-?[\d.]+) Y(-?[\d.]+)/.exec(line);
    if (!m) continue;
    const nx = +m[2];
    const ny = +m[3];
    if (m[1] === "1") d += Math.hypot(nx - x, ny - y);
    x = nx;
    y = ny;
  }
  return d;
}

function report(label: string, g: string): void {
  const zs = [...g.matchAll(/G1 .* Z(-?[\d.]+)/g)].map((m) => +m[1]).filter((z) => z < -1e-9);
  const distinct = new Set(zs.map((z) => Math.round(z * 100) / 100));
  let deepest = 0;
  for (const z of zs) if (z < deepest) deepest = z;
  console.log(
    `${label.padEnd(24)} feed ${(feedMM(g) / 1000).toFixed(1)}m · ` +
      `${zs.length} cut moves · ${distinct.size} distinct depths · deepest ${deepest}mm`,
  );
}

const before = generateGCode([finishOp()], doc);
const after = generateGCode([rough, finishOp()], doc);

// The finish half of the paired program, after the last tool change.
const cut = after.indexOf("Manual tool change to T2");
const afterFinish = cut >= 0 ? after.slice(cut) : after;

console.log("60×60mm dome + two 5mm channels, 20mm deep; ⌀12 rough (3mm steps, 0.5mm allowance), ⌀3 finish (0.3mm rows, 1mm stepdown)\n");
report("finish, no rough (old)", before);
report("finish, after rough", afterFinish);
const header = afterFinish.match(/; after [^\n]+/);
if (header) console.log(`\n${header[0]}`);
