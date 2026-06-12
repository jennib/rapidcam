/**
 * Flood-fill style region picking over the planar arrangement of closed loops.
 *
 * A "region" is the enclosed face of the drawing containing a given point —
 * bounded by the nearest geometry in every direction, exactly like a paint
 * bucket fill. Overlapping shapes therefore yield multiple pickable faces
 * (e.g. two overlapping rectangles → each crescent and the intersection), and
 * shapes fully inside a face become its holes (islands).
 */

import { intersectD, differenceD, FillRule } from "clipper2-ts";
import type { Vec2 } from "../core/vec2";
import { pointInPolygon, type RegionLoop } from "./loops";
import { signedArea } from "./offset";

export interface PickedRegion {
  outer: Vec2[];
  holes: Vec2[][];
  /** ids of the loops that bound the region (for entity highlighting). */
  loopIds: string[];
}

const toVecs = (paths: { x: number; y: number }[][]): Vec2[][] =>
  paths.map((path) => path.map((pt) => ({ x: pt.x, y: pt.y })));

/**
 * Compute the enclosed region containing `p`, or null if `p` is not inside
 * any loop. The region is the intersection of every loop containing `p`,
 * minus every other loop, reduced to the connected component containing `p`.
 */
export function regionAtPoint(p: Vec2, loops: RegionLoop[]): PickedRegion | null {
  const containing = loops.filter((L) => pointInPolygon(p, L.verts));
  if (containing.length === 0) return null;
  const others = loops.filter((L) => !containing.includes(L));

  let shape: Vec2[][] = [containing[0].verts];
  for (let i = 1; i < containing.length; i++) {
    shape = toVecs(intersectD(shape, [containing[i].verts], FillRule.NonZero));
    if (shape.length === 0) return null;
  }
  if (others.length > 0)
    shape = toVecs(differenceD(shape, others.map((L) => L.verts), FillRule.NonZero));

  // The result is a set of non-crossing rings (outers and holes). The
  // connected component containing p has, as its outer ring, the smallest
  // ring that contains p; its holes are the rings directly inside that.
  const around = shape.filter((ring) => ring.length >= 3 && pointInPolygon(p, ring));
  if (around.length === 0) return null;
  let outer = around[0];
  for (const ring of around)
    if (Math.abs(signedArea(ring)) < Math.abs(signedArea(outer))) outer = ring;
  const inside = shape.filter(
    (ring) => ring !== outer && ring.length >= 3 &&
      !pointInPolygon(p, ring) && pointInPolygon(ring[0], outer),
  );
  const holes = inside.filter(
    (ring) => !inside.some((other) => other !== ring && pointInPolygon(ring[0], other)),
  );

  const loopIds = new Set<string>();
  for (const L of containing) for (const id of L.ids) loopIds.add(id);
  // Loops that carve holes or notches into the region: any other loop with a
  // vertex inside the outer ring took part in bounding it.
  for (const L of others)
    if (L.verts.some((v) => pointInPolygon(v, outer)))
      for (const id of L.ids) loopIds.add(id);

  return { outer, holes, loopIds: [...loopIds] };
}

/**
 * A point strictly inside a polygon-with-holes: midpoint of the widest
 * scanline interval across the middle of the shape (several rows tried).
 */
export function interiorPoint(outer: Vec2[], holes: Vec2[][] = []): Vec2 | null {
  let minY = Infinity, maxY = -Infinity;
  for (const v of outer) {
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  if (!(maxY > minY)) return null;

  const rings = [outer, ...holes];
  let best: { p: Vec2; width: number } | null = null;
  for (const f of [0.5, 0.33, 0.67, 0.25, 0.75]) {
    const y = minY + (maxY - minY) * f;
    // Even-odd crossings across all rings give the inside intervals directly.
    const xs: number[] = [];
    for (const ring of rings) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const a = ring[i], b = ring[(i + 1) % n];
        if ((a.y <= y) !== (b.y <= y))
          xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const width = xs[i + 1] - xs[i];
      if (width > 1e-6 && (!best || width > best.width))
        best = { p: { x: (xs[i] + xs[i + 1]) / 2, y }, width };
    }
    if (best && best.width > 1e-3) break;
  }
  return best?.p ?? null;
}
