/**
 * Look at what the STL importer and heightfield rasteriser actually produce.
 *
 * Green tests have drawn the wrong shape in this project before, so both stages
 * get rendered and read by eye before anything is asserted about them.
 *
 * Run: npx tsx scripts/stl-probe.ts
 */
import { stlHeightfield, type Heightfield } from "../src/cam/stlHeightfield";
import { parseSTL, isBinarySTL, type STLMesh } from "../src/io/stlImport";
import { asciiSTL, binarySTL, hemisphere, steppedBlock } from "../test/stlFixtures";

const f3 = (v: number) => v.toFixed(3).padStart(8);

function report(label: string, m: STLMesh): void {
  console.log(
    `${label.padEnd(22)} ${m.format.padEnd(6)} tris=${String(m.count).padStart(5)} ` +
      `dropped=${m.dropped}  x[${f3(m.min.x)},${f3(m.max.x)}] ` +
      `y[${f3(m.min.y)},${f3(m.max.y)}] z[${f3(m.min.z)},${f3(m.max.z)}]` +
      (m.name ? `  name="${m.name}"` : ""),
  );
}

const dome = hemisphere(10, 24, 48);
const stair = steppedBlock(30, 30, 3, 2);

console.log("=== format detection ===");
const domeBin = binarySTL(dome);
const domeAsc = asciiSTL(dome, "dome");
console.log(`binary fixture header starts with "solid": ${
  new TextDecoder().decode(new Uint8Array(domeBin, 0, 5)) === "solid"
}`);
console.log(`isBinarySTL(binary) = ${isBinarySTL(domeBin)}   (must be true)`);
console.log(`isBinarySTL(ascii)  = ${isBinarySTL(domeAsc)}   (must be false)`);

console.log("\n=== parse ===");
report("hemisphere R10 bin", parseSTL(domeBin));
report("hemisphere R10 ascii", parseSTL(domeAsc));
report("stepped block bin", parseSTL(binarySTL(stair)));
report("stepped block ascii", parseSTL(asciiSTL(stair, "stair")));

console.log("\n=== both encodings must agree vertex-for-vertex ===");
const a = parseSTL(domeBin);
const b = parseSTL(domeAsc);
let worst = 0;
for (let i = 0; i < a.vertices.length; i++)
  worst = Math.max(worst, Math.abs(a.vertices[i] - b.vertices[i]));
console.log(`count ${a.count} vs ${b.count}; worst vertex delta = ${worst}`);

console.log("\n=== NaN handling ===");
const poisoned = dome.slice(0, 10).map((t, i) => (i === 3 ? [...t.slice(0, 4), NaN, ...t.slice(5)] : t));
const pm = parseSTL(binarySTL(poisoned));
report("10 tris, 1 NaN", pm);
console.log(`bounds finite: ${[pm.min.x, pm.max.z].every(Number.isFinite)} (must be true)`);

console.log("\n=== degenerate inputs ===");
report("empty buffer", parseSTL(new ArrayBuffer(0)));
report("zero triangles", parseSTL(binarySTL([])));
report("garbage text", parseSTL(new TextEncoder().encode("not an stl at all").buffer as ArrayBuffer));

// ---------------------------------------------------------------------------
// The heightfield. LOOK at it.
// ---------------------------------------------------------------------------

const RAMP = " .:-=+*#%@"; // 255 (model top, no cut) = '@'

function show(hf: Heightfield, label: string): void {
  console.log(
    `\n--- ${label}: ${hf.width}×${hf.height} cells, ` +
      `${hf.widthMM.toFixed(2)}×${hf.heightMM.toFixed(2)}mm, ` +
      `z ${hf.zMinMM.toFixed(3)}..${hf.zMaxMM.toFixed(3)}mm, empty=${hf.emptyCells}`,
  );
  for (let r = 0; r < hf.height; r++) {
    let line = "";
    for (let c = 0; c < hf.width; c++) {
      const v = hf.gray[r * hf.width + c];
      line += RAMP[Math.min(RAMP.length - 1, Math.floor((v / 255) * RAMP.length))];
    }
    console.log(`  ${line}`);
  }
}

const domeMesh = parseSTL(domeBin);
show(stlHeightfield(domeMesh, { cellMM: 0.5 }), "hemisphere R10, +Z up");
show(stlHeightfield(parseSTL(binarySTL(stair)), { cellMM: 0.8 }), "stepped block, +Z up");
show(stlHeightfield(domeMesh, { cellMM: 0.5, up: "+Y" }), "hemisphere, +Y up (dome on its side)");

console.log("\n=== asymmetric shape: is the row order right? ===");
// One tall step at HIGH Y. Row 0 is the top of the image = max Y, so the tall
// step must appear on the TOP rows. Get this backwards and every carve is
// mirrored in Y with nothing to show for it.
const wedge = steppedBlock(20, 20, 4, 3);
show(stlHeightfield(parseSTL(binarySTL(wedge)), { cellMM: 1 }), "4 steps rising toward +Y");

console.log("\n=== the defining invariant: z(r) = sqrt(R^2 - r^2) ===");
{
  const R = 10;
  const hf = stlHeightfield(parseSTL(binarySTL(hemisphere(R, 64, 128))), { cellMM: 0.25 });
  const cw = hf.widthMM / hf.width;
  const chh = hf.heightMM / hf.height;
  let worstErr = 0;
  let worstAt = "";
  let checked = 0;
  for (let r = 0; r < hf.height; r++) {
    const y = hf.heightMM / 2 - (r + 0.5) * chh; // centre of the dome at 0
    for (let c = 0; c < hf.width; c++) {
      const x = -hf.widthMM / 2 + (c + 0.5) * cw;
      const rad = Math.hypot(x, y);
      if (rad > R - 0.5) continue; // skip the rim, where a cell straddles the edge
      const want = Math.sqrt(R * R - rad * rad);
      const got = (hf.gray[r * hf.width + c] / 255) * (hf.zMaxMM - hf.zMinMM) + hf.zMinMM;
      checked++;
      if (Math.abs(want - got) > worstErr) {
        worstErr = Math.abs(want - got);
        worstAt = `r=${rad.toFixed(2)} want ${want.toFixed(4)} got ${got.toFixed(4)}`;
      }
    }
  }
  console.log(`cells checked ${checked}, cell size ${cw.toFixed(4)}mm`);
  console.log(`worst error ${worstErr.toFixed(5)}mm at ${worstAt}`);
  console.log(`within one cell (${cw.toFixed(4)}mm)? ${worstErr <= cw}`);
}

console.log("\n=== cost: measure before reaching for a Worker ===");
for (const [R, nLat, cell] of [
  [10, 24, 0.5],
  [10, 64, 0.25],
  [10, 180, 0.1],
  [100, 300, 0.2], // ~360k triangles onto the full 1000×1000 cap
] as const) {
  const t0 = performance.now();
  const m = parseSTL(binarySTL(hemisphere(R, nLat, nLat * 2)));
  const t1 = performance.now();
  const hf = stlHeightfield(m, { cellMM: cell });
  const t2 = performance.now();
  console.log(
    `  ${String(m.count).padStart(6)} tris → ${hf.width}×${hf.height} grid: ` +
      `parse ${(t1 - t0).toFixed(1)}ms + raster ${(t2 - t1).toFixed(1)}ms`,
  );
}

// ---------------------------------------------------------------------------
// EDGE_EPS: the measurement the constant's comment cites.
// ---------------------------------------------------------------------------

console.log("\n=== worst on-edge barycentric weight vs sliver aspect ===");
console.log("  size(mm)  thin(mm)   aspect     coord^2/area   worst min-barycentric");

/** The weights exactly as `stlHeightfield` computes them, winding normalised. */
function baryMin(
  au: number, av: number, bu: number, bv: number, cu: number, cv: number,
  px: number, py: number,
): number {
  let area2 = (bu - au) * (cv - av) - (bv - av) * (cu - au);
  let Bu = bu, Bv = bv, Cu = cu, Cv = cv;
  if (area2 < 0) {
    [Bu, Cu] = [cu, bu];
    [Bv, Cv] = [cv, bv];
    area2 = -area2;
  }
  const w0 = ((Bu - px) * (Cv - py) - (Bv - py) * (Cu - px)) / area2;
  const w1 = ((Cu - px) * (av - py) - (Cv - py) * (au - px)) / area2;
  return Math.min(w0, w1, 1 - w0 - w1);
}

let worstEverywhere = 0;
for (const size of [10, 100, 1000]) {
  for (const thin of [1, 1e-2, 1e-4, 1e-6, 1e-8]) {
    let worst = 0;
    // Quad (0,0)-(size,0)-(size,thin)-(0,thin) split by the diagonal (0,0)-(size,thin);
    // sample points lying EXACTLY on that shared diagonal.
    for (let k = 1; k < 400; k++) {
      const t = k / 400;
      const px = size * t,
        py = thin * t;
      const a = baryMin(0, 0, size, 0, size, thin, px, py);
      const b = baryMin(0, 0, size, thin, 0, thin, px, py);
      worst = Math.min(worst, Math.max(a, b)); // whichever triangle claims it more strongly
    }
    worstEverywhere = Math.min(worstEverywhere, worst);
    const area = (size * thin) / 2;
    console.log(
      `  ${String(size).padEnd(9)} ${String(thin).padEnd(10)} ` +
        `${(size / thin).toExponential(1).padEnd(10)} ` +
        `${((size * size) / area).toExponential(2).padEnd(14)} ${worst.toExponential(3)}`,
    );
  }
}
console.log(
  `\n  Worst overall: ${worstEverywhere.toExponential(3)} — FLAT across aspect, not growing\n` +
    `  with coord^2/area, because the differenced products scale with the triangle's own\n` +
    `  area and the division by area2 cancels it back out. EDGE_EPS=1e-7 clears this by\n` +
    `  ~${Math.round(Math.log10(1e-7 / Math.abs(worstEverywhere)))} orders of magnitude.`,
);
