import { test, expect } from "vitest";
import { rasterField, type RasterField } from "../src/cam/rasterEngrave";
import { toolContactField } from "../src/cam/toolProfile";
import { steepSplit } from "../src/cam/steep";
import type { CAMOperation } from "../src/cam/types";

/**
 * The steep/shallow split. Everything here is checked against a height function
 * with a KNOWN slope, because the whole claim of the module is that the
 * threshold is derived from geometry rather than tuned — which is only worth
 * anything if the geometry it derives is the geometry that is there.
 *
 * `scripts/steep-split-probe.ts` draws these same shapes; the numbers below were
 * read off those pictures, not the other way round.
 */

const DEPTH = 10;
const SIZE = 64; // mm square

/** A height map sampled one pixel per raster cell (mm above the base). */
function fieldOf(height: (x: number, y: number) => number, stepover: number): RasterField {
  const n = Math.round(SIZE / stepover);
  const data = new Float32Array(n * n);
  for (let py = 0; py < n; py++)
    for (let px = 0; px < n; px++) {
      const x = ((px + 0.5) * SIZE) / n;
      const y = SIZE - ((py + 0.5) * SIZE) / n; // row 0 is the image TOP
      data[py * n + px] = Math.min(1, Math.max(0, height(x, y) / DEPTH));
    }
  return rasterField(
    { width: n, height: n, data },
    {
      widthMM: SIZE,
      heightMM: SIZE,
      lineIntervalMM: stepover,
      dotPitchMM: stepover,
      whiteThreshold: 1.01, // a height map, not a photo — see reliefEncoding
    },
  );
}

function op(over: Partial<CAMOperation> = {}): CAMOperation {
  return {
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
    reliefSteepPass: true,
    ...over,
  } as CAMOperation;
}

function split(
  height: (x: number, y: number) => number,
  stepover = 1,
  over: Partial<CAMOperation> = {},
) {
  const o = op({ rasterLineInterval: stepover, rasterDotPitch: stepover, ...over });
  const field = fieldOf(height, stepover);
  return steepSplit(toolContactField(field, o, DEPTH), o, DEPTH);
}

const mid = SIZE / 2;
/** A cone of the given flank slope, centred, apex at DEPTH. */
const cone = (slope: number) => (x: number, y: number) =>
  Math.max(0, DEPTH - slope * Math.hypot(x - mid, y - mid));

// --- the threshold ----------------------------------------------------------

test("the split is at 45°, and it is derived rather than declared", () => {
  // A cone at a constant flank slope, so the answer is the same everywhere on
  // it and there is no boundary to hide behind. 40° must be left to the raster
  // and 50° must not — 5° either side of a threshold nothing in the code names.
  expect(split(cone(Math.tan((40 * Math.PI) / 180))).kind).toBe("none");
  const steep = split(cone(Math.tan((50 * Math.PI) / 180)));
  expect(steep.kind).toBe("split");
});

test("a flat field and a shallow dome ask for nothing", () => {
  expect(split(() => 5).kind).toBe("none");
  expect(
    split((x, y) => {
      const r = Math.hypot(x - mid, y - mid);
      return r < 28 ? (2 * Math.sqrt(784 - r * r)) / 28 : 0; // 2mm over 28mm
    }).kind,
  ).toBe("none");
});

test("the split moves with the stepover, because that is what sets it", () => {
  // The Z spacing IS the stepover, so halving the stepover halves the contour
  // spacing — twice as many levels through the same wall. If the spacing were a
  // constant, this would not move.
  const wall = (_x: number, y: number) => (y > mid ? DEPTH : 0);
  const coarse = split(wall, 2);
  const fine = split(wall, 1);
  if (coarse.kind !== "split" || fine.kind !== "split") throw new Error("expected splits");
  expect(coarse.zStep).toBeCloseTo(2, 6);
  expect(fine.zStep).toBeCloseTo(1, 6);
  expect(fine.paths.length).toBeGreaterThan(coarse.paths.length);
});

test("off by default, and off it is genuinely off", () => {
  expect(split(cone(2), 1, { reliefSteepPass: undefined }).kind).toBe("off");
  expect(split(cone(2), 1, { reliefSteepPass: false }).kind).toBe("off");
  // Positive control: the same shape with it on is a split, so "off" above is
  // the flag and not the geometry.
  expect(split(cone(2), 1, { reliefSteepPass: true }).kind).toBe("split");
});

test("a halftone is screened out — a groove screen has no surface to contour", () => {
  expect(
    split(cone(2), 1, { toolType: "v-bit", vAngle: 60, halftone: true }).kind,
  ).toBe("off");
  // Positive control: the same V-bit WITHOUT halftoning still splits.
  expect(split(cone(2), 1, { toolType: "v-bit", vAngle: 60 }).kind).toBe("split");
});

// --- the contours -----------------------------------------------------------

test("every contour point lies ON the contact surface at its own level", () => {
  // The claim that makes offsetting unnecessary: an iso-contour of the field the
  // TIP may ride at already is the tool-centre path. If that is not exact, the
  // pass is cutting at some other depth than it says.
  const stepover = 1;
  const o = op({ rasterLineInterval: stepover, rasterDotPitch: stepover });
  const contact = toolContactField(fieldOf(cone(2), stepover), o, DEPTH);
  const s = steepSplit(contact, o, DEPTH);
  if (s.kind !== "split") throw new Error("expected a split");

  const { cols, colPitch, rowPitch, rows } = contact;
  const zAt = (r: number, c: number) => -rows[r].levels[c] * DEPTH;
  const bilinear = (x: number, y: number): number => {
    const fc = Math.min(cols - 1.0001, Math.max(0, x / colPitch - 0.5));
    const fr = Math.min(rows.length - 1.0001, Math.max(0, y / rowPitch - 0.5));
    const c0 = Math.floor(fc);
    const r0 = Math.floor(fr);
    const tx = fc - c0;
    const ty = fr - r0;
    return (
      zAt(r0, c0) * (1 - tx) * (1 - ty) +
      zAt(r0, c0 + 1) * tx * (1 - ty) +
      zAt(r0 + 1, c0) * (1 - tx) * ty +
      zAt(r0 + 1, c0 + 1) * tx * ty
    );
  };
  let worst = 0;
  let points = 0;
  for (const p of s.paths)
    for (const pt of p.pts) {
      worst = Math.max(worst, Math.abs(bilinear(pt.x, pt.y) - p.z));
      points++;
    }
  expect(points).toBeGreaterThan(100); // the check actually ran on something
  expect(worst).toBeLessThan(1e-9);
});

test("a cone's contours are closed rings at every level, shallow to deep", () => {
  const s = split(cone(2));
  if (s.kind !== "split") throw new Error("expected a split");
  expect(s.paths.length).toBeGreaterThan(3);
  for (const p of s.paths) {
    expect(p.closed).toBe(true);
    expect(p.pts[0]).toEqual(p.pts[p.pts.length - 1]);
  }
  // Top down — the plunge safety argument depends on the order, so it is an
  // assertion rather than a coincidence of the loop that produced it.
  for (let i = 1; i < s.paths.length; i++)
    expect(s.paths[i].z).toBeLessThanOrEqual(s.paths[i - 1].z);
  // Levels sit one zStep apart and inside the model's depth.
  for (const p of s.paths) {
    expect(p.z).toBeLessThan(0);
    expect(p.z).toBeGreaterThan(-DEPTH);
    expect(Math.abs(p.z / s.zStep - Math.round(p.z / s.zStep))).toBeLessThan(1e-9);
  }
});

test("no stubs: nothing shorter than the cutter is posted", () => {
  // The fragmentation finding. Before the smooth clip and this filter, a
  // hemisphere produced 628 contours of which 336 were under 1mm — one plunge
  // and retract apiece, for arcs a single tool position covers.
  for (const stepover of [1, 0.5]) {
    const s = split((x, y) => {
      const r = Math.hypot(x - mid, y - mid);
      return r < 28 ? (DEPTH * Math.sqrt(784 - r * r)) / 28 : 0;
    }, stepover);
    if (s.kind !== "split") throw new Error("expected a split");
    for (const p of s.paths) {
      let len = 0;
      for (let i = 1; i < p.pts.length; i++)
        len += Math.hypot(p.pts[i].x - p.pts[i - 1].x, p.pts[i].y - p.pts[i - 1].y);
      expect(len).toBeGreaterThanOrEqual(op().diameter);
    }
  }
});

test("the raster only gives up cells a contour actually reaches", () => {
  // The invariant that makes an uncut bump impossible: `steep()` is intersected
  // with the cells the surviving paths pass through, so nothing can be dropped
  // from the raster on the promise of a pass that was then filtered away.
  //
  // It has to be checked on a shape where the two DIFFER, and most shapes are
  // not one. On a cone and on a hemisphere the theory holds unaided — every
  // steep cell has a contour within a cell of it — so a version of this test
  // using those shapes passes with the intersection deleted, which is how it
  // was written first. A rippled surface is covered in small steep patches that
  // a contour only grazes, so the grazing arc is dropped as a stub: measured,
  // the gate removes 6-17% of the raw mask there and 0% on the cone. Those are
  // the cells that would otherwise be skipped by the raster and cut by nothing.
  const ripple = (x: number, y: number): number =>
    Math.max(0, Math.min(DEPTH, DEPTH / 2 + 4 * Math.sin(x / 3) * Math.cos(y / 4)));
  for (const [name, height, stepover] of [
    ["cone", cone(2), 0.5],
    ["ripple", ripple, 0.5],
  ] as const) {
    const o = op({ rasterLineInterval: stepover, rasterDotPitch: stepover });
    const contact = toolContactField(fieldOf(height, stepover), o, DEPTH);
    const s = steepSplit(contact, o, DEPTH);
    if (s.kind !== "split") throw new Error(`expected a split on the ${name}`);

    const { cols, colPitch, rowPitch, rows } = contact;
    const near = new Set<number>();
    for (const p of s.paths)
      for (const pt of p.pts) {
        const c0 = Math.round(pt.x / colPitch - 0.5);
        const r0 = Math.round(pt.y / rowPitch - 0.5);
        for (let r = r0 - 1; r <= r0 + 1; r++)
          for (let c = c0 - 1; c <= c0 + 1; c++) near.add(r * cols + c);
      }
    let skipped = 0;
    for (let r = 0; r < rows.length; r++)
      for (let c = 0; c < cols; c++)
        if (s.steep(r, c)) {
          skipped++;
          expect(near.has(r * cols + c), `${name}: skipped a cell no contour reaches`).toBe(true);
        }
    expect(skipped).toBe(s.cells);
    expect(skipped).toBeGreaterThan(50); // it skipped a real region, not nothing
  }
});

test("nothing is skipped that sits below the deepest contour", () => {
  // Found by rendering the PREVIEW, not by a test: the levels stop one zStep
  // above the floor, so the ring of cells at the foot of a wall had no contour
  // beneath them — a cusp is finished by the tool bodies on BOTH sides of it,
  // and there is nothing below the last one. The raster used to cut those cells
  // and had stopped; the preview showed 0.37mm of stock standing round the base
  // of a cone. The gate reads the Z as well as the XY now.
  const stepover = 0.5;
  const o = op({ rasterLineInterval: stepover, rasterDotPitch: stepover });
  const contact = toolContactField(fieldOf(cone(2), stepover), o, DEPTH);
  const s = steepSplit(contact, o, DEPTH);
  if (s.kind !== "split") throw new Error("expected a split");

  const deepest = Math.min(...s.paths.map((p) => p.z));
  expect(deepest).toBeLessThan(-DEPTH / 2); // the contours really do go deep
  const { cols, rows } = contact;
  let checked = 0;
  for (let r = 0; r < rows.length; r++)
    for (let c = 0; c < cols; c++)
      if (s.steep(r, c)) {
        checked++;
        expect(-rows[r].levels[c] * DEPTH).toBeGreaterThanOrEqual(deepest - 1e-9);
      }
  expect(checked).toBeGreaterThan(50);
});

test("a wall is treated the same whichever way it faces the scan", () => {
  // The rejected alternative was exact about cusp height and left one boss wall
  // in two finishes; these two walls are the same wall rotated 90°, and a
  // difference between them is the anisotropy coming back.
  const across = split((_x, y) => (y > mid ? DEPTH : 0));
  const along = split((x) => (x > mid ? DEPTH : 0));
  if (across.kind !== "split" || along.kind !== "split") throw new Error("expected splits");
  expect(along.cells).toBe(across.cells);
  expect(along.paths.length).toBe(across.paths.length);
});
