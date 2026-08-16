/**
 * The tool has a SHAPE, and a relief that ignores it gouges.
 *
 * The measurement this file exists for: a 16×16 field with one vertical wall
 * (a logo, or text rasterised to an image), 3mm deep, ⌀3 ball-nose — the shipped
 * point-sampling path overcut by **2.905mm, 97% of the part depth**, silently.
 * `scripts/relief-gouge-probe.ts` is the standalone measurement.
 */
import { test, expect, describe, vi } from "vitest";
import { rasterField, type RasterField, type RasterGrid } from "../src/cam/rasterEngrave";
import { ballHeight, coneHeight, toolContactField, toolProfile } from "../src/cam/toolProfile";
import type { CAMOperation } from "../src/cam/types";

const op = (over: Partial<CAMOperation> = {}): CAMOperation => ({
  id: "o",
  name: "relief",
  type: "engrave",
  entityIds: [],
  side: "outside",
  toolType: "ball-nose",
  toolNumber: 1,
  diameter: 3,
  feedrate: 1500,
  plungeRate: 300,
  spindleSpeed: 18000,
  safeZ: 5,
  depth: -3,
  stepdown: 3,
  stepover: 0.4,
  ...over,
});

/** `rows[y][x]` as lightness 0..1 (0 = black = deepest), row 0 = TOP. */
const grid = (rows: number[][]): RasterGrid => ({
  width: rows[0].length,
  height: rows.length,
  data: rows.flat(),
});

/** A field at 1mm cells: `n`×`n` mm, one cell per source pixel. */
const field1mm = (rows: number[][]): RasterField =>
  rasterField(grid(rows), {
    widthMM: rows[0].length,
    heightMM: rows.length,
    lineIntervalMM: 1,
    dotPitchMM: 1,
  });

/** Half black (level 1), half white (level 0): one vertical wall at x = n/2. */
const wall = (n = 16): number[][] =>
  Array.from({ length: n }, () => Array.from({ length: n }, (_, x) => (x < n / 2 ? 0 : 1)));

const levelsOf = (f: RasterField, r = 0): number[] => [...f.rows[r].levels];

// --- the flank laws ---------------------------------------------------------

describe("tool profiles", () => {
  test("a ball-nose flank climbs R − √(R²−d²) above the tip, and nothing past R", () => {
    expect(ballHeight(0, 1.5)).toBe(0); // the tip itself
    expect(ballHeight(0.5, 1.5)).toBeCloseTo(1.5 - Math.sqrt(2.25 - 0.25), 12); // 0.08579
    expect(ballHeight(1.5, 1.5)).toBeCloseTo(1.5, 12); // the equator
    expect(ballHeight(1.6, 1.5)).toBe(Infinity); // past the ball: no constraint
  });

  test("a V-bit is flat across its tip flat, then climbs d/tan(θ/2)", () => {
    const t30 = Math.tan(Math.PI / 6); // 60° included → 30° half
    expect(coneHeight(0.4, t30, 0.5)).toBe(0); // inside a 1mm flat tip
    expect(coneHeight(1.5, t30, 0.5)).toBeCloseTo(1 / t30, 12); // 1mm past the flat
    expect(coneHeight(1, t30)).toBeCloseTo(1 / t30, 12); // sharp bit: from the point
  });

  test("reach stops at the tool, or at the deepest the field goes — whichever is nearer", () => {
    const ball = toolProfile({ toolType: "ball-nose", diameter: 3 });
    expect(ball.reach(3)).toBeCloseTo(1.5, 12); // cut deeper than the ball → radius-bound
    // A 0.5mm cut: the flank has already climbed 0.5mm at d = √(R²−(R−0.5)²).
    expect(ball.reach(0.5)).toBeCloseTo(Math.sqrt(1.5 ** 2 - 1 ** 2), 12);
    expect(ballHeight(ball.reach(0.5), 1.5)).toBeCloseTo(0.5, 10);

    // A flat end mill has no flank to climb: the whole disc, always.
    expect(toolProfile({ toolType: "end-mill", diameter: 6 }).reach(0.1)).toBe(3);
  });
});

// --- the correction itself --------------------------------------------------

describe("toolContactField", () => {
  test("the measured case: the field beside a wall matches a by-hand drop-cutter", () => {
    // ⌀3 ball (R 1.5) on 1mm cells, 3mm deep. A sample stands for its whole cell,
    // so the tip at cell 7 is held up by the white cell 8 starting 0.5mm away:
    //   level = (R − √(R²−0.5²)) / 3 = 0.02860, floored onto the 1/255 ladder.
    // Cell 6 is 1.5mm from that wall — exactly the ball's equator — so it is held
    // at 1.5/3 = 0.5. Cell 5 is out of reach and keeps the full depth.
    const out = toolContactField(field1mm(wall()), op(), 3);
    const lv = levelsOf(out);
    const q = (v: number) => Math.floor(v / (1 / 255) + 1e-9) / 255;

    expect(lv.slice(0, 6)).toEqual([1, 1, 1, 1, 1, 1]); // positive control: still full depth
    expect(lv[6]).toBeCloseTo(q(1.5 / 3), 6);
    expect(lv[7]).toBeCloseTo(q((1.5 - Math.sqrt(2.25 - 0.25)) / 3), 6);
    expect(lv.slice(8)).toEqual(new Array(8).fill(0)); // white side untouched
  });

  test("no commanded tip ever puts the flank through surviving material", () => {
    const R = 1.5,
      D = 3;
    const out = toolContactField(field1mm(wall()), op(), D);
    const lv = levelsOf(out);
    const surface = (c: number) => (c < 8 ? -D : 0); // what must survive

    let worst = 0;
    for (let c = 0; c < 16; c++) {
      const z = -lv[c] * D;
      for (let o = -2; o <= 2; o++) {
        const n = c + o;
        if (n < 0 || n > 15) continue;
        // Nearest point of cell n to the tip at the centre of cell c.
        const d = Math.max(0, Math.abs(o) - 0.5);
        if (d > R) continue;
        worst = Math.max(worst, surface(n) - (z + ballHeight(d, R)));
      }
    }
    expect(worst).toBeLessThanOrEqual(1e-9);

    // The mutant this guards: the point-sampled field gouges by ~2.9mm here.
    const raw = levelsOf(field1mm(wall()));
    expect(-raw[7] * D + ballHeight(0.5, R) - 0).toBeCloseTo(-2.914, 3);
  });

  test("a wall lying the other way is corrected identically (the footprint is round)", () => {
    // Turn the measured case on its side. The two must agree cell for cell — a
    // correction that reads further along one axis than the other gouges on the
    // axis it reads short, and nothing built from a vertical wall can see it.
    const w = wall();
    const transposed = w.map((_, y) => w.map((row) => row[y]));
    const along = toolContactField(field1mm(w), op(), 3);
    const across = toolContactField(field1mm(transposed), op(), 3);
    // Row 0 of the field is the BOTTOM of the image, so the transpose flips it.
    const n = across.rows.length;
    for (let c = 0; c < 16; c++)
      expect(across.rows[n - 1 - c].levels[0]).toBeCloseTo(levelsOf(along)[c], 6);
    expect(levelsOf(along)[7]).toBeGreaterThan(0); // positive control: not all zero
  });

  test("it only ever lifts the tool — a corrected field is never deeper", () => {
    // A field with plenty for the dilation to bite on: a checker of walls.
    const rows = Array.from({ length: 12 }, (_, y) =>
      Array.from({ length: 12 }, (_, x) => ((x >> 1) + (y >> 1)) % 2),
    );
    const before = field1mm(rows);
    const after = toolContactField(before, op(), 3);
    for (let r = 0; r < before.rows.length; r++)
      for (let c = 0; c < before.cols; c++)
        expect(after.rows[r].levels[c]).toBeLessThanOrEqual(before.rows[r].levels[c] + 1e-9);
    // Positive control: it did something.
    expect(levelsOf(after).join()).not.toBe(levelsOf(before).join());
  });

  test("the border is replicated, not walled: a solid image still reaches full depth", () => {
    // Treating "outside the image" as uncut stock would lift a band of R all the
    // way round every relief ever cut.
    const solid = Array.from({ length: 8 }, () => new Array(8).fill(0));
    const out = toolContactField(field1mm(solid), op(), 3);
    for (const row of out.rows) for (const v of row.levels) expect(v).toBeCloseTo(1, 9);
  });

  test("a field the tool can already cut comes back bit-identical", () => {
    // A gentle gradient — 0.06mm/mm — never trips the flank, so the emitted Z
    // must not move by even a quantisation step.
    const rows = Array.from({ length: 40 }, () =>
      Array.from({ length: 40 }, (_, x) => 1 - x / 39),
    );
    const before = rasterField(grid(rows), {
      widthMM: 200,
      heightMM: 200,
      lineIntervalMM: 5,
      dotPitchMM: 5,
    });
    const after = toolContactField(before, op(), 3);
    for (let r = 0; r < before.rows.length; r++)
      expect(levelsOf(after, r)).toEqual(levelsOf(before, r));
  });

  test("a halftone is left alone — its overlapping grooves ARE the tone", () => {
    const f = field1mm(wall());
    const ht = op({ toolType: "v-bit", vAngle: 60, halftone: true });
    expect(toolContactField(f, ht, 3)).toBe(f); // same object: untouched
    // Positive control: the same V-bit NOT halftoning is corrected.
    expect(toolContactField(f, op({ toolType: "v-bit", vAngle: 60 }), 3)).not.toBe(f);
  });

  test("a V-bit is held up by its cone, not by a ball", () => {
    const t30 = Math.tan(Math.PI / 6);
    const out = toolContactField(field1mm(wall()), op({ toolType: "v-bit", vAngle: 60 }), 3);
    // Cell 7, 0.5mm from the white cell 8: the cone has climbed 0.5/tan30.
    expect(levelsOf(out)[7]).toBeCloseTo(Math.floor(0.5 / t30 / 3 / (1 / 255) + 1e-9) / 255, 6);
    // Positive control: that is NOT where a ball of the same diameter sits.
    expect(levelsOf(toolContactField(field1mm(wall()), op(), 3))[7]).not.toBeCloseTo(
      0.5 / t30 / 3,
      3,
    );
  });

  test("the finish allowance is backed off the target, not stacked on the correction", () => {
    // Solid black, flat tool: nothing for the footprint to catch on, so the only
    // thing moving the level is the 0.5mm allowance on a 3mm depth.
    const solid = Array.from({ length: 8 }, () => new Array(8).fill(0));
    const out = toolContactField(field1mm(solid), op({ toolType: "end-mill" }), 3, 0.5);
    for (const row of out.rows)
      for (const v of row.levels) expect(-v * 3).toBeCloseTo(-2.5, 5); // depth − allowance, once
  });

  test("a flat end mill cannot drop into a well narrower than itself", () => {
    // One black cell in a white field, ⌀6 tool: the disc reaches 3mm, the well is
    // 1mm wide. Roughing it would plough the standing material either side.
    const rows = Array.from({ length: 9 }, (_, y) =>
      Array.from({ length: 9 }, (_, x) => (x === 4 && y === 4 ? 0 : 1)),
    );
    const out = toolContactField(field1mm(rows), op({ toolType: "end-mill", diameter: 6 }), 3);
    for (const row of out.rows) for (const v of row.levels) expect(v).toBe(0);
    // Positive control: a tool that fits inside the well still cuts it.
    const fine = toolContactField(field1mm(rows), op({ toolType: "end-mill", diameter: 0.5 }), 3);
    expect(fine.rows[4].levels[4]).toBeCloseTo(1, 6);
    // …and the same ⌀6 tool clears a well it does fit in (7×7mm of black).
    const wide = Array.from({ length: 13 }, (_, y) =>
      Array.from({ length: 13 }, (_, x) => (x >= 3 && x <= 9 && y >= 3 && y <= 9 ? 0 : 1)),
    );
    const big = toolContactField(field1mm(wide), op({ toolType: "end-mill", diameter: 6 }), 3);
    expect(big.rows[6].levels[6]).toBeCloseTo(1, 6);
  });
});

// --- the performance trap ---------------------------------------------------

test("the footprint is priced once, not per cell (no trig in the inner loop)", () => {
  // The trap this repo has shipped twice: an O(n) loop with trigonometry inside
  // it. The tool profile is evaluated per FOOTPRINT OFFSET into a table, so the
  // call count must not move when the grid grows.
  const noisy = (n: number) =>
    rasterField(
      grid(Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => (x * 37 + y * 11) % 256 / 255))),
      { widthMM: n, heightMM: n, lineIntervalMM: 1, dotPitchMM: 1 },
    );

  const count = (f: RasterField): number => {
    const spy = vi.spyOn(Math, "hypot");
    try {
      toolContactField(f, op(), 3);
      return spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
  };

  const small = count(noisy(16)); // 256 cells
  const large = count(noisy(64)); // 4096 cells — 16× the work
  expect(large).toBe(small);
  expect(small).toBeLessThan(32); // and it is footprint-sized: 3 bands × ≤3 offsets
});
