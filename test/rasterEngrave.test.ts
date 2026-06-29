import { describe, it, expect } from "vitest";
import { rasterEngrave, rasterField, resampleGrid, type RasterGrid, type RasterEngraveParams, type RasterFieldParams } from "../src/cam/rasterEngrave";

// A grid from a 2D array of greyscale rows (row 0 = top), values 0..1.
const grid = (rowsTopDown: number[][]): RasterGrid => ({
  width: rowsTopDown[0].length,
  height: rowsTopDown.length,
  data: rowsTopDown.flat(),
});

const P = (over: Partial<RasterEngraveParams> = {}): RasterEngraveParams => ({
  widthMM: 4, heightMM: 2, lineIntervalMM: 1, maxPower: 100, minPower: 0, ...over,
});

const F = (over: Partial<RasterFieldParams> = {}): RasterFieldParams => ({
  widthMM: 4, heightMM: 2, lineIntervalMM: 1, ...over,
});

describe("rasterField (shared level grid)", () => {
  it("returns an empty field for degenerate inputs", () => {
    expect(rasterField(grid([[0]]), F({ widthMM: 0 })).rows).toEqual([]);
    expect(rasterField(grid([[0]]), F({ lineIntervalMM: 0 })).rows).toEqual([]);
    expect(rasterField({ width: 0, height: 0, data: [] }, F()).rows).toEqual([]);
  });

  it("maps darkness to level (black=1, white=0) and quantises", () => {
    // 1×1 mid-grey at a coarse level step → quantised darkness.
    const f = rasterField(grid([[0.5]]), F({ widthMM: 1, heightMM: 1, lineIntervalMM: 1, levelStep: 0.1 }));
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0].levels[0]).toBeCloseTo(0.5, 6); // 1 - 0.5
    expect([...rasterField(grid([[0]]), F({ widthMM: 1, heightMM: 1 })).rows[0].levels]).toEqual([1]); // black
    expect([...rasterField(grid([[1]]), F({ widthMM: 1, heightMM: 1 })).rows[0].levels]).toEqual([0]); // white
  });

  it("blanks dots at/above the white threshold but keeps near-white as a small level", () => {
    const f = rasterField(grid([[0.9, 0.97]]), F({ widthMM: 2, heightMM: 1, whiteThreshold: 0.96 }));
    const lv = f.rows[0].levels;
    expect(lv[0]).toBeCloseTo(0.1, 2); // 1 - 0.9
    expect(lv[1]).toBe(0);             // 0.97 ≥ 0.96 → blank
  });

  it("invert cuts the light areas instead of the dark", () => {
    const f = rasterField(grid([[0, 1]]), F({ widthMM: 2, heightMM: 1, invert: true }));
    expect([...f.rows[0].levels]).toEqual([0, 1]); // black→0, white→1
  });

  it("keeps all-blank rows (a mill rides across them), unlike rasterEngrave", () => {
    // 1px wide, top black / bottom white over 2mm → 2 rows; bottom row all blank.
    const f = rasterField(grid([[0], [1]]), F({ widthMM: 1, heightMM: 2, lineIntervalMM: 1 }));
    expect(f.rows.map((r) => r.y)).toEqual([0.5, 1.5]); // bottom→top, both present
    expect(f.rows[0].levels[0]).toBe(0); // bottom = white = blank, but still emitted
    expect(f.rows[1].levels[0]).toBe(1); // top = black
  });

  it("box-averages to the dot pitch (shares resampleGrid with rasterEngrave)", () => {
    // 4 source px across 2mm at a 1mm dot pitch → 2 dots, each the mean of 2 px.
    const f = rasterField(grid([[0, 0, 1, 1]]), F({ widthMM: 2, heightMM: 1, lineIntervalMM: 1 }));
    expect(f.cols).toBe(2);
    expect([...f.rows[0].levels]).toEqual([1, 0]); // avg(0,0)=black→1 ; avg(1,1)=white→0
  });
});

describe("rasterEngrave", () => {
  it("returns nothing for degenerate inputs", () => {
    expect(rasterEngrave(grid([[0]]), P({ widthMM: 0 }))).toEqual([]);
    expect(rasterEngrave(grid([[0]]), P({ heightMM: 0 }))).toEqual([]);
    expect(rasterEngrave(grid([[0]]), P({ lineIntervalMM: 0 }))).toEqual([]);
    expect(rasterEngrave({ width: 0, height: 0, data: [] }, P())).toEqual([]);
  });

  it("burns black pixels at maxPower and skips white background", () => {
    // 4×2: top row half black, bottom row all white.
    const g = grid([
      [0, 0, 1, 1],
      [1, 1, 1, 1],
    ]);
    const rows = rasterEngrave(g, P()); // 2mm tall, 1mm pitch → 2 rows; 4mm wide → 1mm/px
    expect(rows.length).toBe(1); // the all-white bottom row is omitted

    // The surviving row is the TOP image row, which sits at the HIGH y band.
    const row = rows[0];
    expect(row.y).toBeCloseTo(1.5, 6);
    expect(row.runs).toHaveLength(1);
    expect(row.runs[0]).toEqual({ x0: 0, x1: 2, power: 100 }); // first two px black
  });

  it("maps mid-grey between min and max power", () => {
    const g = grid([[0.5]]);
    const rows = rasterEngrave(g, P({ widthMM: 1, heightMM: 1, maxPower: 80, minPower: 20 }));
    // power = 80 + (20-80)*0.5 = 50.
    expect(rows[0].runs[0].power).toBe(50);
  });

  it("merges equal-tone neighbours into one run, splits on tone change", () => {
    const g = grid([[0, 0, 0.5, 0.5, 0]]);
    const rows = rasterEngrave(g, P({ widthMM: 5, heightMM: 1, maxPower: 100, minPower: 0 }));
    const runs = rows[0].runs;
    expect(runs.map((r) => [r.x0, r.x1, r.power])).toEqual([
      [0, 2, 100], // two black px
      [2, 4, 50],  // two mid px
      [4, 5, 100], // one black px
    ]);
  });

  it("honours whiteThreshold: light pixels below it still burn, at/above are blank", () => {
    const g = grid([[0.9, 0.97]]);
    const rows = rasterEngrave(g, P({ widthMM: 2, heightMM: 1, whiteThreshold: 0.96 }));
    // 0.9 < 0.96 → burns at 100*(1-0.9)=10; 0.97 ≥ 0.96 → blank.
    expect(rows[0].runs).toEqual([{ x0: 0, x1: 1, power: 10 }]);
  });

  it("invert engraves the light areas instead of the dark ones", () => {
    const g = grid([[0, 1]]); // black, white
    const rows = rasterEngrave(g, P({ widthMM: 2, heightMM: 1, invert: true }));
    // inverted: black→white (blank), white→black (burns at max).
    expect(rows[0].runs).toEqual([{ x0: 1, x1: 2, power: 100 }]);
  });

  it("quantises power to powerStep so near-equal tones coalesce", () => {
    const g = grid([[0.50, 0.51]]); // would map to 50 and 49
    const fine = rasterEngrave(g, P({ widthMM: 2, heightMM: 1 }));
    expect(fine[0].runs).toHaveLength(2); // step 1 keeps them apart
    const coarse = rasterEngrave(g, P({ widthMM: 2, heightMM: 1, powerStep: 10 }));
    expect(coarse[0].runs).toHaveLength(1); // both round to 50 → one run
    expect(coarse[0].runs[0]).toEqual({ x0: 0, x1: 2, power: 50 });
  });

  it("box-averages the source horizontally down to the dot pitch", () => {
    // 4 source px across 2mm at a 1mm dot pitch → 2 dots, each the mean of 2 px.
    const g = grid([[0, 0, 1, 1]]);
    const rows = rasterEngrave(g, P({ widthMM: 2, heightMM: 1, lineIntervalMM: 1 }));
    // dot0 = avg(0,0)=0 → black → 100; dot1 = avg(1,1)=1 → white → blank.
    expect(rows[0].runs).toEqual([{ x0: 0, x1: 1, power: 100 }]);
  });

  it("box-averages vertically: rows between scan lines are folded in, not dropped", () => {
    // 1px wide, 4 rows (top→bottom) black,black,white,white over 2mm at 1mm pitch.
    const g = grid([[0], [0], [1], [1]]);
    const rows = rasterEngrave(g, P({ widthMM: 1, heightMM: 2, lineIntervalMM: 1 }));
    // 2 scan rows: top band = avg(black,black)=100; bottom band = avg(white,white)=blank.
    expect(rows).toHaveLength(1);
    expect(rows[0].y).toBeCloseTo(1.5, 6); // the top (burning) band
    expect(rows[0].runs[0].power).toBe(100);
  });

  it("averaging a black+white pair yields mid power, not aliasing to one or the other", () => {
    const g = grid([[0, 1]]); // one black, one white px
    const rows = rasterEngrave(g, P({ widthMM: 1, heightMM: 1, lineIntervalMM: 1 }));
    // Down to a single 1mm dot = avg(0,1)=0.5 → 50% power (a grey, not black or skipped).
    expect(rows[0].runs).toEqual([{ x0: 0, x1: 1, power: 50 }]);
  });

  it("dotPitchMM sets a horizontal resolution independent of the line interval", () => {
    const g = grid([[0, 0, 0, 0]]); // 4 black px, 4mm wide
    const rows = rasterEngrave(g, P({ widthMM: 4, heightMM: 1, lineIntervalMM: 2, dotPitchMM: 1 }));
    // One scan row (2mm pitch into 1mm tall → 1 row), 4 dots at 1mm → merged to one run.
    expect(rows).toHaveLength(1);
    expect(rows[0].runs).toEqual([{ x0: 0, x1: 4, power: 100 }]);
  });

  it("resampleGrid downsamples by area-averaging and bounds the output size", () => {
    // 4×4 with a black top-left quadrant, white elsewhere → 2×2 averaged.
    const src: RasterGrid = { width: 4, height: 4, data: [
      0, 0, 1, 1,
      0, 0, 1, 1,
      1, 1, 1, 1,
      1, 1, 1, 1,
    ] };
    const out = resampleGrid(src, 2, 2);
    expect([...out]).toEqual([0, 1, 1, 1]); // TL cell all-black, rest all-white
  });

  it("emits rows bottom→top with the right pixel mapping", () => {
    // Distinct tone per image row so we can check row↔y correspondence.
    const g = grid([
      [0.0], // top image row    → highest y
      [0.5],
      [0.0], // bottom image row → lowest y
    ]);
    const rows = rasterEngrave(g, P({ widthMM: 1, heightMM: 3, lineIntervalMM: 1 }));
    expect(rows.map((r) => r.y)).toEqual([0.5, 1.5, 2.5]); // bottom→top
    // bottom row (y=0.5) is image row 2 = black(100); middle = grey(50); top = black.
    expect(rows.map((r) => r.runs[0].power)).toEqual([100, 50, 100]);
  });
});
