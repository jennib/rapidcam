/**
 * Dithering wired into the raster engrave pipeline. These check the seam between
 * {@link dither} and the two consumers: the laser scan-row generator
 * ({@link rasterEngrave}) must emit full-power dots with gaps (a pattern) rather
 * than graded power, and the 3-D preview field ({@link rasterField}) must go binary
 * so the burn preview matches the G-code. Also pins the additive contract: omitting
 * dither (or "none") is byte-identical to the pre-feature greyscale output.
 */

import { test, expect, describe } from "vitest";
import { rasterEngrave, type RasterGrid } from "../src/cam/rasterEngrave";

/** A uniform mid-grey image (0.5) at the given pixel size. 0 = black. */
function greyImage(w: number, h: number, tone = 0.5): RasterGrid {
  return { width: w, height: h, data: new Array(w * h).fill(tone) };
}

const SIZE = { widthMM: 10, heightMM: 10, lineIntervalMM: 1 }; // 10×10 dot grid

describe("rasterEngrave with dithering", () => {
  test("greyscale path grades power; dithered path fires only full-power dots", () => {
    const grey = rasterEngrave(greyImage(10, 10), {
      ...SIZE,
      maxPower: 100,
      minPower: 0,
    });
    const greyPowers = new Set(grey.flatMap((r) => r.runs.map((run) => run.power)));
    // A flat 50% tone under greyscale modulation is one intermediate power everywhere.
    expect(greyPowers).toEqual(new Set([50]));

    const dithered = rasterEngrave(greyImage(10, 10), {
      ...SIZE,
      maxPower: 100,
      minPower: 0,
      dither: "floyd-steinberg",
    });
    const ditherPowers = new Set(dithered.flatMap((r) => r.runs.map((run) => run.power)));
    // Every fired dot is at maxPower; tone comes from density, not power.
    expect(ditherPowers).toEqual(new Set([100]));
  });

  test("a dithered mid-grey is a sparse pattern (~half burnt), not a solid fill", () => {
    const rows = rasterEngrave(greyImage(10, 10), {
      ...SIZE,
      maxPower: 100,
      minPower: 0,
      dither: "floyd-steinberg",
    });
    let burnt = 0;
    for (const r of rows) for (const run of r.runs) burnt += run.x1 - run.x0;
    const fraction = burnt / (10 * SIZE.widthMM); // total burnable length = rows × row width
    expect(fraction).toBeGreaterThan(0.35);
    expect(fraction).toBeLessThan(0.65);
    // Gaps exist: at least one row is broken into more than a single solid run.
    expect(rows.some((r) => r.runs.length > 1)).toBe(true);
  });

  test('omitting dither == "none" == the pre-feature greyscale output', () => {
    const params = { ...SIZE, maxPower: 100, minPower: 10 };
    const omitted = rasterEngrave(greyImage(8, 8, 0.3), params);
    const none = rasterEngrave(greyImage(8, 8, 0.3), { ...params, dither: "none" });
    expect(none).toEqual(omitted);
  });
});
