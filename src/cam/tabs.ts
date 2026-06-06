import type { Vec2 } from "../core/vec2";

export interface TabRegion {
  sStart: number;
  sEnd: number;
}

export interface PathSegment {
  p0: Vec2;
  p1: Vec2;
  isTab: boolean;
}

/** Cumulative arc-lengths for a closed polygon. Returns n+1 values (last = total). */
export function pathLengths(verts: Vec2[]): number[] {
  const n = verts.length;
  const lengths: number[] = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    const dx = verts[next].x - verts[i].x;
    const dy = verts[next].y - verts[i].y;
    lengths[i + 1] = lengths[i] + Math.sqrt(dx * dx + dy * dy);
  }
  return lengths;
}

/** Distribute `count` tabs evenly around a closed path of `totalLength`. */
export function computeTabRegions(
  totalLength: number,
  count: number,
  tabWidth: number,
): TabRegion[] {
  if (count <= 0 || tabWidth <= 0 || totalLength <= 0) return [];
  const half    = tabWidth / 2;
  const spacing = totalLength / count;
  const regions: TabRegion[] = [];
  for (let i = 0; i < count; i++) {
    const center = spacing * (i + 0.5);
    const start  = center - half;
    const end    = center + half;
    if (start < 0) {
      regions.push({ sStart: totalLength + start, sEnd: totalLength });
      regions.push({ sStart: 0, sEnd: end });
    } else if (end > totalLength) {
      regions.push({ sStart: start, sEnd: totalLength });
      regions.push({ sStart: 0, sEnd: end - totalLength });
    } else {
      regions.push({ sStart: start, sEnd: end });
    }
  }
  return regions;
}

function isInTab(s: number, regions: TabRegion[]): boolean {
  return regions.some(r => s >= r.sStart && s <= r.sEnd);
}

/**
 * Split a closed polygon's edges at tab region boundaries.
 * `cumLengths` must be the output of `pathLengths(verts)` (n+1 values).
 */
export function splitPathForTabs(
  verts: Vec2[],
  cumLengths: number[],
  regions: TabRegion[],
): PathSegment[] {
  const n = verts.length;
  const segments: PathSegment[] = [];

  for (let i = 0; i < n; i++) {
    const p0      = verts[i];
    const p1      = verts[(i + 1) % n];
    const s0      = cumLengths[i];
    const s1      = cumLengths[i + 1];
    const edgeLen = s1 - s0;
    if (edgeLen < 1e-9) continue;

    // Collect all region boundary crossings within this edge (exclusive endpoints).
    const boundaries: { s: number; entering: boolean }[] = [];
    for (const r of regions) {
      if (r.sStart > s0 && r.sStart < s1) boundaries.push({ s: r.sStart, entering: true  });
      if (r.sEnd   > s0 && r.sEnd   < s1) boundaries.push({ s: r.sEnd,   entering: false });
    }
    boundaries.sort((a, b) => a.s - b.s);

    let curr  = p0;
    let inTab = isInTab(s0 + 1e-9, regions);

    for (const b of boundaries) {
      const t        = (b.s - s0) / edgeLen;
      const splitPt: Vec2 = { x: p0.x + t * (p1.x - p0.x), y: p0.y + t * (p1.y - p0.y) };
      segments.push({ p0: curr, p1: splitPt, isTab: inTab });
      curr  = splitPt;
      inTab = b.entering;
    }

    segments.push({ p0: curr, p1, isTab: inTab });
  }

  return segments;
}
