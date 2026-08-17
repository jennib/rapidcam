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
  /**
   * How much of the carved solid is plinth: material below the model that no
   * 3-axis cutter can reach, left standing because the tool only ever comes down
   * from above. 0 for a relief, high for a free-standing object. See
   * {@link PLINTH_WARN} for the calibration and the threshold.
   */
  plinthRatio: number;
}

/**
 * When to tell the user their model is not relief-shaped.
 *
 * ## What is measured, and why not `emptyCells`
 *
 * The obvious candidate — the fraction of cells no triangle covered — is not a
 * property of the model's depth at all. It is one minus (silhouette area / bounding
 * box area): a measure of the model's SHADOW. Measured on real files, it cannot
 * do this job:
 *
 * | shape                  | empty | plinth |
 * |------------------------|-------|--------|
 * | hemisphere on its disc | 21.5% |   0.0% |
 * | sphere                 | 21.5% |  20.1% |
 * | sealed hollow ball     | 21.5% |  20.1% |
 * | open-topped vase       | 21.5% |   0.3% |
 *
 * Four shapes, one number, and the damage ranges over the whole scale — because
 * all four cast a circle on a square. Worse, `dragon_wall_art-01.stl`, a genuine
 * relief a user would carve as-is, is **17.3% empty**, and a torus lying flat is
 * 44.3% empty while costing only 12.2%. Any threshold low enough to catch a
 * printed figurine fires on both.
 *
 * ## What this measures instead
 *
 * The carve leaves everything under the top surface: `zMin ≤ z ≤ zTop(x,y)`. The
 * model's own outer form occupies `zBottom(x,y) ≤ z ≤ zTop(x,y)`. The difference
 * is plinth — material the cutter cannot get under:
 *
 *     plinthRatio = 1 − Σ(zTop − zBottom) / Σ(zTop − zMin)
 *
 * It needs one extra buffer and no mesh volume, and it is bounded in [0,1] by
 * construction because `zBottom ≥ zMin`. Taking the model's volume from the facet
 * winding instead was tried and rejected: `resurgence-2.stl` and
 * `35-36.5mm_adapter.STL` both report a NEGATIVE waste that way — geometrically
 * impossible for a solid — because their doubled shells are wound so an invisible
 * cavity adds instead of subtracting, and the standard closedness test (area-
 * weighted normals summing to zero) passes them both at ~1e-18. Spanning between
 * the outermost crossings has no opinion about winding and fills such cavities in,
 * which is what carving them solid does anyway.
 *
 * ## Why 10%: an operating point, and NOT a gap
 *
 * This threshold was first set to 5% on a 31-model corpus that appeared to have a
 * clean empty band between 3.8% and 8.8%. **That band was an artifact of the
 * sample size.** Re-measured over **929 real objects** — every STL and every mesh
 * inside every 3MF in a working maker's download folder — the distribution is
 * continuous, and there is no gap anywhere to hide a threshold in:
 *
 *     0–0.5%  695 | 1–2%  17 | 3–4%   9 | 5–6%  12 | 8–10%  11 | 15–20%  16
 *     0.5–1%   14 | 2–3%  18 | 4–5%   9 | 6–8%   8 | 10–15%  36 | 20%+    84
 *
 * The clearest evidence is a natural experiment the corpus supplies for free:
 * `Imperial_Setup_Blocks_Case` is one part at fourteen thicknesses, and it reads
 * 4.0, 4.2, 4.4, 4.7, 4.8, 4.9, 5.1, 5.2, 5.3, 5.3, 5.4, 5.4, 5.5%. The same
 * design, equally carveable at every size, drifting straight across a 5% line.
 *
 * So the number is a judgement about cost, and it is chosen from what the corpus
 * says about each class:
 *
 * - **Reliefs** — the must-not-warn class — run 0.0 (`last_supper_remix`,
 *   `dragon_wall_art`, `BuddhaRelief`), 0.1 (`resurgence-2`), 0.3 (`atenea_v1`
 *   facing the tool), 0.9 (`lion5-1`), 2.4 and up to **4.7%**
 *   (`mother-day-gift-elegoo`, a framed decorative panel — rendered and looked at,
 *   not guessed from its filename).
 * - **Solid 3-D forms** — the must-warn class — start at 12.4% (`apolo_v1` seen
 *   from above) and 15.1%, with the mildest textbook case, a sphere, at exactly
 *   20.0%. Then 22.3, 25.9, 40.2, 56.8, 61.0, 65.6, 71.8.
 *
 * 10% is a little over 2× the highest relief measured and comfortably under every
 * object anyone would call a solid 3-D form. It fires on ~15% of a real printed
 * corpus, which keeps it meaningful — a warning that greets one model in three
 * becomes wallpaper, and the cost of that is the ruined blank it stops being read
 * in time to prevent.
 *
 * Between 5% and 10% sit setup blocks, hand clamps, a glue roller and gridfinity
 * bins: printed parts that lie flat, where a pass from above does reproduce the
 * top form. Staying quiet on those is right, not a concession.
 *
 * Orientation matters and the number follows it, which is the useful part:
 * `apolo_v1` reads 61.0% carved from the back, 12.4% from above and **0.4%** from
 * the face, so the warning clears when the user picks the face they meant.
 */
export const PLINTH_WARN = 0.1;

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
      plinthRatio: 0,
    };
  }

  const { nx, ny } = gridSize(spanU, spanV, opts);
  const cw = spanU / nx;
  const chh = spanV / ny;

  // -Infinity marks "no triangle covered this cell" — distinguishable from a real
  // height of zMin, which a model's own base plane legitimately produces.
  const zbuf = new Float32Array(nx * ny).fill(-Infinity);
  // The model's UNDERSIDE at each cell. The gap between this and `zbuf` is the
  // model; everything below it is plinth the cutter can never reach.
  const zbot = new Float32Array(nx * ny).fill(Infinity);
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
        if (z < zbot[i]) zbot[i] = z;
      }
    }
  }

  // --- encode ---------------------------------------------------------------
  const range = b.maxH - b.minH;
  const gray = new Uint8Array(nx * ny);
  let emptyCells = 0;
  // Accumulated from the float buffers rather than from `gray`, so the ratio does
  // not inherit the 8-bit quantisation the encoding is about to impose.
  let carvedSum = 0;
  let spanSum = 0;
  if (!(range > 0)) {
    // A flat model has no relief to carve; everything is the top surface.
    gray.fill(255);
    for (let i = 0; i < zbuf.length; i++) if (zbuf[i] === -Infinity) emptyCells++;
  } else {
    const k = 255 / range;
    // A cell whose top and bottom coincide is a SKIN, not a solid: one surface
    // and nothing behind it. Both sums skip those, which is what keeps an open
    // mesh — a relief face exported without a back, as scanned and sculpted
    // reliefs routinely are — from reading a span of zero and therefore 100%
    // plinth, the loudest possible warning on the most relief-shaped input there
    // is. Excluding them costs a closed model nothing: the only cells it loses
    // are the knife-edge rim where the ray grazes the silhouette.
    const skin = range * 1e-6;
    for (let i = 0; i < zbuf.length; i++) {
      const z = zbuf[i];
      if (z === -Infinity) {
        emptyCells++;
        gray[i] = 0; // unmodelled → the base plane → full depth
        continue;
      }
      const thickness = z - zbot[i];
      if (thickness > skin) {
        carvedSum += z - b.minH;
        spanSum += thickness;
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
    // Every cell contributes the same area, so the cell area cancels and the two
    // height sums are the whole ratio.
    plinthRatio: carvedSum > 0 ? Math.max(0, 1 - spanSum / carvedSum) : 0,
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
