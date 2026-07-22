import type { Vec2 } from "../core/vec2";

/**
 * Rasterize a pocket with island keepouts via direct scanline interval subtraction.
 * `outer` is the inset boundary (already shrunk inward by tool radius).
 * `islands` are keepout polygons (each island already expanded outward by tool radius).
 * Winding direction of either polygon does not affect correctness.
 */
export function rasterRowsWithIslands(
  outer: Vec2[],
  islands: Vec2[][],
  stepoverMM: number,
): Vec2[][] {
  if (outer.length < 3 || stepoverMM <= 0) return [];

  let minY = Infinity,
    maxY = -Infinity;
  for (const v of outer) {
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }

  const polygons = [outer, ...islands];
  const rows: Vec2[][] = [];
  let ltr = true;

  for (let y = minY + stepoverMM * 0.5; y <= maxY + 1e-9; y += stepoverMM) {
    interface Event {
      x: number;
      polyIdx: number;
    }
    const events: Event[] = [];

    for (let pIdx = 0; pIdx < polygons.length; pIdx++) {
      const xs = scanlineXs(y, polygons[pIdx]);
      for (const x of xs) {
        events.push({ x, polyIdx: pIdx });
      }
    }

    if (events.length === 0) {
      ltr = !ltr;
      continue;
    }

    events.sort((a, b) => a.x - b.x);

    const inPoly = new Array<boolean>(polygons.length).fill(false);
    const intervals: [number, number][] = [];
    let activeStart: number | null = null;

    let i = 0;
    while (i < events.length) {
      const xCurr = events[i].x;

      while (i < events.length && Math.abs(events[i].x - xCurr) < 1e-9) {
        const pIdx = events[i].polyIdx;
        inPoly[pIdx] = !inPoly[pIdx];
        i++;
      }

      const inOuter = inPoly[0];
      let islandCount = 0;
      for (let p = 1; p < polygons.length; p++) {
        if (inPoly[p]) islandCount++;
      }

      const shouldMachine = inOuter && islandCount % 2 === 0;

      if (shouldMachine && activeStart === null) {
        activeStart = xCurr;
      } else if (!shouldMachine && activeStart !== null) {
        if (xCurr - activeStart > 1e-6) {
          intervals.push([activeStart, xCurr]);
        }
        activeStart = null;
      }
    }

    if (intervals.length === 0) {
      ltr = !ltr;
      continue;
    }

    const pts: Vec2[] = [];
    if (ltr) {
      for (const [a, b] of intervals) pts.push({ x: a, y }, { x: b, y });
    } else {
      for (let k = intervals.length - 1; k >= 0; k--)
        pts.push({ x: intervals[k][1], y }, { x: intervals[k][0], y });
    }
    rows.push(pts);
    ltr = !ltr;
  }

  return rows;
}

export function rasterRows(verts: Vec2[], stepoverMM: number): Vec2[][] {
  if (verts.length < 3 || stepoverMM <= 0) return [];

  let minY = Infinity,
    maxY = -Infinity;
  for (const v of verts) {
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }

  const rows: Vec2[][] = [];
  let ltr = true; // left-to-right on even rows

  for (let y = minY + stepoverMM * 0.5; y <= maxY + 1e-9; y += stepoverMM) {
    const xs = scanlineXs(y, verts);
    if (xs.length < 2) {
      ltr = !ltr;
      continue;
    }

    const pts: Vec2[] = [];
    if (ltr) {
      for (let i = 0; i + 1 < xs.length; i += 2) pts.push({ x: xs[i], y }, { x: xs[i + 1], y });
    } else {
      for (let i = xs.length - 2; i >= 0; i -= 2) pts.push({ x: xs[i + 1], y }, { x: xs[i], y });
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
    const a = verts[i],
      b = verts[(i + 1) % n];
    if (a.y <= y !== b.y <= y) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
  }
  return xs.sort((a, b) => a - b);
}
