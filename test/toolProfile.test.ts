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
import { ballHeight, coneHeight, taperedBallHeight, taperedBallReach, toolContactField, toolProfile } from "../src/cam/toolProfile";
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

  test("a tapered ball-nose is the ball near the tip, the cone beyond, tangent at the join", () => {
    // ⌀6 major (R 3), ⌀1 ball tip (r 0.5), 12° included taper → 6° half-angle.
    const R = 3;
    const r = 0.5;
    const tanHalf = Math.tan((6 * Math.PI) / 180);
    const blend = r / Math.sqrt(1 + tanHalf * tanHalf); // r·cos(α)
    const blendH = r * (1 - tanHalf / Math.sqrt(1 + tanHalf * tanHalf)); // r(1 − sin α)

    // Inside the tangent offset the flank IS the ball law, exactly.
    for (const d of [0, blend / 2, blend * 0.999]) {
      expect(taperedBallHeight(d, R, r, tanHalf)).toBe(ballHeight(d, r));
    }
    // Beyond it, the cone law with the tangent's vertical offset.
    for (const d of [blend * 1.001, blend + 0.5, R]) {
      expect(taperedBallHeight(d, R, r, tanHalf)).toBeCloseTo(blendH + coneHeight(d, tanHalf, blend), 12);
    }
    // Past the major radius the shank has ended: no constraint.
    expect(taperedBallHeight(R + 1e-6, R, r, tanHalf)).toBe(Infinity);

    // Value continuity at the join.
    expect(taperedBallHeight(blend, R, r, tanHalf)).toBeCloseTo(blendH, 12);
    // Slope continuity — tangency is the whole point of a composite cutter. The
    // ball's slope at the join is cot(α) = 1/tan(α); the cone's is the same. A
    // kinked profile would fail this. (h small: the ball's second derivative
    // blows up near the tangent, so a coarse step biases the one-sided secant.)
    const h = 1e-8;
    const left = (taperedBallHeight(blend, R, r, tanHalf) - taperedBallHeight(blend - h, R, r, tanHalf)) / h;
    const right = (taperedBallHeight(blend + h, R, r, tanHalf) - taperedBallHeight(blend, R, r, tanHalf)) / h;
    expect(right).toBeCloseTo(1 / tanHalf, 6); // the cone side is linear: exact
    expect(left).toBeCloseTo(right, 4); // no kink at the join
  });

  test("a tapered ball-nose is neither the major-radius ball nor a sharp cone", () => {
    // The defect to guard: a tapered bit computed as a plain ⌀6 ball, or as a
    // sharp 6° V-bit. Its flank is governed by the ⌀1 BALL TIP, not the ⌀6 body.
    const R = 3;
    const r = 0.5;
    const tanHalf = Math.tan((6 * Math.PI) / 180);
    const d = 0.25; // well inside the ball tip
    const h = taperedBallHeight(d, R, r, tanHalf);
    expect(h).toBeCloseTo(ballHeight(d, r), 12); // the TIP ball …
    expect(h).not.toBeCloseTo(ballHeight(d, R), 12); // … not the ⌀6 ball
    expect(h).not.toBeCloseTo(coneHeight(d, tanHalf), 12); // … not a sharp cone
    // reach() inverts it, so it too tracks the tip rather than the body.
    expect(taperedBallReach(0.01, R, r, tanHalf)).toBeLessThan(R);
  });

  test("tapered reach inverts height, round-trip through the profile", () => {
    const prof = toolProfile({ toolType: "tapered-ball-nose", diameter: 6, tipDiameter: 1, vAngle: 6 });
    for (const h of [0.01, 0.05, 0.1, 0.3, 0.5, 1]) {
      const d = prof.reach(h);
      expect(d).toBeGreaterThan(0);
      expect(prof.height(d)).toBeCloseTo(h, 9);
    }
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

/**
 * The optimised sweep against a brute-force oracle that shares none of its
 * machinery: no footprint table, no box-min early-out, no negation duality, no
 * band bookkeeping. Just the definition.
 *
 * This exists because extracting the shared `sweep()` kernel moved the level-ladder
 * quantisation out of the per-cell loop, and a second pass over the output is NOT
 * equivalent: `best` carries a float64 penalty, so storing it into a Float32Array
 * first can round a `best` that was strictly below `own` back onto it. The second
 * pass then sees them equal, skips the quantisation, and leaves the cell one whole
 * level step deeper than this code has ever cut — 11.8 µm on a 3 mm relief, in the
 * UN-conservative direction, on 3 cells out of 38.5 million. Green suite, green
 * typecheck, and no assertion anywhere could see it.
 */
function bruteContactField(
  f: RasterField,
  profile: ReturnType<typeof toolProfile>,
  maxDepth: number,
  finishAllowance = 0,
): number[][] {
  // The allowance arrives in MILLIMETRES and the field is in level units; missing
  // that conversion here is what made this oracle's first run disagree by 800 µm,
  // and it disagreed in the direction that would have read as a shipped bug.
  const backoff = Math.min(1, Math.max(0, finishAllowance) / maxDepth);
  const reach = profile.reach(maxDepth);
  const nRows = f.rows.length;
  const src = f.rows.map((row) =>
    Array.from({ length: f.cols }, (_, c) =>
      backoff > 0 ? (row.levels[c] > backoff ? row.levels[c] - backoff : 0) : row.levels[c],
    ),
  );
  const L = f.colPitch > 0 ? Math.floor(reach / f.colPitch + 0.5) : 0;
  const K = f.rowPitch > 0 ? Math.floor(reach / f.rowPitch + 0.5) : 0;
  if (L <= 0 && K <= 0) return src;

  return src.map((row, r) =>
    row.map((own, c) => {
      let best = own;
      for (let j = -K; j <= K; j++)
        for (let i = -L; i <= L; i++) {
          // Near-edge distance, and the border replicates — both are the field's
          // stated conventions, restated here on purpose so a change to either
          // has to be made twice and argued for once.
          const vx = Math.max(0, Math.abs(i) * f.colPitch - f.colPitch / 2);
          const vy = Math.max(0, Math.abs(j) * f.rowPitch - f.rowPitch / 2);
          const d = Math.hypot(vx, vy);
          if (d > reach) continue;
          const h = profile.height(d);
          if (!Number.isFinite(h)) continue;
          const rr = Math.min(nRows - 1, Math.max(0, r + j));
          const cc = Math.min(f.cols - 1, Math.max(0, c + i));
          const v = src[rr][cc] + h / maxDepth;
          if (v < best) best = v;
        }
      return best === own ? own : Math.floor(best / f.levelStep + 1e-9) * f.levelStep;
    }),
  );
}

test("the optimised sweep equals a brute-force drop-cutter, bit for bit", () => {
  // Varied along every axis the sweep branches on: field character (a hard wall,
  // a smooth ramp, and noise finer than any bit), tool TYPE (three different
  // flank laws), cell size against the tool, cut depth, and the roughing
  // allowance — which takes the separate backoff path.
  const n = 24;
  const fields: [string, number[][]][] = [
    ["wall", wall(n)],
    ["ramp", Array.from({ length: n }, () => Array.from({ length: n }, (_, x) => x / (n - 1)))],
    [
      "noise",
      Array.from({ length: n }, (_, y) =>
        Array.from({ length: n }, (_, x) => ((x * 37 + y * 11) % 256) / 255),
      ),
    ],
  ];
  let compared = 0;
  for (const [label, rows] of fields)
    for (const over of [
      { toolType: "ball-nose" as const, diameter: 3 },
      { toolType: "ball-nose" as const, diameter: 7 },
      { toolType: "v-bit" as const, diameter: 6, vAngle: 60 },
      { toolType: "v-bit" as const, diameter: 4, vAngle: 90, tipDiameter: 0.5 },
      { toolType: "end-mill" as const, diameter: 5 },
    ])
      for (const maxDepth of [3, 25])
        for (const allowance of [0, 0.4]) {
          const f = field1mm(rows);
          const o = op({ ...over, depth: -maxDepth });
          const got = toolContactField(f, o, maxDepth, allowance);
          const want = bruteContactField(f, toolProfile(o), maxDepth, allowance);
          for (let r = 0; r < f.rows.length; r++)
            for (let c = 0; c < f.cols; c++) {
              const a = got.rows[r].levels[c];
              const b = want[r][c];
              if (!Object.is(a, Math.fround(b)))
                throw new Error(
                  `${label}/${over.toolType}⌀${over.diameter}/d${maxDepth}/a${allowance} ` +
                    `cell ${r},${c}: optimised ${a} vs brute ${b} ` +
                    `(${((a - b) * maxDepth * 1000).toFixed(1)} µm)`,
                );
              compared++;
            }
        }
  // Positive control: the loop above passes trivially if it compared nothing.
  expect(compared).toBe(3 * 5 * 2 * 2 * n * n);
});

test("quantisation happens against the float64 best, not the stored float32", () => {
  // The knife-edge the oracle above cannot reach by sampling: `best` is
  // `src + pen` with a float64 penalty, and here it lands strictly below 1 but
  // within half a float32 ulp of it (the spacing below 1.0 is 2^-24 ≈ 6e-8). Store
  // it before comparing and it rounds back onto `own`, the quantisation is skipped
  // as a no-op, and the cell is left a full level step — 11.8 µm at this depth —
  // DEEPER than the correction has ever cut it.
  //
  // It happens on 3 cells in 38.5 million, so it is not findable by widening a
  // matrix; this is the configuration it was actually found in, kept verbatim.
  // A resampled source is part of it — box-averaging is what produces the value.
  const PX = 400;
  const data = new Float32Array(PX * PX);
  for (let y = 0; y < PX; y++)
    for (let x = 0; x < PX; x++)
      data[y * PX + x] = (x % 64 < 28 && y % 64 < 28) || (x % 97 < 40 && y % 53 < 22) ? 0 : 1;
  const f = rasterField(
    { width: PX, height: PX, data },
    {
      widthMM: 60,
      heightMM: 60,
      lineIntervalMM: 1.2,
      dotPitchMM: 1.2,
      gamma: 1,
      tone: "encoded",
      // A height map's threshold. Leaving it at the photo default of 0.96 blanks
      // every cell at level <= 0.04 and moves the field out from under the case.
      whiteThreshold: 1.01,
    },
  );
  const o = op({ toolType: "ball-nose", diameter: 6, depth: -3 });
  const got = toolContactField(f, o, 3);
  const want = bruteContactField(f, toolProfile(o), 3);

  // The three cells the bug moved, named — so a failure says which invariant went
  // rather than just "a number changed".
  for (const [r, c] of [
    [23, 0],
    [49, 2],
    [49, 26],
  ] as const)
    expect(`cell ${r},${c} = ${got.rows[r].levels[c]}`).toBe(
      // fround: the field stores float32, and `254/255` in source is a float64
      // literal that does not compare equal to it.
      `cell ${r},${c} = ${Math.fround(254 / 255)}`,
    );

  let moved = 0;
  for (let r = 0; r < f.rows.length; r++)
    for (let c = 0; c < f.cols; c++)
      if (!Object.is(got.rows[r].levels[c], Math.fround(want[r][c]))) moved++;
  expect(moved).toBe(0);
});

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
