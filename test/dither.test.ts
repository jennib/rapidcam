/**
 * Dithering core tests. `dither()` is a pure 1-bit quantiser, so these exercise it
 * directly on synthetic darkness fields: the extremes must be exact (all-black →
 * all on, all-white → all off), the error-diffusion kernels must preserve the mean
 * darkness (that's the whole point of diffusion), and the ordered map must be the
 * deterministic per-cell Bayer threshold. Also guards the degenerate inputs and the
 * no-mutation contract the callers rely on.
 */

import { test, expect, describe } from "vitest";
import { dither, DITHER_MODES, type DitherMode } from "../src/cam/dither";

const DIFFUSION: DitherMode[] = ["floyd-steinberg", "atkinson", "jarvis"];

/** Fraction of fired dots. */
function onFraction(map: Uint8Array): number {
  let n = 0;
  for (const v of map) n += v;
  return n / map.length;
}

function uniform(w: number, h: number, darkness: number): Float32Array {
  return new Float32Array(w * h).fill(darkness);
}

describe("extremes are exact for every mode", () => {
  for (const mode of DITHER_MODES) {
    test(`${mode}: all-black → all on, all-white → all off`, () => {
      const black = dither(uniform(16, 16, 1), 16, 16, mode);
      const white = dither(uniform(16, 16, 0), 16, 16, mode);
      expect(onFraction(black)).toBe(1);
      expect(onFraction(white)).toBe(0);
    });
  }
});

describe("error diffusion preserves the mean", () => {
  for (const mode of DIFFUSION) {
    test(`${mode}: uniform 0.5 field → ~50% dots`, () => {
      const map = dither(uniform(64, 64, 0.5), 64, 64, mode);
      // Atkinson deliberately drops 1/4 of the error (higher contrast), so it drifts
      // further from the mean than FS/Jarvis; still comfortably a spread of dots.
      const tol = mode === "atkinson" ? 0.15 : 0.05;
      expect(onFraction(map)).toBeGreaterThan(0.5 - tol);
      expect(onFraction(map)).toBeLessThan(0.5 + tol);
    });

    test(`${mode}: horizontal gradient keeps overall density ≈ mean darkness`, () => {
      const w = 96;
      const h = 64;
      const dk = new Float32Array(w * h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) dk[y * w + x] = x / (w - 1); // 0 (left) → 1 (right), mean 0.5
      const map = dither(dk, w, h, mode);
      const tol = mode === "atkinson" ? 0.12 : 0.04;
      expect(onFraction(map)).toBeGreaterThan(0.5 - tol);
      expect(onFraction(map)).toBeLessThan(0.5 + tol);
      // The dark (right) edge must be denser than the light (left) edge.
      let leftCol = 0;
      let rightCol = 0;
      for (let y = 0; y < h; y++) {
        leftCol += map[y * w + 0];
        rightCol += map[y * w + (w - 1)];
      }
      expect(rightCol).toBeGreaterThan(leftCol);
    });
  }
});

describe("ordered (Bayer)", () => {
  test("uniform 0.5 over an 8-multiple grid fires exactly half the cells", () => {
    const map = dither(uniform(64, 64, 0.5), 64, 64, "ordered");
    expect(onFraction(map)).toBe(0.5);
  });

  test("is a pure per-cell threshold — a cell's output ignores its neighbours", () => {
    // Same cell value in two different surroundings ⇒ same decision (no diffusion).
    const a = dither(uniform(8, 8, 0.4), 8, 8, "ordered");
    const b = new Float32Array(8 * 8).fill(0.9);
    b[3 * 8 + 5] = 0.4; // one 0.4 cell amid dark cells
    const bMap = dither(b, 8, 8, "ordered");
    expect(bMap[3 * 8 + 5]).toBe(a[3 * 8 + 5]);
  });
});

test('"none" and degenerate sizes yield an all-zero / empty map', () => {
  expect(onFraction(dither(uniform(8, 8, 1), 8, 8, "none"))).toBe(0);
  expect(dither(uniform(0, 4, 1), 0, 4, "floyd-steinberg").length).toBe(0);
  expect(dither(new Float32Array(0), 4, 0, "ordered").length).toBe(0);
});

test("the input darkness buffer is not mutated", () => {
  const src = uniform(16, 16, 0.5);
  const copy = Float32Array.from(src);
  dither(src, 16, 16, "floyd-steinberg");
  expect(src).toEqual(copy);
});

test("output is deterministic (same input → identical map)", () => {
  const dk = uniform(32, 24, 0.37);
  for (const mode of DITHER_MODES) {
    const first = dither(dk, 32, 24, mode);
    const second = dither(dk, 32, 24, mode);
    expect(second).toEqual(first);
  }
});
