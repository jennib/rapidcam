/**
 * Does the shipped relief path gouge? Measure, don't argue.
 *
 * `reliefImage` point-samples: Z = -level(x) * depth (gcode.ts:1365). A ball of
 * radius R sitting at that Z has its FLANK at z + (R - sqrt(R^2 - d^2)) at
 * horizontal offset d. Material that should survive at that offset is at
 * -level(x+d) * depth. So the tool eats material whenever
 *
 *     (level(x) - level(x+d)) * depth  >  R - sqrt(R^2 - d^2)
 *
 * A hard edge (level 1 beside level 0) makes the left side the full depth and
 * the right side almost nothing. This measures the worst overcut on exactly
 * that field — a black square on white, i.e. any logo or rasterised text.
 *
 * Run: npx tsx scripts/_probe-gouge.ts
 */
import { generateGCode } from "../src/cam/gcode";
import { registerEmbeddedImage } from "../src/core/imageManager";
import type { CAMOperation } from "../src/cam/types";
import { CADDocument } from "../src/model/document";
import { RasterImageEntity } from "../src/model/entities";

const DEPTH = 3; // mm
const TOOL_D = 3; // mm ball-nose
const R = TOOL_D / 2;
const MM = 16; // image is 16x16 px over 16x16 mm -> 1 px per mm

/** Half black (deep), half white (surface): one vertical wall down the middle. */
function halfBlack(): string {
  const rows: number[][] = [];
  for (let y = 0; y < MM; y++) {
    const r: number[] = [];
    for (let x = 0; x < MM; x++) r.push(x < MM / 2 ? 0 : 255); // 0 = black = deepest
    rows.push(r);
  }
  const id = "img-gouge";
  registerEmbeddedImage({
    id,
    name: id,
    width: MM,
    height: MM,
    data: btoa(String.fromCharCode(...rows.flat())),
  });
  return id;
}

const op = (entityIds: string[]): CAMOperation => ({
  id: "r1",
  name: "relief",
  type: "engrave",
  entityIds,
  side: "outside",
  toolType: "ball-nose",
  toolNumber: 1,
  diameter: TOOL_D,
  feedrate: 1500,
  plungeRate: 300,
  spindleSpeed: 18000,
  safeZ: 5,
  depth: -DEPTH,
  stepdown: DEPTH,
  stepover: 0.4,
  rasterLineInterval: 1,
  rasterDotPitch: 1,
});

const id = halfBlack();
const doc = new CADDocument({ width: 100, height: 100 });
doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, MM, MM, 0));
const entId = doc.entities.find((e) => e.type === "image")!.id;
const g = generateGCode([op([entId])], doc);

const moves = [...g.matchAll(/G1 X(-?[\d.]+) Y(-?[\d.]+) Z(-?[\d.]+)/g)].map((m) => ({
  x: +m[1],
  y: +m[2],
  z: +m[3],
}));

/** Desired surface: black half at -DEPTH, white half at 0. */
const surfaceAt = (x: number) => (x < MM / 2 ? -DEPTH : 0);

// For every commanded position, sweep the ball's flank across the field and find
// the worst amount by which it dips BELOW the surface that should survive.
let worst = 0;
let worstAt = { x: 0, d: 0 };
for (const m of moves) {
  for (let d = 0; d <= R; d += R / 40) {
    const flank = m.z + (R - Math.sqrt(Math.max(0, R * R - d * d)));
    for (const side of [-1, 1]) {
      const px = m.x + side * d;
      if (px < 0 || px > MM) continue;
      const overcut = surfaceAt(px) - flank; // >0 = tool is below material that should stay
      if (overcut > worst) {
        worst = overcut;
        worstAt = { x: m.x, d: side * d };
      }
    }
  }
}

console.log(`relief depth      : ${DEPTH} mm`);
console.log(`ball-nose         : d${TOOL_D} (R=${R})`);
console.log(`commanded Z moves : ${moves.length}`);
console.log(`WORST OVERCUT     : ${worst.toFixed(3)} mm`);
console.log(`  at tool x=${worstAt.x.toFixed(2)}, flank offset ${worstAt.d.toFixed(2)} mm`);
console.log(
  worst > 0.05
    ? "\n=> GOUGES. The flank cuts material the centre-point sample said was clear."
    : "\n=> no meaningful overcut",
);
