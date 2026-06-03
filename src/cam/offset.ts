import type { Vec2 } from "../core/vec2";

/** Signed area of a closed polygon (positive = CCW in Y-up world). */
export function signedArea(pts: Vec2[]): number {
  let a = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return a / 2;
}

/**
 * Offset a closed polygon by `d` mm.
 * Positive d expands (outward), negative d shrinks (inward).
 * Uses miter-join at each vertex (intersection of adjacent offset edges).
 * Works correctly for convex polygons; for concave shapes, very large offsets
 * may produce self-intersecting results — acceptable for mill-width offsets.
 */
export function offsetPolygon(pts: Vec2[], d: number): Vec2[] {
  if (pts.length < 3) return pts.map((p) => ({ ...p }));

  // Normalise to CCW so outward normals are consistent
  const area = signedArea(pts);
  const verts = area < 0 ? [...pts].reverse() : [...pts];
  const n = verts.length;
  const result: Vec2[] = [];

  for (let i = 0; i < n; i++) {
    const prev = verts[(i - 1 + n) % n];
    const curr = verts[i];
    const next = verts[(i + 1) % n];

    // Incoming edge prev→curr
    const ix = curr.x - prev.x, iy = curr.y - prev.y;
    const il = Math.hypot(ix, iy);
    // Outgoing edge curr→next
    const ox = next.x - curr.x, oy = next.y - curr.y;
    const ol = Math.hypot(ox, oy);

    if (il < 1e-10 || ol < 1e-10) {
      result.push({ x: curr.x, y: curr.y });
      continue;
    }

    // Outward normals for CCW polygon: rotate edge 90° CW → (ey/|e|, -ex/|e|)
    const ni: Vec2 = { x: iy / il, y: -ix / il };
    const no: Vec2 = { x: oy / ol, y: -ox / ol };

    // A point on each offset edge (the vertex itself shifted by d * normal)
    const pi: Vec2 = { x: curr.x + d * ni.x, y: curr.y + d * ni.y };
    const po: Vec2 = { x: curr.x + d * no.x, y: curr.y + d * no.y };

    // Unit directions of the offset edges
    const di: Vec2 = { x: ix / il, y: iy / il };
    const doo: Vec2 = { x: ox / ol, y: oy / ol };

    // Intersect the two infinite offset lines: pi + t*di = po + s*doo
    const denom = di.x * doo.y - di.y * doo.x;
    if (Math.abs(denom) < 1e-10) {
      // Parallel edges — average the two offset points
      result.push({ x: (pi.x + po.x) / 2, y: (pi.y + po.y) / 2 });
    } else {
      const dx = po.x - pi.x, dy = po.y - pi.y;
      const t = (dx * doo.y - dy * doo.x) / denom;
      result.push({ x: pi.x + t * di.x, y: pi.y + t * di.y });
    }
  }

  // Restore original winding
  return area < 0 ? result.reverse() : result;
}
