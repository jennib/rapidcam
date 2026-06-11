import type { Vec2 } from "../core/vec2";

/**
 * Generate zig-zag raster rows for pocket clearing.
 * `verts` must already be the inset polygon (offset inward by tool radius).
 * Returns rows in traversal order; odd rows are reversed for zig-zag.
 * Each row is a flat array of points: [p0, p1, p2, p3 ...] where pairs
 * [p0,p1], [p2,p3] etc. are individual cut segments (multiple pairs arise
 * from concave polygons). Between consecutive points on the same row the
 * cutter stays at cut depth.
 */
/**
 * Like rasterRows but accepts multiple contours (outer boundaries + holes).
 * Collecting all scanline intersections across all contours and pairing them
 * via the odd-even rule correctly excludes island regions.
 */
export function rasterRowsMulti(contours: Vec2[][], stepoverMM: number): Vec2[][] {
  if (contours.length === 0 || stepoverMM <= 0) return [];

  let minY = Infinity, maxY = -Infinity;
  for (const c of contours)
    for (const v of c) {
      if (v.y < minY) minY = v.y;
      if (v.y > maxY) maxY = v.y;
    }

  const rows: Vec2[][] = [];
  let ltr = true;

  for (let y = minY + stepoverMM * 0.5; y <= maxY + 1e-9; y += stepoverMM) {
    const xs: number[] = [];
    for (const c of contours) xs.push(...scanlineXs(y, c));
    xs.sort((a, b) => a - b);
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
