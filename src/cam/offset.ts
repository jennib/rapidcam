import type { Vec2 } from "../core/vec2";
import { inflatePathsD, JoinType, EndType, differenceD, FillRule } from "clipper2-ts";

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

/**
 * Offset a closed polygon by `d` mm using Clipper2.
 * Positive d expands (outward), negative d shrinks (inward).
 * Returns one or more result polygons — a large inward offset on a concave
 * shape can split into multiple pieces, each of which needs to be cut.
 */
export function offsetPolygon(pts: Vec2[], d: number, miterLimit = 4): Vec2[][] {
  if (pts.length < 3) return [];
  const result = inflatePathsD([pts], d, JoinType.Miter, EndType.Polygon, miterLimit);
  return result.map(path => path.map(pt => ({ x: pt.x, y: pt.y })));
}

/**
 * Subtract clip polygons from a subject polygon using Clipper2.
 * Returns the resulting paths (may include outer boundaries and holes);
 * passing all result paths together to a multi-contour scanline gives the
 * correct cuttable region via the odd-even rule.
 */
export function subtractPolygons(subject: Vec2[], clips: Vec2[][]): Vec2[][] {
  if (clips.length === 0) return [subject];
  const result = differenceD([subject], clips, FillRule.NonZero);
  return result.map(path => path.map(pt => ({ x: pt.x, y: pt.y })));
}
