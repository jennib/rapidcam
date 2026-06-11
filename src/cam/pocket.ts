import type { Vec2 } from "../core/vec2";

/**
 * Rasterize a pocket with island keepouts via direct scanline interval subtraction.
 * `outer` is the inset boundary (already shrunk inward by tool radius).
 * `islands` are keepout polygons (each island already expanded outward by tool radius).
 * Winding direction of either polygon does not affect correctness.
 */
export function rasterRowsWithIslands(outer: Vec2[], islands: Vec2[][], stepoverMM: number): Vec2[][] {
  if (outer.length < 3 || stepoverMM <= 0) return [];

  let minY = Infinity, maxY = -Infinity;
  for (const v of outer) {
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }

  const rows: Vec2[][] = [];
  let ltr = true;

  for (let y = minY + stepoverMM * 0.5; y <= maxY + 1e-9; y += stepoverMM) {
    const oxs = scanlineXs(y, outer);
    let intervals: [number, number][] = [];
    for (let i = 0; i + 1 < oxs.length; i += 2)
      intervals.push([oxs[i], oxs[i + 1]]);

    for (const island of islands) {
      const ixs = scanlineXs(y, island);
      for (let i = 0; i + 1 < ixs.length; i += 2) {
        const il = ixs[i], ir = ixs[i + 1];
        const next: [number, number][] = [];
        for (const [ol, or_] of intervals) {
          if (ir <= ol || il >= or_) { next.push([ol, or_]); continue; }
          if (ol < il) next.push([ol, il]);
          if (ir < or_) next.push([ir, or_]);
        }
        intervals = next;
      }
    }

    if (intervals.length === 0) { ltr = !ltr; continue; }

    const pts: Vec2[] = [];
    if (ltr) {
      for (const [a, b] of intervals) pts.push({ x: a, y }, { x: b, y });
    } else {
      for (let i = intervals.length - 1; i >= 0; i--)
        pts.push({ x: intervals[i][1], y }, { x: intervals[i][0], y });
    }
    rows.push(pts);
    ltr = !ltr;
  }

  return rows;
}

export function rasterRows(verts: Vec2[], stepoverMM: number): Vec2[][] {
  if (verts.length < 3 || stepoverMM <= 0) return [];

  let minY = Infinity, maxY = -Infinity;
  for (const v of verts) {
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }

  const rows: Vec2[][] = [];
  let ltr = true; // left-to-right on even rows

  for (let y = minY + stepoverMM * 0.5; y <= maxY + 1e-9; y += stepoverMM) {
    const xs = scanlineXs(y, verts);
    if (xs.length < 2) { ltr = !ltr; continue; }

    const pts: Vec2[] = [];
    if (ltr) {
      for (let i = 0; i + 1 < xs.length; i += 2)
        pts.push({ x: xs[i], y }, { x: xs[i + 1], y });
    } else {
      for (let i = xs.length - 2; i >= 0; i -= 2)
        pts.push({ x: xs[i + 1], y }, { x: xs[i], y });
    }
    rows.push(pts);
    ltr = !ltr;
  }

  return rows;
}

function scanlineXs(y: number, verts: Vec2[]): number[] {
  const xs: number[] = [];
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const a = verts[i], b = verts[(i + 1) % n];
    if ((a.y <= y) !== (b.y <= y))
      xs.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
  }
  return xs.sort((a, b) => a - b);
}
