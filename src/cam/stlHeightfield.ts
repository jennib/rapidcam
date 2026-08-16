/**
 * Triangle soup → heightfield: the drop-cutter, evaluated once into a grid.
 *
 * For every cell we want the height of the model's TOP surface there, which is
 * the maximum Z over all triangles covering that cell. Sampling at the cell
 * CENTRE and interpolating the triangle's plane is the z-buffer answer, and it is
 * exact on any surface the triangles describe — a hemisphere reads `√(R²−r²)`
 * at every cell, not an approximation of it.
 *
 * Keeping the MAXIMUM (rather than the nearest, or the last one seen) is what
 * makes facet winding irrelevant: a model with flipped, missing or zeroed normals
 * — the usual reason a slicer complains about an STL — rasterises correctly here,
 * because the top surface is the top surface however its facets are oriented. It
 * is also why the flat bottom disc of a dome cannot win over the dome above it.
 *
 * ## What "no model here" means
 *
 * A model's silhouette is rarely its bounding rectangle, so some cells are
 * covered by no triangle at all. Those encode as `zMin` — the model's base plane,
 * i.e. FULL cut depth — which is what carving a relief physically is: the field
 * around the subject is machined away down to the base. That is the heightfield
 * school's convention (Vectric's relief components have a base plane; Easel warns
 * that "STL files with a flat face or flat bottom will work best" for exactly this
 * reason). The alternative — leaving unmodelled cells uncut — would surround every
 * carving with a square plinth the model never described.
 *
 * ## The encoding, and why it is fixed here rather than at each op
 *
 * `byte = round(255 · (z − zMin) / (zMax − zMin))`, so the model's TOP is 255.
 * A relief op reads `level = 1 − value` and cuts `level × depth`, so 255 is no cut
 * and 0 is full depth — the byte is a height, and the op turns it into a depth.
 * The corollary is that every tone control in the raster path is a geometry error
 * on this data; {@link reliefEncodingFor} in `reliefEncoding.ts` is the one place
 * that states so, and all four relief consumers read it from there.
 *
 * ## Resolution
 *
 * The grid spans the model's XY bounding box EXACTLY: the cell size is derived
 * from the extent and the cell count (`extent / n`), never the other way round, so
 * `widthMM` is the model's true width and not a rounded-up multiple of some pitch.
 * That matters because `widthMM` becomes the entity's width, which is what the
 * finished carving measures.
 */

import { MAX_IMAGE_EDGE } from "../core/imageManager";
import type { STLMesh, Vec3 } from "../io/stlImport";

/**
 * Which face of the model points at the tool.
 *
 * Every entry is a right-handed basis, so a model is only ever rotated into view,
 * never mirrored — a mirrored carving is a wrong part that looks plausible.
 */
export type UpAxis = "+Z" | "-Z" | "+Y" | "-Y" | "+X" | "-X";

/** (u, v, h) = the grid's across, up-the-page, and height axes, as model axes. */
const BASIS: Record<UpAxis, [Vec3, Vec3, Vec3]> = {
  "+Z": [ax(1, 0, 0), ax(0, 1, 0), ax(0, 0, 1)],
  "-Z": [ax(1, 0, 0), ax(0, -1, 0), ax(0, 0, -1)],
  "+Y": [ax(1, 0, 0), ax(0, 0, -1), ax(0, 1, 0)],
  "-Y": [ax(1, 0, 0), ax(0, 0, 1), ax(0, -1, 0)],
  "+X": [ax(0, 1, 0), ax(0, 0, 1), ax(1, 0, 0)],
  "-X": [ax(0, 1, 0), ax(0, 0, -1), ax(-1, 0, 0)],
};

function ax(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

/**
 * How far outside a triangle a cell centre may sit and still be counted, in
 * barycentric units.
 *
 * A cell centre landing EXACTLY on the edge two triangles share is not a corner
 * case here, it is the common case: STL vertices sit on round coordinates and so
 * do grid cells, so the coincidence happens constantly. On a plain `w < 0` test,
 * rounding then puts such a point marginally outside BOTH triangles and the cell
 * is covered by neither — encoding as `zMin`, i.e. **a full-depth pinhole through
 * the middle of a flat face.** A 3-step block on a 38×38 grid produced two.
 *
 * The exact fix a GPU uses (the top-left fill rule) needs the edge function to
 * evaluate to exactly zero, which fixed-point arithmetic guarantees and floating
 * point does not. So instead the test is deliberately INCLUSIVE: with a max-Z
 * buffer, counting a point in both triangles costs nothing — they agree along the
 * edge they share — while missing it in both is the pinhole. Overlap is free,
 * gaps are not, so err into overlap.
 *
 * ## Why 1e-7, measured rather than reasoned
 *
 * The intuition that slivers are the demanding case — that the normalised error
 * grows as `coord²/area`, so a long thin facet is where the test breaks down — is
 * WRONG, and it was written here before it was checked. Measured: a point placed
 * exactly on a shared diagonal reads a worst weight of **−1.1e-16, and that figure
 * is flat** across aspect ratios from 10:1 to 1e11:1 and plate sizes from 10 mm to
 * 1 m (`scripts/stl-probe.ts`).
 *
 * It is flat because the two products being differenced are each of order the
 * triangle's OWN area, not of `coord²`: the factors are `(edge span)` by
 * `(distance across the sliver)`. So the cancellation error is an ulp of the area,
 * and dividing by `area2` cancels the aspect dependence out again.
 *
 * `1e-7` therefore carries about nine orders of margin over anything observed,
 * while remaining far below anything with a geometric effect: it widens a triangle
 * by `1e-7` of its own extent — tens of nanometres on a 30 mm facet — and outward,
 * which leaves material rather than removing it. The margin is kept rather than
 * tightened to the measurement because the cost of it is nil and the cost of being
 * one ulp short is a hole drilled through the part.
 */
const EDGE_EPS = 1e-7;

export interface HeightfieldOptions {
  /** Which model face points at the tool. Default `"+Z"`. */
  up?: UpAxis;
  /** Model units → mm. 1 for a millimetre file, 25.4 for an inch one. */
  scale?: number;
  /** Target cell size in mm. Defaults to whatever `maxEdge` allows. */
  cellMM?: number;
  /** Cap on the longest grid edge, in cells. Default {@link MAX_IMAGE_EDGE}. */
  maxEdge?: number;
}

export interface Heightfield {
  width: number;
  height: number;
  /** Greyscale, row-major, **row 0 = top** (= maximum V) — the registry's convention. */
  gray: Uint8Array;
  /** Model height at `gray` 0 and 255, in mm. `zMax − zMin` is the carve depth at true scale. */
  zMinMM: number;
  zMaxMM: number;
  /** The footprint the grid spans, in mm — the entity's size at true scale. */
  widthMM: number;
  heightMM: number;
  /** Cells no triangle covered. They encode as `zMin`, i.e. full depth. */
  emptyCells: number;
}

/**
 * Rasterise a parsed STL into a heightfield.
 *
 * Returns a 1×1 field of "no cut" for an empty or degenerate mesh rather than
 * throwing — the caller has a file the user chose, and an empty result it can
 * report beats an exception it has to translate.
 */
export function stlHeightfield(mesh: STLMesh, opts: HeightfieldOptions = {}): Heightfield {
  const scale = opts.scale && opts.scale > 0 ? opts.scale : 1;
  const [U, V, H] = BASIS[opts.up ?? "+Z"];

  // Bounds in the ORIENTED frame. Taken from the mesh, not from what the grid
  // happens to sample, so the same model encodes identically at any resolution.
  const b = orientedBounds(mesh, U, V, H, scale);
  const spanU = b.maxU - b.minU;
  const spanV = b.maxV - b.minV;
  if (mesh.count === 0 || !(spanU > 0) || !(spanV > 0)) {
    return {
      width: 1,
      height: 1,
      gray: new Uint8Array([255]),
      zMinMM: b.minH,
      zMaxMM: b.maxH,
      widthMM: Math.max(0, spanU),
      heightMM: Math.max(0, spanV),
      emptyCells: 1,
    };
  }

  const { nx, ny } = gridSize(spanU, spanV, opts);
  const cw = spanU / nx;
  const chh = spanV / ny;

  // -Infinity marks "no triangle covered this cell" — distinguishable from a real
  // height of zMin, which a model's own base plane legitimately produces.
  const zbuf = new Float32Array(nx * ny).fill(-Infinity);
  const vtx = mesh.vertices;

  for (let t = 0; t < mesh.count; t++) {
    const o = t * 9;
    // Project the three vertices into the oriented frame, in mm.
    const au = dot(vtx, o, U) * scale,
      av = dot(vtx, o, V) * scale;
    const ah = dot(vtx, o, H) * scale;
    let bu = dot(vtx, o + 3, U) * scale,
      bv = dot(vtx, o + 3, V) * scale;
    let bh = dot(vtx, o + 3, H) * scale;
    let cu = dot(vtx, o + 6, U) * scale,
      cv = dot(vtx, o + 6, V) * scale;
    let ch = dot(vtx, o + 6, H) * scale;

    let area2 = (bu - au) * (cv - av) - (bv - av) * (cu - au);
    if (area2 === 0) continue; // edge-on to the tool: contributes no cell centre
    if (area2 < 0) {
      // Normalise the winding so one sign test covers all three weights.
      [bu, cu] = [cu, bu];
      [bv, cv] = [cv, bv];
      [bh, ch] = [ch, bh];
      area2 = -area2;
    }

    const minU = Math.min(au, bu, cu),
      maxU = Math.max(au, bu, cu);
    const minV = Math.min(av, bv, cv),
      maxV = Math.max(av, bv, cv);
    // Cell centres inside the triangle's bbox. Centre of column c is
    // minU_grid + (c+0.5)·cw; row r is maxV_grid − (r+0.5)·ch (row 0 = top).
    const c0 = Math.max(0, Math.ceil((minU - b.minU) / cw - 0.5));
    const c1 = Math.min(nx - 1, Math.floor((maxU - b.minU) / cw - 0.5));
    const r0 = Math.max(0, Math.ceil((b.maxV - maxV) / chh - 0.5));
    const r1 = Math.min(ny - 1, Math.floor((b.maxV - minV) / chh - 0.5));
    if (c1 < c0 || r1 < r0) continue;

    for (let r = r0; r <= r1; r++) {
      const py = b.maxV - (r + 0.5) * chh;
      const rowBase = r * nx;
      for (let c = c0; c <= c1; c++) {
        const px = b.minU + (c + 0.5) * cw;
        const w0 = ((bu - px) * (cv - py) - (bv - py) * (cu - px)) / area2;
        if (w0 < -EDGE_EPS) continue;
        const w1 = ((cu - px) * (av - py) - (cv - py) * (au - px)) / area2;
        if (w1 < -EDGE_EPS) continue;
        const w2 = 1 - w0 - w1;
        if (w2 < -EDGE_EPS) continue;
        const z = w0 * ah + w1 * bh + w2 * ch;
        const i = rowBase + c;
        if (z > zbuf[i]) zbuf[i] = z;
      }
    }
  }

  // --- encode ---------------------------------------------------------------
  const range = b.maxH - b.minH;
  const gray = new Uint8Array(nx * ny);
  let emptyCells = 0;
  if (!(range > 0)) {
    // A flat model has no relief to carve; everything is the top surface.
    gray.fill(255);
    for (let i = 0; i < zbuf.length; i++) if (zbuf[i] === -Infinity) emptyCells++;
  } else {
    const k = 255 / range;
    for (let i = 0; i < zbuf.length; i++) {
      const z = zbuf[i];
      if (z === -Infinity) {
        emptyCells++;
        gray[i] = 0; // unmodelled → the base plane → full depth
        continue;
      }
      const q = Math.round((z - b.minH) * k);
      gray[i] = q < 0 ? 0 : q > 255 ? 255 : q;
    }
  }

  return {
    width: nx,
    height: ny,
    gray,
    zMinMM: b.minH,
    zMaxMM: b.maxH,
    widthMM: spanU,
    heightMM: spanV,
    emptyCells,
  };
}

/**
 * Default sample pitch, mm.
 *
 * Resolution beyond what the finishing pass can physically cut buys nothing and
 * is persisted forever: the heightfield is embedded in the `.rcam` file. Vectric
 * puts a 3-D finish stepover at 8–12% of tool diameter, so even a small ⌀3
 * ball-nose steps ~0.3 mm — and `rasterField` box-averages this grid down to that
 * pitch anyway. Sampling at 0.1 mm is finer than any realistic finish and still
 * lets a 40 mm model be a 400×400 buffer instead of the 1000×1000 (1 MB) that
 * filling {@link MAX_IMAGE_EDGE} would produce.
 *
 * The cap still applies, so a large model degrades to whatever fits rather than
 * refusing to import.
 */
const DEFAULT_CELL_MM = 0.1;

/** Cell counts honouring the requested cell size and the edge cap. */
function gridSize(spanU: number, spanV: number, opts: HeightfieldOptions): { nx: number; ny: number } {
  const maxEdge = Math.max(1, Math.floor(opts.maxEdge ?? MAX_IMAGE_EDGE));
  const longest = Math.max(spanU, spanV);
  const cell =
    opts.cellMM && opts.cellMM > 0
      ? opts.cellMM
      : Math.max(DEFAULT_CELL_MM, longest / maxEdge);
  // Round to the nearest whole cell, then let the actual cell size fall out of
  // the extent, so the grid spans the bounding box exactly.
  let nx = Math.max(1, Math.round(spanU / cell));
  let ny = Math.max(1, Math.round(spanV / cell));
  const over = Math.max(nx, ny) / maxEdge;
  if (over > 1) {
    nx = Math.max(1, Math.floor(nx / over));
    ny = Math.max(1, Math.floor(ny / over));
  }
  return { nx, ny };
}

function dot(v: Float32Array, o: number, a: Vec3): number {
  return v[o] * a.x + v[o + 1] * a.y + v[o + 2] * a.z;
}

interface OrientedBounds {
  minU: number;
  maxU: number;
  minV: number;
  maxV: number;
  minH: number;
  maxH: number;
}

function orientedBounds(
  mesh: STLMesh,
  U: Vec3,
  V: Vec3,
  H: Vec3,
  scale: number,
): OrientedBounds {
  // The oriented extremes are a signed permutation of the axis-aligned ones, so
  // they follow from the mesh's own bounds without touching a single triangle.
  const lo = [mesh.min.x, mesh.min.y, mesh.min.z];
  const hi = [mesh.max.x, mesh.max.y, mesh.max.z];
  const range = (a: Vec3): [number, number] => {
    const w = [a.x, a.y, a.z];
    let mn = 0,
      mx = 0;
    for (let i = 0; i < 3; i++) {
      mn += w[i] >= 0 ? w[i] * lo[i] : w[i] * hi[i];
      mx += w[i] >= 0 ? w[i] * hi[i] : w[i] * lo[i];
    }
    return [mn * scale, mx * scale];
  };
  const [minU, maxU] = range(U);
  const [minV, maxV] = range(V);
  const [minH, maxH] = range(H);
  return { minU, maxU, minV, maxV, minH, maxH };
}
