/**
 * What does the tool-footprint correction actually cost?
 *
 * The footprint is O(R²) cells and the field is O(n), so a plain sweep is the
 * obvious trap. `toolContactField` prices the profile once per offset and stops
 * each cell's sweep as soon as a box-min bound says nothing left can improve it,
 * which is meant to make smooth fields (i.e. photo reliefs) nearly free and only
 * charge full price where the field has hard edges.
 *
 * This measures that claim on real field sizes rather than arguing about it.
 * Wall clock here is a probe, not a test assertion — the committed guard is the
 * `Math.hypot` call count in test/toolProfile.test.ts.
 *
 * Run: npx tsx scripts/relief-dilation-cost.ts
 */
import { rasterField, type RasterGrid } from "../src/cam/rasterEngrave";
import { toolContactField } from "../src/cam/toolProfile";
import type { CAMOperation } from "../src/cam/types";

const op = (diameter: number): CAMOperation => ({
  id: "o", name: "relief", type: "engrave", entityIds: [], side: "outside",
  toolType: "ball-nose", toolNumber: 1, diameter, feedrate: 1500, plungeRate: 300,
  spindleSpeed: 18000, safeZ: 5, depth: -3, stepdown: 3, stepover: 0.4,
});

/** A source image of `px`² pixels under one of three characters. */
function source(px: number, kind: "photo" | "logo" | "noise"): RasterGrid {
  const data = new Float32Array(px * px);
  for (let y = 0; y < px; y++)
    for (let x = 0; x < px; x++) {
      const u = x / px,
        v = y / px;
      data[y * px + x] =
        kind === "photo"
          ? // smooth, the way a portrait relief is: a couple of soft lobes
            0.5 + 0.35 * Math.sin(u * 6) * Math.cos(v * 5) + 0.1 * Math.sin(u * 19)
          : kind === "logo"
            ? // hard edges — the case that was gouging by 2.905mm
              (x % 64 < 28 && y % 64 < 28) || (x % 97 < 40 && y % 53 < 22)
              ? 0
              : 1
            : // pathological: full swing every pixel
              ((x * 37 + y * 11) % 256) / 255;
    }
  return { width: px, height: px, data };
}

const MS = () => Number(process.hrtime.bigint() / 1000n) / 1000;

console.log("field            tool   cells    R(cells)  photo    logo     noise");
for (const [mm, pitch, dia] of [
  [150, 0.48, 6], // ⌀6 at Vectric's 8% finish stepover — the sane setup
  [100, 0.2, 3], // ⌀3 at 0.2mm — a fine photo relief
  [100, 0.1, 3], // ⌀3 at 0.1mm — the default line interval, 1M cells
  [100, 0.1, 6], // ⌀6 at 0.1mm — 1.7% of diameter; nobody should, but they can
] as const) {
  const px = Math.round(mm / pitch);
  const times: number[] = [];
  for (const kind of ["photo", "logo", "noise"] as const) {
    const f = rasterField(source(px, kind), {
      widthMM: mm,
      heightMM: mm,
      lineIntervalMM: pitch,
      dotPitchMM: pitch,
    });
    toolContactField(f, op(dia), 3); // warm
    const t0 = MS();
    toolContactField(f, op(dia), 3);
    times.push(MS() - t0);
  }
  const cells = px * px;
  console.log(
    `${`${mm}mm @ ${pitch}`.padEnd(17)}⌀${String(dia).padEnd(6)}${(cells / 1e6).toFixed(2)}M   ` +
      `${String(Math.round(dia / 2 / pitch + 0.5)).padEnd(10)}` +
      times.map((t) => `${t.toFixed(0)}ms`.padEnd(9)).join(""),
  );
}
