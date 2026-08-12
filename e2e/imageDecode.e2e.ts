/**
 * Import-time image downscaling, in a real browser.
 *
 * `decodeImageFile` is the one part of the raster pipeline unit tests cannot
 * reach: it needs `createImageBitmap`, a canvas 2D context and `getImageData`,
 * none of which exist in happy-dom. Its box-average kernel is covered by
 * `test/resample.test.ts`; what is only checkable here is that the decode feeds
 * that kernel every source pixel — i.e. that the tiled 1:1 blits actually cover
 * the source and no scaled `drawImage` sneaks a sampling filter back in.
 */
import { test, expect, APP_URL } from "./appFixture";

test("import downscale area-averages the whole source, not a 2×2 sample", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(APP_URL);

  const result = await page.evaluate(async () => {
    const SRC = 4000; // 4× the 1000px cap → each output cell covers exactly 4×4 source px
    // One black pixel per 4×4 block, white elsewhere. Chosen because it separates
    // the two filters unambiguously: the true area average is a uniform
    // (15·255 + 0)/16 = 239.06 → 239, while any 2×2-neighbourhood sampler misses
    // the lone black pixel in most cells and returns 255 for them. A checkerboard
    // would NOT discriminate — its 2×2 average is mid-grey by coincidence.
    const src = document.createElement("canvas");
    src.width = SRC;
    src.height = SRC;
    const sctx = src.getContext("2d")!;
    const img = sctx.createImageData(SRC, SRC);
    for (let y = 0; y < SRC; y++) {
      for (let x = 0; x < SRC; x++) {
        const v = x % 4 === 0 && y % 4 === 0 ? 0 : 255;
        const i = (y * SRC + x) * 4;
        img.data[i] = v;
        img.data[i + 1] = v;
        img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    }
    sctx.putImageData(img, 0, 0);

    const blob: Blob = await new Promise((res) => src.toBlob((b) => res(b!), "image/png")!);
    const file = new File([blob], "sparse.png", { type: "image/png" });

    // Served by the dev server as native ESM — `page.evaluate` bodies never go
    // through Vite, so this is a plain browser dynamic import. Held in a variable
    // so tsc treats the specifier as dynamic rather than trying to resolve a URL
    // that only exists at runtime.
    const modUrl = "/src/core/imageManager.ts";
    const { decodeImageFile } = (await import(modUrl)) as {
      decodeImageFile: (f: File) => Promise<{ width: number; height: number; gray: Uint8Array }>;
    };
    const decoded = await decodeImageFile(file);

    let min = 255;
    let max = 0;
    for (const g of decoded.gray) {
      if (g < min) min = g;
      if (g > max) max = g;
    }
    return { width: decoded.width, height: decoded.height, min, max, len: decoded.gray.length };
  });

  expect(result.width).toBe(1000);
  expect(result.height).toBe(1000);
  expect(result.len).toBe(1_000_000);
  // Uniform 239 across every cell: every source pixel was counted, in all four
  // decode tiles (4000px source at a 2048px tile edge → a 2×2 tile grid).
  expect(result.min).toBe(239);
  expect(result.max).toBe(239);
});
