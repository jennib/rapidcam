/**
 * Is an imported model relief-shaped? Measure the candidate signals on REAL
 * files before choosing one, and before choosing a threshold.
 *
 * Phase 1.5 of the STL plan proposes thresholding `emptyCells / totalCells`.
 * That number is not a property of the model's depth at all — it is one minus the
 * area of the model's SHADOW divided by the area of its bounding rectangle. So
 * this probe computes it alongside a candidate that measures the thing we
 * actually care about, and prints both for every file it is given.
 *
 * Run: npx tsx scripts/stl-relief-probe.ts <file-or-dir>...
 *      npx tsx scripts/stl-relief-probe.ts            (synthetic shapes only)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { PLINTH_WARN, stlHeightfield, type Heightfield, type UpAxis } from "../src/cam/stlHeightfield";
import { parseSTL, suggestUnitScale, type STLMesh } from "../src/io/stlImport";
import {
  binarySTL,
  hemisphere,
  hollowBall,
  sphere,
  steppedBlock,
  type Tri,
} from "../test/stlFixtures";

// ---------------------------------------------------------------------------
// Candidate signal A — the plan's proposal.
// ---------------------------------------------------------------------------

/** Cells no triangle covered, over all cells. */
function emptyRatio(hf: Heightfield): number {
  return hf.emptyCells / (hf.width * hf.height);
}

// ---------------------------------------------------------------------------
// Candidate signal B — how much of what gets carved is not the model.
//
// The carve leaves the solid E = { zMin <= z <= zTop(x,y) }. The model S is a
// SUBSET of E for any closed mesh, because every interior point sits below the
// topmost surface above it and above the model's own minimum. So
//
//     wasted = 1 - vol(S) / vol(E)
//
// is in [0,1] and is literally "the fraction of the carved solid the model does
// not contain" — undercuts, hollows and everything a 3-axis pass fills in solid.
// ---------------------------------------------------------------------------

interface MeshVolume {
  /** |signed volume|, in model units cubed. */
  volume: number;
  /**
   * How far the area-weighted normals fail to cancel, over total area.
   *
   * Exactly zero for a closed, consistently wound mesh, and the signed volume
   * means nothing when it is not — an open surface's "volume" depends on where
   * you put the origin.
   */
  closure: number;
  area: number;
}

function meshVolume(mesh: STLMesh): MeshVolume {
  // Centre the coordinates: the sum of a.(bxc) cancels catastrophically when a
  // small model sits far from the origin.
  const ox = (mesh.min.x + mesh.max.x) / 2;
  const oy = (mesh.min.y + mesh.max.y) / 2;
  const oz = (mesh.min.z + mesh.max.z) / 2;
  const v = mesh.vertices;
  let v6 = 0;
  let nx = 0,
    ny = 0,
    nz = 0;
  let area2 = 0;
  for (let t = 0; t < mesh.count; t++) {
    const o = t * 9;
    const ax = v[o] - ox,
      ay = v[o + 1] - oy,
      az = v[o + 2] - oz;
    const bx = v[o + 3] - ox,
      by = v[o + 4] - oy,
      bz = v[o + 5] - oz;
    const cx = v[o + 6] - ox,
      cy = v[o + 7] - oy,
      cz = v[o + 8] - oz;
    // (b-a) x (c-a), i.e. twice the area-weighted normal.
    const ux = bx - ax,
      uy = by - ay,
      uz = bz - az;
    const wx = cx - ax,
      wy = cy - ay,
      wz = cz - az;
    const px = uy * wz - uz * wy;
    const py = uz * wx - ux * wz;
    const pz = ux * wy - uy * wx;
    nx += px;
    ny += py;
    nz += pz;
    area2 += Math.hypot(px, py, pz);
    // a . (b x c) = 6 x the signed tetrahedron volume to the origin.
    v6 += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return {
    volume: Math.abs(v6) / 6,
    closure: area2 > 0 ? Math.hypot(nx, ny, nz) / area2 : 1,
    area: area2 / 2,
  };
}

/** Volume the carve leaves above the base plane, from the heightfield itself. */
function carvedVolume(hf: Heightfield): number {
  const cellArea = (hf.widthMM / hf.width) * (hf.heightMM / hf.height);
  const range = hf.zMaxMM - hf.zMinMM;
  if (!(range > 0)) return 0;
  let sum = 0;
  for (let i = 0; i < hf.gray.length; i++) sum += hf.gray[i];
  return (sum / 255) * range * cellArea;
}

// ---------------------------------------------------------------------------
// Candidate signal C — undercut AREA, not volume.
//
// A vertical ray through a shape with no undercut enters and leaves the solid
// exactly once: two surface crossings. Four or more means there is material with
// void beneath it, which is precisely what a 3-axis pass cannot make.
//
// This is an AREA measure on purpose. A mane strand overhanging its own jaw ruins
// the carving and costs almost nothing in volume, so signal B is blind to it by
// construction; the question this answers is whether C sees what B misses.
//
// NOTE: this re-implements the projection loop of `stlHeightfield` rather than
// reusing it, because the shipping rasteriser keeps only the max and discards the
// crossings. That is a duplicated table, so it is validated against shapes whose
// answers are known (a sealed hollow ball is ~100% undercut over its cavity; a
// slab, a sphere and a flat-lying torus are all 0%) before any real file is read.
// ---------------------------------------------------------------------------

interface RayStats {
  /** Cells whose ray crosses the surface more than twice, over covered cells. */
  undercut: number;
  /**
   * Volume between the first and last crossing — the model's OUTER form, with
   * internal cavities filled in.
   *
   * This is the quantity a hollowed print makes a nonsense of when you take it
   * from the winding instead: a resin model hollowed to save material has a
   * cavity nobody can see, and filling it is what carving it solid does anyway.
   */
  spanMM3: number;
}

function rayStats(mesh: STLMesh, hf: Heightfield, scale: number): RayStats {
  const nan = { undercut: Number.NaN, spanMM3: Number.NaN };
  const nx = hf.width;
  const ny = hf.height;
  if (nx * ny > 4_000_000) return nan;
  const cw = hf.widthMM / nx;
  const chh = hf.heightMM / ny;
  const minU = -Infinity; // filled below from the mesh bounds, oriented +Z
  void minU;
  const x0 = mesh.min.x * scale;
  const y1 = mesh.max.y * scale;
  const v = mesh.vertices;

  // Two passes: count crossings per cell, then fill a flat list of their heights.
  const counts = new Int32Array(nx * ny + 1);
  const visit = (fn: (cell: number, z: number) => void): void => {
    for (let t = 0; t < mesh.count; t++) {
      const o = t * 9;
      const au = v[o] * scale,
        av = v[o + 1] * scale,
        ah = v[o + 2] * scale;
      let bu = v[o + 3] * scale,
        bv = v[o + 4] * scale,
        bh = v[o + 5] * scale;
      let cu = v[o + 6] * scale,
        cv = v[o + 7] * scale,
        ch = v[o + 8] * scale;
      let area2 = (bu - au) * (cv - av) - (bv - av) * (cu - au);
      if (area2 === 0) continue;
      if (area2 < 0) {
        [bu, cu] = [cu, bu];
        [bv, cv] = [cv, bv];
        [bh, ch] = [ch, bh];
        area2 = -area2;
      }
      const c0 = Math.max(0, Math.ceil((Math.min(au, bu, cu) - x0) / cw - 0.5));
      const c1 = Math.min(nx - 1, Math.floor((Math.max(au, bu, cu) - x0) / cw - 0.5));
      const r0 = Math.max(0, Math.ceil((y1 - Math.max(av, bv, cv)) / chh - 0.5));
      const r1 = Math.min(ny - 1, Math.floor((y1 - Math.min(av, bv, cv)) / chh - 0.5));
      for (let r = r0; r <= r1; r++) {
        const py = y1 - (r + 0.5) * chh;
        for (let c = c0; c <= c1; c++) {
          const px = x0 + (c + 0.5) * cw;
          const w0 = ((bu - px) * (cv - py) - (bv - py) * (cu - px)) / area2;
          if (w0 < -1e-7) continue;
          const w1 = ((cu - px) * (av - py) - (cv - py) * (au - px)) / area2;
          if (w1 < -1e-7) continue;
          const w2 = 1 - w0 - w1;
          if (w2 < -1e-7) continue;
          fn(r * nx + c, w0 * ah + w1 * bh + w2 * ch);
        }
      }
    }
  };

  visit((cell) => {
    counts[cell + 1]++;
  });
  for (let i = 0; i < nx * ny; i++) counts[i + 1] += counts[i];
  const total = counts[nx * ny];
  if (total > 60_000_000) return nan;
  const zs = new Float32Array(total);
  const cursor = counts.slice(0, nx * ny);
  visit((cell, z) => {
    zs[cursor[cell]++] = z;
  });

  // A cell is undercut when its crossings, deduped, number more than two. The
  // dedupe is what makes the rasteriser's deliberately INCLUSIVE edge test safe
  // here: a centre landing on a shared edge is reported by both triangles, and
  // both report the same height, so it collapses back to one crossing.
  const tol = Math.max(1e-6, (hf.zMaxMM - hf.zMinMM) * 1e-4);
  let covered = 0;
  let undercut = 0;
  let span = 0;
  for (let cell = 0; cell < nx * ny; cell++) {
    const a = counts[cell];
    const b = counts[cell + 1];
    if (b === a) continue;
    covered++;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = a; i < b; i++) {
      if (zs[i] < lo) lo = zs[i];
      if (zs[i] > hi) hi = zs[i];
    }
    span += hi - lo;
    if (b - a < 3) continue;
    const slice = Array.prototype.slice.call(zs.subarray(a, b)) as number[];
    slice.sort((p, q) => p - q);
    let distinct = 1;
    for (let i = 1; i < slice.length; i++) if (slice[i] - slice[i - 1] > tol) distinct++;
    if (distinct > 2) undercut++;
  }
  return {
    undercut: covered > 0 ? undercut / covered : 0,
    spanMM3: span * cw * chh,
  };
}

interface Row {
  label: string;
  tris: number;
  mm: string;
  emptyPct: number;
  wastedPct: number;
  undercutPct: number;
  plinthPct: number;
  shipPct: number;
  closure: number;
  note: string;
}

const UP = (process.env.UP ?? "+Z") as UpAxis;

/**
 * Rotate the mesh into the chosen viewing frame so everything downstream can
 * assume +Z.
 *
 * Cheaper than teaching `rayStats` a second basis, and it keeps the one place
 * that knows the orientation table inside `stlHeightfield` where it belongs.
 */
function reorient(mesh: STLMesh, up: UpAxis): STLMesh {
  if (up === "+Z") return mesh;
  const B: Record<string, [number[], number[], number[]]> = {
    "-Z": [[1, 0, 0], [0, -1, 0], [0, 0, -1]],
    "+Y": [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    "-Y": [[1, 0, 0], [0, 0, 1], [0, -1, 0]],
    "+X": [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    "-X": [[0, 1, 0], [0, 0, -1], [-1, 0, 0]],
  };
  const [U, V, H] = B[up];
  const v = mesh.vertices;
  const out = new Float32Array(v.length);
  let mnx = Infinity, mny = Infinity, mnz = Infinity;
  let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    const x = v[i] * U[0] + v[i + 1] * U[1] + v[i + 2] * U[2];
    const y = v[i] * V[0] + v[i + 1] * V[1] + v[i + 2] * V[2];
    const z = v[i] * H[0] + v[i + 1] * H[1] + v[i + 2] * H[2];
    out[i] = x;
    out[i + 1] = y;
    out[i + 2] = z;
    if (x < mnx) mnx = x;
    if (y < mny) mny = y;
    if (z < mnz) mnz = z;
    if (x > mxx) mxx = x;
    if (y > mxy) mxy = y;
    if (z > mxz) mxz = z;
  }
  return {
    ...mesh,
    vertices: out,
    min: { x: mnx, y: mny, z: mnz },
    max: { x: mxx, y: mxy, z: mxz },
  };
}

function measure(label: string, raw: STLMesh, scale: number, expect: string): Row {
  const mesh = reorient(raw, UP);
  const hf = stlHeightfield(mesh, { scale });
  const mv = meshVolume(mesh);
  const modelMM3 = mv.volume * scale ** 3;
  const carvedMM3 = carvedVolume(hf);
  const wasted = carvedMM3 > 0 ? 1 - modelMM3 / carvedMM3 : 0;
  // The crossing-list pass is the expensive one; off unless asked for, so a
  // few-hundred-object sweep stays quick.
  const rs = process.env.RAYS
    ? rayStats(mesh, hf, scale)
    : { undercut: Number.NaN, spanMM3: Number.NaN };
  return {
    label,
    tris: mesh.count,
    mm: `${hf.widthMM.toFixed(0)}x${hf.heightMM.toFixed(0)}x${(hf.zMaxMM - hf.zMinMM).toFixed(0)}`,
    emptyPct: emptyRatio(hf) * 100,
    wastedPct: wasted * 100,
    undercutPct: rs.undercut * 100,
    plinthPct: carvedMM3 > 0 ? (1 - rs.spanMM3 / carvedMM3) * 100 : 0,
    shipPct: hf.plinthRatio * 100,
    closure: mv.closure,
    note: expect,
  };
}

const pc = (v: number, w: number): string => (Number.isNaN(v) ? "—" : v.toFixed(1)).padStart(w);

function printTable(rows: Row[]): void {
  console.log(
    `\n${"model".padEnd(36)} ${"tris".padStart(8)} ${"size mm".padStart(13)} ` +
      `${"empty%".padStart(7)} ${"wasted%".padStart(8)} ${"undercut%".padStart(10)} ` +
      `${"plinth%".padStart(8)} ${"SHIPPED".padStart(8)} ${"warn?".padStart(6)}  expected`,
  );
  console.log("-".repeat(134));
  for (const r of rows)
    console.log(
      `${r.label.slice(0, 36).padEnd(36)} ${String(r.tris).padStart(8)} ${r.mm.padStart(13)} ` +
        `${pc(r.emptyPct, 7)} ${pc(r.wastedPct, 8)} ${pc(r.undercutPct, 10)} ` +
        `${pc(r.plinthPct, 8)} ${pc(r.shipPct, 8)} ` +
        `${(r.shipPct / 100 >= PLINTH_WARN ? "WARN" : "-").padStart(6)}  ${r.note}`,
    );
}

const RAMP = " .:-=+*#%@";

function show(hf: Heightfield, label: string, cols = 76): void {
  const step = Math.max(1, Math.ceil(hf.width / cols));
  console.log(
    `\n--- ${label}: ${hf.width}x${hf.height} cells, ` +
      `${hf.widthMM.toFixed(1)}x${hf.heightMM.toFixed(1)}mm, ` +
      `z ${hf.zMinMM.toFixed(2)}..${hf.zMaxMM.toFixed(2)}mm, empty=${(
        (hf.emptyCells / (hf.width * hf.height)) *
        100
      ).toFixed(1)}%`,
  );
  // Rows are squashed twice as hard as columns: a terminal cell is ~2:1 tall.
  for (let r = 0; r < hf.height; r += step * 2) {
    let line = "";
    for (let c = 0; c < hf.width; c += step) {
      const v = hf.gray[r * hf.width + c];
      line += RAMP[Math.min(RAMP.length - 1, Math.floor((v / 255) * RAMP.length))];
    }
    console.log(`  ${line}`);
  }
}

// ---------------------------------------------------------------------------
// Synthetic shapes: shapes whose answer is known in closed form, so a wrong
// implementation is caught before any real file is interpreted.
// ---------------------------------------------------------------------------


/** A hollow open-topped tube: the case an empty-cell ratio cannot see at all. */
function vase(rOuter = 20, wall = 2, h = 40, n = 96): Tri[] {
  const tris: Tri[] = [];
  const ring = (r: number, z0: number, z1: number, out: boolean): void => {
    for (let j = 0; j < n; j++) {
      const f0 = (j / n) * 2 * Math.PI;
      const f1 = ((j + 1) / n) * 2 * Math.PI;
      const a: [number, number, number] = [r * Math.cos(f0), r * Math.sin(f0), z0];
      const b: [number, number, number] = [r * Math.cos(f1), r * Math.sin(f1), z0];
      const c: [number, number, number] = [r * Math.cos(f1), r * Math.sin(f1), z1];
      const d: [number, number, number] = [r * Math.cos(f0), r * Math.sin(f0), z1];
      if (out) tris.push([...a, ...b, ...c], [...a, ...c, ...d]);
      else tris.push([...a, ...c, ...b], [...a, ...d, ...c]);
    }
  };
  const rInner = rOuter - wall;
  ring(rOuter, 0, h, true);
  ring(rInner, wall, h, false);
  // Flat bottom disc and the annulus at the rim.
  for (let j = 0; j < n; j++) {
    const f0 = (j / n) * 2 * Math.PI;
    const f1 = ((j + 1) / n) * 2 * Math.PI;
    tris.push([0, 0, 0, rOuter * Math.cos(f1), rOuter * Math.sin(f1), 0, rOuter * Math.cos(f0), rOuter * Math.sin(f0), 0]);
    tris.push([0, 0, wall, rInner * Math.cos(f0), rInner * Math.sin(f0), wall, rInner * Math.cos(f1), rInner * Math.sin(f1), wall]);
    const A: [number, number, number] = [rInner * Math.cos(f0), rInner * Math.sin(f0), h];
    const B: [number, number, number] = [rInner * Math.cos(f1), rInner * Math.sin(f1), h];
    const C: [number, number, number] = [rOuter * Math.cos(f1), rOuter * Math.sin(f1), h];
    const D: [number, number, number] = [rOuter * Math.cos(f0), rOuter * Math.sin(f0), h];
    // Wound so the rim faces +Z. Getting this backwards leaves `closure` non-zero
    // and the volume wrong by the rim's whole contribution — which is how the
    // first draft of this fixture reported a false 27.7%.
    tris.push([...A, ...C, ...B], [...A, ...D, ...C]);
  }
  return tris;
}


/** A torus lying flat: a real undercut, and a hole through the middle. */
function torus(R = 20, r = 6, nMaj = 96, nMin = 48): Tri[] {
  const p = (u: number, v: number): [number, number, number] => [
    (R + r * Math.cos(v)) * Math.cos(u),
    (R + r * Math.cos(v)) * Math.sin(u),
    r * Math.sin(v),
  ];
  const tris: Tri[] = [];
  for (let i = 0; i < nMaj; i++)
    for (let j = 0; j < nMin; j++) {
      const u0 = (i / nMaj) * 2 * Math.PI,
        u1 = ((i + 1) / nMaj) * 2 * Math.PI;
      const v0 = (j / nMin) * 2 * Math.PI,
        v1 = ((j + 1) / nMin) * 2 * Math.PI;
      const a = p(u0, v0),
        b = p(u1, v0),
        c = p(u1, v1),
        d = p(u0, v1);
      tris.push([...a, ...b, ...c], [...a, ...c, ...d]);
    }
  return tris;
}

/** A flat plate with a square hole: the false positive an area ratio invites. */
function plateWithHole(size = 60, hole = 30, thick = 4): Tri[] {
  const tris: Tri[] = [];
  const box = (x0: number, x1: number, y0: number, y1: number): void => {
    const v = [
      [x0, y0, 0],
      [x1, y0, 0],
      [x1, y1, 0],
      [x0, y1, 0],
      [x0, y0, thick],
      [x1, y0, thick],
      [x1, y1, thick],
      [x0, y1, thick],
    ];
    const quad = (a: number, b: number, c: number, d: number) =>
      tris.push([...v[a], ...v[b], ...v[c]], [...v[a], ...v[c], ...v[d]]);
    quad(0, 3, 2, 1);
    quad(4, 5, 6, 7);
    quad(0, 1, 5, 4);
    quad(1, 2, 6, 5);
    quad(2, 3, 7, 6);
    quad(3, 0, 4, 7);
  };
  const lo = (size - hole) / 2;
  const hi = lo + hole;
  box(0, size, 0, lo); // four bars around the hole
  box(0, size, hi, size);
  box(0, lo, lo, hi);
  box(hi, size, lo, hi);
  return tris;
}

/**
 * A relief panel: a raised face over a flat back, closed with skirt walls.
 *
 * Built as a genuine closed solid rather than a surface dropped on a box, so its
 * `closure` is zero and its volume means something — a floating surface would
 * make this fixture prove the opposite of what it is here to prove.
 */
function reliefPanel(size = 60, base = 3, R = 25, n = 64): Tri[] {
  const tris: Tri[] = [];
  const cx = size / 2;
  const domeH = 8;
  const zAt = (x: number, y: number): number => {
    const r = Math.hypot(x - cx, y - cx);
    return r >= R ? base : base + domeH * Math.cos((Math.PI * r) / (2 * R));
  };
  const at = (i: number) => (i / n) * size;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const x0 = at(i),
        x1 = at(i + 1),
        y0 = at(j),
        y1 = at(j + 1);
      tris.push(
        [x0, y0, zAt(x0, y0), x1, y0, zAt(x1, y0), x1, y1, zAt(x1, y1)],
        [x0, y0, zAt(x0, y0), x1, y1, zAt(x1, y1), x0, y1, zAt(x0, y1)],
      );
    }
  // Flat back, wound downward.
  tris.push([0, 0, 0, size, size, 0, size, 0, 0], [0, 0, 0, 0, size, 0, size, size, 0]);
  // Four skirt walls from the back up to the face (the rim is flat at `base`).
  for (let i = 0; i < n; i++) {
    const a = at(i),
      b = at(i + 1);
    tris.push([a, 0, 0, b, 0, 0, b, 0, base], [a, 0, 0, b, 0, base, a, 0, base]);
    tris.push([b, size, 0, a, size, 0, a, size, base], [b, size, 0, a, size, base, b, size, base]);
    tris.push([0, b, 0, 0, a, 0, 0, a, base], [0, b, 0, 0, a, base, 0, b, base]);
    tris.push([size, a, 0, size, b, 0, size, b, base], [size, a, 0, size, b, base, size, a, base]);
  }
  return tris;
}

function slab(size: number, thick: number): Tri[] {
  const v = [
    [0, 0, 0],
    [size, 0, 0],
    [size, size, 0],
    [0, size, 0],
    [0, 0, thick],
    [size, 0, thick],
    [size, size, thick],
    [0, size, thick],
  ];
  const tris: Tri[] = [];
  const quad = (a: number, b: number, c: number, d: number) =>
    tris.push([...v[a], ...v[b], ...v[c]], [...v[a], ...v[c], ...v[d]]);
  quad(0, 3, 2, 1);
  quad(4, 5, 6, 7);
  quad(0, 1, 5, 4);
  quad(1, 2, 6, 5);
  quad(2, 3, 7, 6);
  quad(3, 0, 4, 7);
  return tris;
}

// ---------------------------------------------------------------------------

/**
 * Load the meshes out of a 3MF's `3D/3dmodel.model` XML, one `STLMesh` per
 * object.
 *
 * Probe-only. 3MF is the container every consumer slicer writes, so it is where
 * real printed parts actually live — the calibration corpus is far too small
 * without it, and a threshold measured on a handful of files is barely measured
 * at all. Objects are kept SEPARATE rather than merged: a plate holding six
 * parts is six things somebody might carve, not one six-part model.
 *
 * Regex rather than a parser because the two element shapes involved are fixed
 * by the spec and this reads 126 MB of XML.
 */
function load3MF(path: string): { name: string; mesh: STLMesh }[] {
  const xml = readFileSync(path, "utf8");
  const out: { name: string; mesh: STLMesh }[] = [];
  const OBJ = /<object\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/object>/g;
  let om: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: the exec-loop idiom
  while ((om = OBJ.exec(xml)) !== null) {
    const body = om[2];
    const vBlock = /<vertices>([\s\S]*?)<\/vertices>/.exec(body)?.[1];
    const tBlock = /<triangles>([\s\S]*?)<\/triangles>/.exec(body)?.[1];
    if (!vBlock || !tBlock) continue; // a components-only object, no mesh of its own
    const xs: number[] = [];
    const V = /<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g;
    let vm: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: the exec-loop idiom
    while ((vm = V.exec(vBlock)) !== null) xs.push(+vm[1], +vm[2], +vm[3]);
    const T = /<triangle\s+v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"/g;
    const tri: number[] = [];
    let tm: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: the exec-loop idiom
    while ((tm = T.exec(tBlock)) !== null) tri.push(+tm[1], +tm[2], +tm[3]);
    if (tri.length === 0) continue;
    const verts = new Float32Array(tri.length * 3);
    let mnx = Infinity, mny = Infinity, mnz = Infinity;
    let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let i = 0; i < tri.length; i++) {
      const o = tri[i] * 3;
      const x = xs[o], y = xs[o + 1], z = xs[o + 2];
      verts[i * 3] = x;
      verts[i * 3 + 1] = y;
      verts[i * 3 + 2] = z;
      if (x < mnx) mnx = x;
      if (y < mny) mny = y;
      if (z < mnz) mnz = z;
      if (x > mxx) mxx = x;
      if (y > mxy) mxy = y;
      if (z > mxz) mxz = z;
    }
    out.push({
      name: `${basename(path, ".model")}#${om[1]}`,
      mesh: {
        vertices: verts,
        count: tri.length / 3,
        min: { x: mnx, y: mny, z: mnz },
        max: { x: mxx, y: mxy, z: mxz },
        format: "binary",
        name: "",
        dropped: 0,
      },
    });
  }
  return out;
}

/** Every carveable object in a file, whichever container it arrived in. */
function loadAny(f: string): { name: string; mesh: STLMesh }[] {
  if (/\.model$/i.test(f)) return load3MF(f);
  const buf = readFileSync(f);
  return [
    {
      name: basename(f),
      mesh: parseSTL(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer),
    },
  ];
}

function collect(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (!statSync(p, { throwIfNoEntry: false })) continue;
    if (statSync(p).isDirectory())
      for (const f of readdirSync(p)) {
        if (/\.(stl|model)$/i.test(f)) out.push(join(p, f));
      }
    else out.push(p);
  }
  return out;
}

const rows: Row[] = [];

console.log("=== synthetic shapes: known answers, so a wrong measure shows up here ===");
const synth: [string, Tri[], string][] = [
  ["flat-backed slab", slab(60, 4), "relief -> ~0%"],
  ["relief panel (dome on a slab)", reliefPanel(), "relief -> ~0%"],
  ["hemisphere + flat disc", hemisphere(20, 64, 128), "relief -> ~0%"],
  ["stepped block", steppedBlock(30, 30, 3, 2), "relief -> ~0%"],
  ["plate with a square hole", plateWithHole(), "relief -> ~0%"],
  ["sphere (closed)", sphere(20), "full 3D -> 20% exactly"],
  ["torus lying flat", torus(), "full 3D -> 12% exactly"],
  ["hollow ball (sealed cavity)", hollowBall(), "full 3D -> very high"],
  ["vase (hollow, open top)", vase(), "open from above -> ~0%"],
];
for (const [label, tris, expect] of synth)
  rows.push(measure(label, parseSTL(binarySTL(tris)), 1, expect));
printTable(rows);

show(stlHeightfield(parseSTL(binarySTL(reliefPanel()))), "relief panel");
show(stlHeightfield(parseSTL(binarySTL(vase()))), "vase");

const args = process.argv.slice(2);
if (args.length > 0) {
  console.log("\n\n=== real files ===");
  const real: Row[] = [];
  for (const f of collect(args)) {
    try {
      for (const { name, mesh } of loadAny(f)) {
        // Tiny objects on a plate are print helpers (brims, calibration cubes),
        // not something anyone would carve; they only add noise to the corpus.
        if (mesh.count < 100) continue;
        const t0 = performance.now();
        const r = measure(name + (UP === "+Z" ? "" : ` [${UP}]`), mesh, suggestUnitScale(mesh).scale, "");
        r.note = `${(performance.now() - t0).toFixed(0)}ms`;
        real.push(r);
      }
    } catch (e) {
      console.log(`  (failed) ${basename(f)}: ${(e as Error).message}`);
    }
  }
  real.sort((a, b) => a.shipPct - b.shipPct);
  if (process.env.TABLE) printTable(real);

  // ---- distribution -------------------------------------------------------
  // The threshold's whole justification is a GAP in this distribution, so the
  // distribution is what has to be looked at — not a handful of chosen rows.
  const buckets = [0.5, 1, 2, 3, 4, 5, 6, 8, 10, 15, 20, 30, 50, 101];
  console.log(`\n=== plinth% distribution over ${real.length} real objects ===`);
  let lo = 0;
  for (const hi of buckets) {
    const n = real.filter((r) => r.shipPct >= lo && r.shipPct < hi).length;
    console.log(
      `  ${`${lo}–${hi}%`.padStart(10)} ${String(n).padStart(4)} ${"█".repeat(Math.min(70, n))}` +
        (lo >= 5 ? "   (warns)" : ""),
    );
    lo = hi;
  }

  const band = real.filter((r) => r.shipPct >= 1 && r.shipPct < 8);
  console.log(`\n=== the band the threshold sits in: ${band.length} objects between 1% and 8% ===`);
  for (const r of band)
    console.log(`  ${r.shipPct.toFixed(1).padStart(5)}%  ${r.mm.padStart(14)}  ${r.label}`);
  console.log(
    `\nwarns: ${real.filter((r) => r.shipPct >= PLINTH_WARN * 100).length}/${real.length} ` +
      `(${((real.filter((r) => r.shipPct >= PLINTH_WARN * 100).length / real.length) * 100).toFixed(0)}%)`,
  );

  if (process.env.SHOW) {
    for (const f of collect(args))
      for (const { name, mesh } of loadAny(f)) {
        if (mesh.count < 100) continue;
        const scale = suggestUnitScale(mesh).scale;
        show(stlHeightfield(reorient(mesh, UP), { scale }), `${name} [${UP}]`);
      }
  }
}
