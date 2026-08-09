/**
 * Radial-engagement simulator: how much of the cutter is buried in uncut
 * material at each point along a toolpath.
 *
 * This is a *measuring instrument*, not part of the app, and it is deliberately
 * built on nothing the clearing code uses — a bitmap of material instead of
 * Clipper polygons, and a direct sampling of the tool's circumference instead of
 * any of the geometry the generator reasons with. If both used the same model, a
 * wrong assumption in the generator would be invisible: the test would agree
 * with it and report success.
 *
 * Method: mark the region to be cleared into a grid, then walk the tool-centre
 * path pass by pass. Within a pass, engagement at a point is the fraction of the
 * tool's circumference sitting in the material *as it stood when that pass
 * began*; the pass's whole swept area is removed at the end of it.
 *
 * The per-pass snapshot is the crux, and the first version of this file got it
 * wrong. Clearing cell by cell as the tool advances measures the sliver of
 * uncut material immediately ahead of the cutter, which is a function of the
 * simulation step size, not of the toolpath: it read 50° on a cut where the
 * geometry says 157°. Radial engagement is set by the spacing between THIS pass
 * and the one before it, so the material a pass is eating into has to be held
 * still while that pass is measured.
 *
 * A pass is therefore whatever the caller says removes material as a unit: one
 * offset loop, or one trochoidal loop. Give it too much in one pass — a
 * trochoidal path handed over as a single pass — and it will over-report, since
 * the path crosses ground it cleared itself.
 */

import type { Vec2 } from "../src/core/vec2";

export interface EngagementOptions {
  /** Grid cell size, mm. Smaller = more accurate and slower. */
  cell?: number;
  /** Points sampled around the tool circumference. 72 = 5° resolution. */
  angles?: number;
  /** Distance between successive measurements along the path, mm. */
  stepMM?: number;
}

export interface EngagementResult {
  /** Worst engagement seen anywhere on the path, degrees. */
  maxDeg: number;
  /** Where that happened. */
  worstAt: Vec2;
  /** Engagement at every sampled step, in path order. */
  series: number[];
  /** Median of the non-zero samples — the "normal" cutting load for this path. */
  medianDeg: number;
  /** Fraction of the region's material the path actually removed (0..1). */
  cleared: number;
}

/** Even-odd point-in-polygon test. */
function inPolygon(pt: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Inside `outer` and outside every hole. */
function inRegion(pt: Vec2, outer: Vec2[], holes: Vec2[][]): boolean {
  if (!inPolygon(pt, outer)) return false;
  for (const h of holes) if (inPolygon(pt, h)) return false;
  return true;
}

/** Resample a polyline so successive points are at most `step` apart. */
export function densify(path: Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i],
      b = path[i + 1];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(d / step));
    for (let k = 0; k < n; k++) {
      out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
    }
  }
  if (path.length) out.push(path[path.length - 1]);
  return out;
}

/**
 * Run `passes` (each a run of tool-centre positions that removes material as a
 * unit, in cutting order) through the material of `region` with a cutter of
 * radius `toolR`.
 */
export function simulateEngagement(
  passes: Vec2[][],
  region: { outer: Vec2[]; holes: Vec2[][] },
  toolR: number,
  opts: EngagementOptions = {},
): EngagementResult {
  const cell = opts.cell ?? 0.15;
  const angles = opts.angles ?? 72;
  const stepMM = opts.stepMM ?? 0.25;

  // Grid covering the region, padded by a tool diameter so the cutter can sit
  // outside the material without indexing off the edge.
  const allPts = passes.flat();
  const xs = region.outer.map((p) => p.x);
  const ys = region.outer.map((p) => p.y);
  const pad = toolR * 2 + cell;
  const minX = Math.min(...xs) - pad,
    minY = Math.min(...ys) - pad;
  const maxX = Math.max(...xs) + pad,
    maxY = Math.max(...ys) + pad;
  const nx = Math.ceil((maxX - minX) / cell);
  const ny = Math.ceil((maxY - minY) / cell);

  const material = new Uint8Array(nx * ny);
  let total = 0;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const p = { x: minX + (ix + 0.5) * cell, y: minY + (iy + 0.5) * cell };
      if (inRegion(p, region.outer, region.holes)) {
        material[iy * nx + ix] = 1;
        total++;
      }
    }
  }

  const at = (x: number, y: number): number => {
    const ix = Math.floor((x - minX) / cell);
    const iy = Math.floor((y - minY) / cell);
    if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) return 0;
    return material[iy * nx + ix];
  };

  const series: number[] = [];
  let maxDeg = 0;
  let worstAt: Vec2 = allPts[0] ?? { x: 0, y: 0 };

  // Sample the circumference just inside the cutting edge: exactly on it, a
  // tangent wall would flicker in and out of the material by one cell.
  const probeR = toolR - cell;
  const r2 = toolR * toolR;

  /** Clear every cell under a tool centred at c. */
  const cut = (c: Vec2): void => {
    const ix0 = Math.max(0, Math.floor((c.x - toolR - minX) / cell));
    const ix1 = Math.min(nx - 1, Math.ceil((c.x + toolR - minX) / cell));
    const iy0 = Math.max(0, Math.floor((c.y - toolR - minY) / cell));
    const iy1 = Math.min(ny - 1, Math.ceil((c.y + toolR - minY) / cell));
    for (let iy = iy0; iy <= iy1; iy++) {
      const py = minY + (iy + 0.5) * cell;
      for (let ix = ix0; ix <= ix1; ix++) {
        const px = minX + (ix + 0.5) * cell;
        const dx = px - c.x,
          dy = py - c.y;
        if (dx * dx + dy * dy <= r2) material[iy * nx + ix] = 0;
      }
    }
  };

  for (const pass of passes) {
    if (pass.length === 0) continue;
    const walk = densify(pass, stepMM);
    // Measure the whole pass against the material it started with...
    for (const c of walk) {
      let hits = 0;
      for (let k = 0; k < angles; k++) {
        const a = (2 * Math.PI * k) / angles;
        if (at(c.x + probeR * Math.cos(a), c.y + probeR * Math.sin(a))) hits++;
      }
      const deg = (hits / angles) * 360;
      series.push(deg);
      if (deg > maxDeg) {
        maxDeg = deg;
        worstAt = c;
      }
    }
    // ...then remove what it cut, so the next pass sees the truth.
    for (const c of walk) cut(c);
  }

  let left = 0;
  for (let i = 0; i < material.length; i++) left += material[i];

  const cutting = series.filter((d) => d > 1).sort((a, b) => a - b);
  const medianDeg = cutting.length ? cutting[Math.floor(cutting.length / 2)] : 0;

  return {
    maxDeg,
    worstAt,
    series,
    medianDeg,
    cleared: total === 0 ? 1 : (total - left) / total,
  };
}
