/**
 * Dithering for 1-bit (beam on/off) raster laser engraving.
 *
 * The greyscale raster path in {@link ./rasterEngrave} modulates beam POWER per
 * dot — darker ⇒ more power. On many diode lasers the power→burn response is very
 * non-linear, so mid-tones come out muddy and inconsistent. Dithering sidesteps
 * that: every dot fires at a single power (or not at all), and TONE is reproduced
 * by the *density* of fired dots. That maps far more predictably onto how a
 * material actually scorches, and is what most laser software offers for photos.
 *
 * This module is the algorithmic core: it turns a physical dot grid of darkness
 * values into a 0/1 map. It is deliberately free of any laser/power/G-code concern
 * so it can be unit-tested in isolation and shared by both the flat preview + the
 * G-code emitter (via rasterEngrave) and the 3-D burn preview (via rasterField).
 *
 * Two families are supported:
 *  - **Error diffusion** (Floyd–Steinberg, Atkinson, Jarvis–Judice–Ninke): each
 *    dot is thresholded, and the quantisation error is spread to not-yet-visited
 *    neighbours so the local average darkness is preserved. Scanned in a serpentine
 *    (boustrophedon) order to avoid directional "worm" artefacts. FS is the classic
 *    all-rounder; Jarvis diffuses over a wider area (smoother, softer); Atkinson
 *    propagates only 6/8 of the error (higher contrast / cleaner on wood, at the
 *    cost of some highlight/shadow detail).
 *  - **Ordered** (8×8 Bayer): a fixed threshold map, fully deterministic, giving a
 *    regular cross-hatch texture. Fast and tileable, less photographic.
 *
 * Grid convention: `darkness[y*w + x] ∈ [0,1]`, 1 = darkest = fire the beam. Row
 * order is whatever the caller uses — error diffusion only ever pushes error to the
 * current or lower rows, so any consistent top→bottom or bottom→top order works.
 */

export type DitherMode = "none" | "floyd-steinberg" | "atkinson" | "jarvis" | "ordered";

/** All selectable modes, in UI order (excludes "none"). */
export const DITHER_MODES: ReadonlyArray<Exclude<DitherMode, "none">> = [
  "floyd-steinberg",
  "atkinson",
  "jarvis",
  "ordered",
];

/** Human labels for the UI dropdown. */
export const DITHER_LABELS: Record<DitherMode, string> = {
  none: "Off (greyscale power)",
  "floyd-steinberg": "Floyd–Steinberg",
  atkinson: "Atkinson",
  jarvis: "Jarvis",
  ordered: "Ordered (Bayer)",
};

/** One error-diffusion kernel: neighbour taps `[dx, dy, weight]` + the weight divisor. */
interface DiffusionKernel {
  divisor: number;
  /** `dx` is to the RIGHT along the scan direction, `dy` is DOWNWARD (never negative). */
  taps: ReadonlyArray<readonly [number, number, number]>;
}

const KERNELS: Record<"floyd-steinberg" | "atkinson" | "jarvis", DiffusionKernel> = {
  "floyd-steinberg": {
    divisor: 16,
    taps: [
      [1, 0, 7],
      [-1, 1, 3],
      [0, 1, 5],
      [1, 1, 1],
    ],
  },
  atkinson: {
    // Divisor 8 but the taps sum to 6 — only 3/4 of the error is propagated. The
    // "lost" error is what gives Atkinson its punchier, higher-contrast look.
    divisor: 8,
    taps: [
      [1, 0, 1],
      [2, 0, 1],
      [-1, 1, 1],
      [0, 1, 1],
      [1, 1, 1],
      [0, 2, 1],
    ],
  },
  jarvis: {
    divisor: 48,
    taps: [
      [1, 0, 7],
      [2, 0, 5],
      [-2, 1, 3],
      [-1, 1, 5],
      [0, 1, 7],
      [1, 1, 5],
      [2, 1, 3],
      [-2, 2, 1],
      [-1, 2, 3],
      [0, 2, 5],
      [1, 2, 3],
      [2, 2, 1],
    ],
  },
};

// Standard 8×8 Bayer (recursive) threshold matrix, values 0..63, row-major.
// prettier-ignore
const BAYER8 = [
   0, 32,  8, 40,  2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44,  4, 36, 14, 46,  6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
   3, 35, 11, 43,  1, 33,  9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47,  7, 39, 13, 45,  5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Dither an `w × h` darkness field (`0..1`, 1 = fire) to a 0/1 map of the same
 * shape and order. Returns an all-zero map for degenerate sizes or `mode: "none"`.
 * The input is not mutated (error diffusion works on a copy).
 */
export function dither(
  darkness: Float32Array | number[],
  w: number,
  h: number,
  mode: DitherMode,
): Uint8Array {
  const out = new Uint8Array(Math.max(0, w * h));
  if (w <= 0 || h <= 0 || mode === "none") return out;

  if (mode === "ordered") {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = (BAYER8[(y & 7) * 8 + (x & 7)] + 0.5) / 64; // cell threshold in (0,1)
        out[y * w + x] = clamp01(darkness[y * w + x]) > t ? 1 : 0;
      }
    }
    return out;
  }

  const kernel = KERNELS[mode];
  // Mutable float copy: error is pushed forward into not-yet-visited neighbours.
  const buf = Float32Array.from(darkness as ArrayLike<number>, clamp01);
  for (let y = 0; y < h; y++) {
    const leftToRight = (y & 1) === 0; // serpentine scan
    for (let k = 0; k < w; k++) {
      const x = leftToRight ? k : w - 1 - k;
      const i = y * w + x;
      const on = buf[i] >= 0.5 ? 1 : 0;
      out[i] = on;
      const err = buf[i] - on; // signed quantisation error
      if (err === 0) continue;
      for (const [dx0, dy, wt] of kernel.taps) {
        const nx = x + (leftToRight ? dx0 : -dx0); // mirror the kernel on right→left rows
        const ny = y + dy; // dy ≥ 0, so ny is always in range at the bottom check
        if (nx < 0 || nx >= w || ny >= h) continue;
        buf[ny * w + nx] += (err * wt) / kernel.divisor;
      }
    }
  }
  return out;
}
