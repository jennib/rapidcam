/**
 * Look at the steep/shallow mask before believing any test about it.
 *
 * The rest-machining work found its worst bug by rendering rather than by
 * asserting (a probe sized on the wrong tool's stepover made every feature
 * narrower than 2.4 mm invisible, and only an ASCII picture showed it). The mask
 * here is a per-cell predicate over a gradient — precisely the kind of thing
 * that can be confidently wrong in a way aggregates hide — so it gets drawn.
 *
 * Run: npx tsx scripts/steep-split-probe.ts
 */
import { rasterField, type RasterField } from "../src/cam/rasterEngrave";
import { toolContactField } from "../src/cam/toolProfile";
import { steepSplit } from "../src/cam/steep";
import type { CAMOperation } from "../src/cam/types";

const DEPTH = 10; // mm of Z range in the height map
const SIZE = 64; // mm square
// Source pixels per mm. The field is RESAMPLED to the raster grid, so a source
// coarser than the stepover turns a smooth flank into a staircase of treads and
// risers — and the mask then reads the risers as steep and the treads as flat.
// PXMM=0 pins it to one pixel per cell, which isolates the algorithm from that.
const PXMM = Number(process.env.PXMM ?? 0);
const STEPOVER = Number(process.env.STEPOVER ?? 2); // coarse by default so the ASCII grid is readable

/** A height map as a `RasterField`, straight from a height function (mm above the floor). */
function fieldOf(height: (x: number, y: number) => number): RasterField {
  const N = Math.round(SIZE * (PXMM > 0 ? PXMM : 1 / STEPOVER));
  const data = new Float32Array(N * N);
  for (let py = 0; py < N; py++)
    for (let px = 0; px < N; px++) {
      // Row 0 is the TOP of the image; encode top-of-model = 1 (white = no cut).
      const x = ((px + 0.5) * SIZE) / N;
      const y = SIZE - ((py + 0.5) * SIZE) / N;
      data[py * N + px] = Math.min(1, Math.max(0, height(x, y) / DEPTH));
    }
  return rasterField(
    { width: N, height: N, data },
    {
      widthMM: SIZE,
      heightMM: SIZE,
      lineIntervalMM: STEPOVER,
      dotPitchMM: STEPOVER,
      whiteThreshold: 1.01,
      // The real path is 8-bit (`DEFAULT_LEVEL_STEP`); LEVELSTEP=4096 asks what
      // the quantisation itself costs the mask.
      levelStep: 1 / Number(process.env.LEVELSTEP ?? 255),
    },
  );
}

const op = (over: Partial<CAMOperation> = {}): CAMOperation =>
  ({
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
    rasterLineInterval: STEPOVER,
    rasterDotPitch: STEPOVER,
    reliefSteepPass: true,
    ...over,
  }) as CAMOperation;

/** Draw the mask over the depth field: `#` steep, shading for the shallow depth. */
function draw(name: string, height: (x: number, y: number) => number): void {
  const field = fieldOf(height);
  const contact = toolContactField(field, op(), DEPTH);
  const split = steepSplit(contact, op(), DEPTH);
  const { cols, rows } = contact;
  const shade = " .:-=+*%@";

  console.log(`\n=== ${name} ===`);
  if (split.kind !== "split") {
    console.log(`  (${split.kind})`);
    return;
  }
  // QUIET=1 skips the pictures and reports path LENGTHS instead — the number
  // that says whether a real stepover fragments the contours into stubs.
  if (process.env.QUIET) {
    const len = (p: (typeof split.paths)[number]): number => {
      let L = 0;
      for (let i = 1; i < p.pts.length; i++)
        L += Math.hypot(p.pts[i].x - p.pts[i - 1].x, p.pts[i].y - p.pts[i - 1].y);
      return L;
    };
    const lens = split.paths.map(len).sort((a, b) => a - b);
    console.log(
      `  steep ${((100 * split.cells) / split.total).toFixed(1)}% · ${split.paths.length} contours · ` +
        `${split.paths.filter((p) => p.closed).length} closed · mm min ${lens[0].toFixed(1)} ` +
        `median ${lens[lens.length >> 1].toFixed(1)} max ${lens[lens.length - 1].toFixed(1)} · ` +
        `under 1mm: ${lens.filter((l) => l < 1).length}`,
    );
    return;
  }
  // Top row of the picture is the TOP of the image, so walk rows backwards.
  for (let r = rows.length - 1; r >= 0; r--) {
    let line = "";
    for (let c = 0; c < cols; c++) {
      if (split.steep(r, c)) line += "#";
      else {
        const lv = rows[r].levels[c];
        line += shade[Math.min(shade.length - 1, Math.round(lv * (shade.length - 1)))];
      }
    }
    console.log(`  ${line}`);
  }
  const pct = ((100 * split.cells) / split.total).toFixed(1);
  console.log(
    `  steep ${split.cells}/${split.total} (${pct}%) · ${split.paths.length} contours ` +
      `at ${split.zStep}mm · ${split.paths.filter((p) => p.closed).length} closed`,
  );

  // The same picture again, but showing where the CONTOURS actually go: the mask
  // is only half the claim, and a mask with no path through it finishes nothing.
  const hit = new Set<number>();
  for (const p of split.paths)
    for (const pt of p.pts) {
      const c = Math.min(cols - 1, Math.max(0, Math.round(pt.x / contact.colPitch - 0.5)));
      const r = Math.min(rows.length - 1, Math.max(0, Math.round(pt.y / contact.rowPitch - 0.5)));
      hit.add(r * cols + c);
    }
  console.log("  --- contour coverage (o = a path passes here) ---");
  for (let r = rows.length - 1; r >= 0; r--) {
    let line = "";
    for (let c = 0; c < cols; c++)
      line += hit.has(r * cols + c) ? "o" : split.steep(r, c) ? "#" : " ";
    console.log(`  ${line}`);
  }

  // Every contour point must lie ON the contact surface at its own level, or the
  // "an iso-contour of the contact field IS the tool-centre path" claim is empty.
  // Bilinear, not nearest-node: the point sits on a grid EDGE, where the field
  // changes by slope × pitch — which on a vertical wall is the whole depth.
  const bilinear = (x: number, y: number): number => {
    const fc = Math.min(cols - 1.001, Math.max(0, x / contact.colPitch - 0.5));
    const fr = Math.min(rows.length - 1.001, Math.max(0, y / contact.rowPitch - 0.5));
    const c0 = Math.floor(fc);
    const r0 = Math.floor(fr);
    const tx = fc - c0;
    const ty = fr - r0;
    const z = (r: number, c: number) => -rows[r].levels[c] * DEPTH;
    return (
      z(r0, c0) * (1 - tx) * (1 - ty) +
      z(r0, c0 + 1) * tx * (1 - ty) +
      z(r0 + 1, c0) * (1 - tx) * ty +
      z(r0 + 1, c0 + 1) * tx * ty
    );
  };
  let worst = 0;
  for (const p of split.paths)
    for (const pt of p.pts) worst = Math.max(worst, Math.abs(bilinear(pt.x, pt.y) - p.z));
  console.log(`  worst |contactZ - pathZ| over every path point: ${worst.toExponential(1)}mm`);
}

const mid = SIZE / 2;

// A cone at a CONSTANT slope, in every direction at once. 10mm over a 28mm
// radius is 19.6° and must come back "none" — the raster finishes that better
// than contours would, and a mask that fires on it would be re-cutting a
// finished surface. 10mm over 8mm is 51° and must not.
draw("cone (r=28, h=10 — 20°, shallow everywhere)", (x, y) => {
  const r = Math.hypot(x - mid, y - mid);
  return Math.max(0, DEPTH * (1 - r / 28));
});
draw("cone (r=8, h=10 — 51°)", (x, y) => {
  const r = Math.hypot(x - mid, y - mid);
  return Math.max(0, DEPTH * (1 - r / 8));
});

// A hemisphere on a plinth: shallow at the pole, vertical at the equator.
draw("dome (R=28)", (x, y) => {
  const r = Math.hypot(x - mid, y - mid);
  return r < 28 ? (DEPTH * Math.sqrt(28 * 28 - r * r)) / 28 : 0;
});

// Two walls of the SAME steepness, one running across the scan rows and one
// along them. The whole anisotropy claim is visible in this one picture: the
// raster finishes the second perfectly and must not give it away.
draw("wall across the rows (rises in y)", (_x, y) => (y > mid ? DEPTH : 0));
draw("wall along the rows (rises in x)", (x) => (x > mid ? DEPTH : 0));

// A shallow dome — nothing anywhere is steeper than the raster can finish, so
// the honest answer is "none", not a sprinkling of cells.
draw("shallow dome (R=28, h=2)", (x, y) => {
  const r = Math.hypot(x - mid, y - mid);
  return r < 28 ? (2 * Math.sqrt(28 * 28 - r * r)) / 28 : 0;
});
