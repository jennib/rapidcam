import type { Vec2 } from "../core/vec2";

/**
 * Returns true if the closed polygon has at least one reflex (concave) vertex.
 * Triangles are always convex. Uses the sign of consecutive cross products.
 */
export function isConcave(pts: Vec2[]): boolean {
  const n = pts.length;
  if (n < 4) return false;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], c = pts[(i + 2) % n];
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(z) < 1e-10) continue;
    const s = z > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return true;
  }
  return false;
}

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

// --- self-intersection removal -----------------------------------------------

function segIntersect(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): Vec2 | null {
  const dx1 = a2.x - a1.x, dy1 = a2.y - a1.y;
  const dx2 = b2.x - b1.x, dy2 = b2.y - b1.y;
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-10) return null;
  const ex = b1.x - a1.x, ey = b1.y - a1.y;
  const t = (ex * dy2 - ey * dx2) / denom;
  const u = (ex * dy1 - ey * dx1) / denom;
  if (t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9)
    return { x: a1.x + t * dx1, y: a1.y + t * dy1 };
  return null;
}

/**
 * Remove self-intersecting loops from a polygon.
 * Each pass finds the first edge crossing, discards the smaller-area sub-loop,
 * and repeats until the polygon is simple. O(n²) per pass — fine for CAD
 * polygon sizes (≤ a few hundred vertices).
 */
export function removeLoops(pts: Vec2[]): Vec2[] {
  let verts = pts;
  for (let pass = 0; pass < pts.length; pass++) {
    const n = verts.length;
    let found = false;
    scan:
    for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue; // wrap-around adjacent edges
        const p = segIntersect(verts[i], verts[(i + 1) % n], verts[j], verts[(j + 1) % n]);
        if (!p) continue;
        const ear  = [p, ...verts.slice(i + 1, j + 1)];
        const main = [...verts.slice(0, i + 1), p, ...verts.slice(j + 1)];
        verts = Math.abs(signedArea(ear)) >= Math.abs(signedArea(main)) ? ear : main;
        found = true;
        break scan;
      }
    }
    if (!found) break;
  }
  return verts;
}

// --- polygon offset ----------------------------------------------------------

/**
 * Offset a closed polygon by `d` mm.
 * Positive d expands (outward), negative d shrinks (inward).
 * Uses miter-join at each vertex (intersection of adjacent offset edges),
 * falling back to a bevel when the miter distance exceeds miterLimit × |d|.
 * Self-intersecting loops produced by concave vertices are removed automatically.
 */
export function offsetPolygon(pts: Vec2[], d: number, miterLimit = 4): Vec2[] {
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
      // Parallel edges — average the two offset points (bevel)
      result.push({ x: (pi.x + po.x) / 2, y: (pi.y + po.y) / 2 });
    } else {
      const dx = po.x - pi.x, dy = po.y - pi.y;
      const t = (dx * doo.y - dy * doo.x) / denom;
      const mx = pi.x + t * di.x, my = pi.y + t * di.y;
      // Bevel if miter spike exceeds miterLimit × |d| from the original vertex.
      const miterDist = Math.hypot(mx - curr.x, my - curr.y);
      if (miterDist > miterLimit * Math.abs(d)) {
        result.push({ x: (pi.x + po.x) / 2, y: (pi.y + po.y) / 2 });
      } else {
        result.push({ x: mx, y: my });
      }
    }
  }

  // Remove self-intersecting loops, then restore original winding
  const simple = removeLoops(result);
  return area < 0 ? simple.reverse() : simple;
}
