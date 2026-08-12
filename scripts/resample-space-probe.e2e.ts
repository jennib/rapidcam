/**
 * Which colour space should a raster be box-averaged in?
 *
 * Deferred from #48, which fixed the import downscale to average every source
 * pixel but deliberately left the averaging in sRGB. "Average in linear light"
 * is the standard graphics answer, so the question was whether the relief and
 * engrave paths are losing something by not doing it.
 *
 * The probe does not argue the point, it measures it. For each output cell it
 * computes the GROUND TRUTH from the full-resolution pixels — the quantity the
 * downsampled cell is supposed to stand in for — and asks which averaging space
 * reproduces it. That quantity is different for the two consumers:
 *
 *   relief depth  (tone: "encoded")  z ∝ (1 − v)^gamma   → mean CARVED DEPTH
 *   halftone      (tone: "linear")   c = 1 − linear(v)   → mean AREA COVERAGE
 *
 * Run:  npx playwright test -c probe.config.ts resample-space-probe
 *
 * (`probe.config.ts` at the repo root is the base e2e config with testDir moved
 * to scripts/ — the main config pins testDir to e2e/ and Playwright has no
 * command-line override for it. It stays at the root because the base config's
 * globalTeardown path is relative to the config file's own directory.)
 */
import { test } from "@playwright/test";

const APP_URL = "http://127.0.0.1:5173/";

/** Real content from the repo, plus synthetic cases that bracket the range. */
const IMAGES = [
  "/docs/screenshots/editor.png",
  "/docs/screenshots/cam.png",
  "/docs/screenshots/constraints.png",
  "/rapidcam-logo.png",
];

const REDUCTIONS = [2, 4, 8];
const MAX_DEPTH_MM = 3; // DEFAULTS.depth
const GAMMAS = [1, 1.8];

test("which space should a downscale average in", async ({ page }) => {
  test.setTimeout(300_000);
  page.on("console", (m) => console.log(`  [page] ${m.text()}`));
  await page.goto(APP_URL);

  const rows = await page.evaluate(
    async ({ IMAGES, REDUCTIONS, MAX_DEPTH_MM, GAMMAS }) => {
      const srgbToLinear = (v: number) =>
        v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      const linearToSrgb = (v: number) =>
        v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;

      /** Full-resolution greyscale 0..255, matching imageManager.toGreyscale. */
      async function greyOf(src: string): Promise<{ g: Float64Array; w: number; h: number }> {
        const img = new Image();
        img.src = src;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const cx = c.getContext("2d", { willReadFrequently: true })!;
        cx.drawImage(img, 0, 0);
        const d = cx.getImageData(0, 0, c.width, c.height).data;
        const g = new Float64Array(c.width * c.height);
        for (let i = 0; i < g.length; i++) {
          const a = d[i * 4 + 3];
          const lum = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
          g[i] = a === 255 ? lum : lum * (a / 255) + 255 * (1 - a / 255);
        }
        return { g, w: c.width, h: c.height };
      }

      function synth(kind: string, n: number): { g: Float64Array; w: number; h: number } {
        const g = new Float64Array(n * n);
        for (let y = 0; y < n; y++)
          for (let x = 0; x < n; x++) {
            let v: number;
            if (kind === "checker-1px") v = (x + y) % 2 ? 255 : 0;
            else if (kind === "sparse-dots") v = x % 4 === 0 && y % 4 === 0 ? 0 : 255;
            else if (kind === "gradient") v = (x / (n - 1)) * 255;
            else v = ((Math.sin(x * 0.11) + Math.cos(y * 0.07)) * 0.25 + 0.5) * 255; // mid-freq
            g[y * n + x] = v;
          }
        return { g, w: n, h: n };
      }

      const cell = (p: number, srcN: number, outN: number) =>
        Math.min(outN - 1, Math.floor((p * outN) / srcN));

      type Row = Record<string, string | number>;
      const out: Row[] = [];

      async function measure(name: string, srcData: { g: Float64Array; w: number; h: number }) {
        const { g, w: sw, h: sh } = srcData;
        for (const red of REDUCTIONS) {
          const ow = Math.max(1, Math.round(sw / red));
          const oh = Math.max(1, Math.round(sh / red));
          const n = ow * oh;
          const cnt = new Float64Array(n);
          const sumEnc = new Float64Array(n); // Σ v            (current: average encoded)
          const sumLin = new Float64Array(n); // Σ linear(v)    (average in linear light)
          const sumCov = new Float64Array(n); // Σ coverage     (ground truth, halftone)
          const sumDep: Float64Array[] = GAMMAS.map(() => new Float64Array(n)); // ground-truth depth

          const colOf = new Int32Array(sw);
          for (let x = 0; x < sw; x++) colOf[x] = cell(x, sw, ow);
          for (let y = 0; y < sh; y++) {
            const base = cell(y, sh, oh) * ow;
            for (let x = 0; x < sw; x++) {
              const v = g[y * sw + x] / 255;
              const i = base + colOf[x];
              cnt[i]++;
              sumEnc[i] += v;
              const lin = srgbToLinear(v);
              sumLin[i] += lin;
              sumCov[i] += 1 - lin;
              for (let k = 0; k < GAMMAS.length; k++)
                sumDep[k][i] += (1 - v) ** GAMMAS[k] * MAX_DEPTH_MM;
            }
          }

          // Per-cell error of each averaging space against the ground truth.
          const acc = {
            depth: GAMMAS.map(() => ({ enc: 0, lin: 0, encMax: 0, linMax: 0 })),
            cov: { enc: 0, lin: 0, encMax: 0, linMax: 0 },
            tone: { d: 0, dMax: 0 },
          };
          for (let i = 0; i < n; i++) {
            if (!cnt[i]) continue;
            const mEnc = sumEnc[i] / cnt[i]; // what the code does today
            const mLin = sumLin[i] / cnt[i];
            const vLin = linearToSrgb(mLin); // linear-averaged, re-encoded for storage

            const dTone = Math.abs(mEnc - vLin) * 255;
            acc.tone.d += dTone;
            acc.tone.dMax = Math.max(acc.tone.dMax, dTone);

            for (let k = 0; k < GAMMAS.length; k++) {
              const truth = sumDep[k][i] / cnt[i];
              const eEnc = Math.abs((1 - mEnc) ** GAMMAS[k] * MAX_DEPTH_MM - truth);
              const eLin = Math.abs((1 - vLin) ** GAMMAS[k] * MAX_DEPTH_MM - truth);
              acc.depth[k].enc += eEnc;
              acc.depth[k].lin += eLin;
              acc.depth[k].encMax = Math.max(acc.depth[k].encMax, eEnc);
              acc.depth[k].linMax = Math.max(acc.depth[k].linMax, eLin);
            }

            const truthCov = sumCov[i] / cnt[i];
            const cEnc = Math.abs(1 - srgbToLinear(mEnc) - truthCov);
            const cLin = Math.abs(1 - srgbToLinear(vLin) - truthCov);
            acc.cov.enc += cEnc;
            acc.cov.lin += cLin;
            acc.cov.encMax = Math.max(acc.cov.encMax, cEnc);
            acc.cov.linMax = Math.max(acc.cov.linMax, cLin);
          }

          const row: Row = { image: name, reduce: `${red}x`, cells: n };
          row["tone Δ mean"] = +(acc.tone.d / n).toFixed(2);
          row["tone Δ max"] = +acc.tone.dMax.toFixed(1);
          for (let k = 0; k < GAMMAS.length; k++) {
            row[`depth γ${GAMMAS[k]} sRGB µm`] = +((acc.depth[k].enc / n) * 1000).toFixed(3);
            row[`depth γ${GAMMAS[k]} lin µm`] = +((acc.depth[k].lin / n) * 1000).toFixed(3);
            row[`depth γ${GAMMAS[k]} lin max µm`] = +(acc.depth[k].linMax * 1000).toFixed(1);
          }
          row["cover sRGB %"] = +((acc.cov.enc / n) * 100).toFixed(2);
          row["cover lin %"] = +((acc.cov.lin / n) * 100).toFixed(2);
          row["cover sRGB max %"] = +(acc.cov.encMax * 100).toFixed(1);
          out.push(row);
        }
      }

      for (const src of IMAGES) {
        try {
          await measure(src.split("/").pop()!, await greyOf(src));
        } catch (e) {
          console.log(`skip ${src}: ${e}`);
        }
      }
      for (const k of ["checker-1px", "sparse-dots", "gradient", "midfreq"])
        await measure(k, synth(k, 1024));

      return out;
    },
    { IMAGES, REDUCTIONS, MAX_DEPTH_MM, GAMMAS },
  );

  console.log("\n=== error vs full-resolution ground truth (lower = better) ===\n");
  console.table(rows);
});
