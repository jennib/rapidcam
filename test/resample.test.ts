import { describe, it, expect } from "vitest";
import {
  boxAccumulate,
  boxCell,
  boxDownsampleGrey,
  boxMeanBytes,
  newBoxAccumulator,
} from "../src/core/resample";

/** A w×h buffer from a generator, row-major. */
const build = (w: number, h: number, f: (x: number, y: number) => number): Uint8Array => {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = f(x, y);
  return out;
};

describe("box resample", () => {
  it("counts every source pixel exactly once, including at awkward ratios", () => {
    // The defining property: an area average is only an area average if the
    // partition is total. Any pixel skipped (bilinear) or double-counted breaks it.
    for (const [sw, sh, ow, oh] of [
      [7, 5, 3, 2],
      [1000, 999, 337, 41],
      [4, 4, 4, 4],
      [3, 3, 1, 1],
    ]) {
      const acc = newBoxAccumulator(sw, sh, ow, oh);
      boxAccumulate(acc, new Uint8Array(sw * sh), { x: 0, y: 0, w: sw, h: sh });
      const total = acc.cnt.reduce((a, b) => a + b, 0);
      expect(total, `${sw}×${sh} → ${ow}×${oh}`).toBe(sw * sh);
      // ...and no cell is left empty, so the mapping is onto when shrinking.
      expect([...acc.cnt].every((c) => c > 0)).toBe(true);
    }
  });

  it("averages a fine checkerboard to flat mid-grey instead of aliasing it", () => {
    // This is the bug the import path had. A 2×2-neighbourhood filter reducing 8×
    // lands on whichever phase it happens to sample and returns near-black or
    // near-white per cell; a true area average returns the mean of all 64.
    const src = build(16, 16, (x, y) => ((x + y) % 2 === 0 ? 0 : 255));
    // Positive control: the source really does hold both extremes, so a flat
    // result below can only come from averaging — not from a uniform input.
    expect(src).toContain(0);
    expect(src).toContain(255);

    const out = boxDownsampleGrey(src, 16, 16, 2, 2);
    expect([...out]).toEqual([128, 128, 128, 128]); // 32 black + 32 white per cell
  });

  it("area-averages a quadrant down (matches the CAM grid resample)", () => {
    const src = build(4, 4, (x, y) => (x < 2 && y < 2 ? 0 : 255));
    expect([...boxDownsampleGrey(src, 4, 4, 2, 2)]).toEqual([0, 255, 255, 255]);
  });

  it("is the identity at 1:1", () => {
    const src = build(5, 3, (x, y) => x * 17 + y * 5);
    expect([...boxDownsampleGrey(src, 5, 3, 5, 3)]).toEqual([...src]);
  });

  it("gives the same result whatever tiling the caller uses", () => {
    // What makes the tiled decode safe: each source pixel lands in its own cell
    // independently, so the partition into tiles cannot change the output.
    const sw = 53;
    const sh = 31;
    const src = build(sw, sh, (x, y) => (x * 31 + y * 97) % 256);
    const whole = boxDownsampleGrey(src, sw, sh, 9, 7);

    for (const tile of [1, 7, 16, 64]) {
      const acc = newBoxAccumulator(sw, sh, 9, 7);
      for (let ty = 0; ty < sh; ty += tile) {
        const th = Math.min(tile, sh - ty);
        for (let tx = 0; tx < sw; tx += tile) {
          const tw = Math.min(tile, sw - tx);
          // Copy out the tile the way a canvas readback would hand it over.
          const buf = new Uint8Array(tw * th);
          for (let y = 0; y < th; y++)
            for (let x = 0; x < tw; x++) buf[y * tw + x] = src[(ty + y) * sw + tx + x];
          boxAccumulate(acc, buf, { x: tx, y: ty, w: tw, h: th });
        }
      }
      expect([...boxMeanBytes(acc)], `tile ${tile}`).toEqual([...whole]);
    }
  });

  it("clamps per pixel, not after averaging", () => {
    // Order matters for out-of-range input: clamping each pixel first averages
    // 0 and 1 to 0.5, while clamping the mean of -1 and 1 would give 0.
    const acc = newBoxAccumulator(2, 1, 1, 1);
    boxAccumulate(acc, [-1, 1], { x: 0, y: 0, w: 2, h: 1 }, { min: 0, max: 1 });
    expect(acc.sum[0] / acc.cnt[0]).toBe(0.5);
  });

  it("folds the final source pixel into the last cell", () => {
    expect(boxCell(0, 10, 3)).toBe(0);
    expect(boxCell(9, 10, 3)).toBe(2);
    expect(boxCell(10, 10, 3)).toBe(2); // past the end, clamped rather than off-array
  });

  it("fills cells no source pixel reached", () => {
    const acc = newBoxAccumulator(1, 1, 2, 2); // upsampling: 3 of 4 cells stay empty
    boxAccumulate(acc, [7], { x: 0, y: 0, w: 1, h: 1 });
    expect([...boxMeanBytes(acc, 255)]).toEqual([7, 255, 255, 255]);
  });
});
