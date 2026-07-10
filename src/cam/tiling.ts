/**
 * Stitch — tiled large-format milling.
 *
 * When a design is bigger than the machine can reach, Stitch splits it into a
 * grid of tiles that each fit the machine bed. You cut one tile, reposition the
 * stock so the next tile is under the spindle, and cut again — using shared
 * registration features drilled/scored along the seams to realign accurately.
 *
 * This module is the *planner*: pure geometry that lays out the tile grid, the
 * internal seams, and the registration-feature positions. The motion clipping
 * and per-tile G-code emission build on the plan it produces (see the export
 * pipeline) — nothing here touches toolpaths or the document.
 *
 * All coordinates are in the same mm space as the design bounds passed in.
 */

import type { Vec2 } from "../core/vec2";
import type { Bounds } from "../model/entities";

export interface StitchOptions {
  /** Tile (machine-bed) size in mm. A tile is never larger than this. */
  tileW: number;
  tileH: number;
  /**
   * How far the *toolpaths* extend beyond the design geometry (mm) — the largest
   * outward tool-radius + lead of any op. The tiled region is padded by this so
   * an outermost outside-profile pass still fits inside its tile/the bed, rather
   * than tiling the raw geometry bounds and letting the overhang spill past the
   * edge. Default 0 (tile the geometry exactly).
   */
  toolpathMargin?: number;
  /** Registration features placed along each internal seam. Default 2. */
  featuresPerSeam?: number;
  /**
   * Inset (mm) of the outermost registration features from each seam end, so
   * they don't land right at a corner. Clamped so features always fit. Default 12.
   */
  featureInset?: number;
  /**
   * Keep-out rectangles (world mm) where registration features must not land —
   * e.g. the footprint of the part itself, so a dowel hole isn't drilled through
   * material when a seam cuts across a solid part. Features inside any of these
   * are dropped; a seam with no clear spot simply gets none (align by other means).
   */
  keepOut?: Bounds[];
}

/** One machine-bed-sized cut window. `rect` is the region of the design it covers. */
export interface TileCell {
  index: number; // row-major
  row: number;
  col: number;
  rect: Bounds;
}

/** An internal boundary shared by two adjacent tiles, with its registration features. */
export interface Seam {
  orientation: "vertical" | "horizontal";
  /** Seam segment endpoints (the shared edge between the two tiles). */
  a: Vec2;
  b: Vec2;
  /** Indices of the two tiles that share this seam. */
  tiles: [number, number];
  /** Registration-feature positions along the seam, shared by both tiles. */
  features: Vec2[];
}

export interface StitchPlan {
  cols: number;
  rows: number;
  /** The region actually tiled — the design bounds padded by `toolpathMargin`. */
  bounds: Bounds;
  tiles: TileCell[];
  seams: Seam[];
  /** Every registration feature across all seams, de-duplicated. */
  features: Vec2[];
}

/** Coordinates on the same 1e-3 mm grid are considered the same feature. */
const FEATURE_GRID = 1e-3;
const keyOf = (p: Vec2) => `${Math.round(p.x / FEATURE_GRID)},${Math.round(p.y / FEATURE_GRID)}`;

/** Two registration features closer than this (mm) give no angular reference — use one instead. */
const MIN_FEATURE_SEPARATION = 8;

/** Cut-plane edges partitioning [min, max] into steps of at most `step`. */
function edges(min: number, max: number, step: number): number[] {
  const span = max - min;
  // Round the exact-fit case down (300/150 → 2 tiles, not 3) with a relative tolerance.
  const n = Math.max(1, Math.ceil(span / step - 1e-6 * Math.max(1, span / step)));
  const es = Array.from({ length: n + 1 }, (_, i) => min + i * step);
  es[n] = max; // clamp the final edge to the true extent (last tile may be smaller)
  return es;
}

const inRect = (p: Vec2, r: Bounds) =>
  p.x >= r.min.x && p.x <= r.max.x && p.y >= r.min.y && p.y <= r.max.y;

/**
 * Lay out the tile grid, seams, and registration features for a design of the
 * given bounds. Returns a single-tile plan (no seams) when the design already
 * fits the bed.
 */
export function planTiles(bounds: Bounds, opts: StitchOptions): StitchPlan {
  const { tileW, tileH } = opts;
  if (!(tileW > 0) || !(tileH > 0)) throw new Error("tile size must be positive");

  const featuresPerSeam = opts.featuresPerSeam ?? 2;
  const featureInsetMM = opts.featureInset ?? 12;
  const keepOut = opts.keepOut ?? [];

  // Tile the *toolpath* extent, not the raw geometry, so an outermost outside
  // profile still fits its tile (its path bulges out by up to `toolpathMargin`).
  const m = Math.max(0, opts.toolpathMargin ?? 0);
  const region: Bounds =
    m > 0
      ? {
          min: { x: bounds.min.x - m, y: bounds.min.y - m },
          max: { x: bounds.max.x + m, y: bounds.max.y + m },
        }
      : bounds;

  const xs = edges(region.min.x, region.max.x, tileW);
  const ys = edges(region.min.y, region.max.y, tileH);
  const cols = xs.length - 1;
  const rows = ys.length - 1;

  const tiles: TileCell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push({
        index: r * cols + c,
        row: r,
        col: c,
        rect: { min: { x: xs[c], y: ys[r] }, max: { x: xs[c + 1], y: ys[r + 1] } },
      });
    }
  }

  const seams: Seam[] = [];
  const idx = (r: number, c: number) => r * cols + c;

  // A seam runs along one shared edge of a specific tile pair, so its features
  // always sit inside both tiles (needed later for reachable registration).
  const featuresAlong = (a: Vec2, b: Vec2): Vec2[] => {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const at = (t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

    // Fractions along the seam, inset from both ends. If the usable span is too
    // short for `featuresPerSeam` to be meaningfully separated, fall back to one
    // centred feature (two near-coincident dowels give no angular reference).
    const inset = len > 0 ? Math.min(featureInsetMM / len, 0.49) : 0.49;
    const usable = len * (1 - 2 * inset);
    let ts: number[];
    if (featuresPerSeam <= 1 || usable < MIN_FEATURE_SEPARATION) {
      ts = [0.5];
    } else {
      const hi = 1 - inset;
      ts = Array.from(
        { length: featuresPerSeam },
        (_, i) => inset + ((hi - inset) * i) / (featuresPerSeam - 1),
      );
    }

    // Drop any feature that would be drilled/scored into a keep-out region.
    return ts.map(at).filter((p) => !keepOut.some((r) => inRect(p, r)));
  };

  // Vertical seams between horizontally-adjacent tiles.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const x = xs[c + 1];
      const a = { x, y: ys[r] },
        b = { x, y: ys[r + 1] };
      seams.push({
        orientation: "vertical",
        a,
        b,
        tiles: [idx(r, c), idx(r, c + 1)],
        features: featuresAlong(a, b),
      });
    }
  }
  // Horizontal seams between vertically-adjacent tiles.
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows - 1; r++) {
      const y = ys[r + 1];
      const a = { x: xs[c], y },
        b = { x: xs[c + 1], y };
      seams.push({
        orientation: "horizontal",
        a,
        b,
        tiles: [idx(r, c), idx(r + 1, c)],
        features: featuresAlong(a, b),
      });
    }
  }

  // De-duplicate features shared where seams cross.
  const seen = new Set<string>();
  const features: Vec2[] = [];
  for (const s of seams) {
    for (const f of s.features) {
      const k = keyOf(f);
      if (!seen.has(k)) {
        seen.add(k);
        features.push(f);
      }
    }
  }

  return { cols, rows, bounds: region, tiles, seams, features };
}
