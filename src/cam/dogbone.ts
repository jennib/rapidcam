/**
 * Dog-bone corner relief for female (inside) toolpaths.
 *
 * A round cutter can't reach fully into an inside (concave-to-the-cut) corner of
 * a pocket or inside profile — it leaves a fillet of the tool radius. A mating
 * square part then won't seat. A *dog-bone* overcut drives the tool a little
 * past the corner along the corner's diagonal (the outward bisector) and back,
 * so the tool edge just reaches the true sharp corner and clears enough material
 * for the square part to fit.
 *
 * This operates on the *wall toolpath* — a closed loop already offset from the
 * finished geometry by the tool radius (as `offsetPolygon(part, -toolR)`
 * produces). At each convex corner of that loop (the corners that leave a
 * fillet), it injects an out-and-back spur; every other corner is untouched.
 *
 * T-bone relief (hiding the overcut along one wall instead of on the diagonal)
 * is a natural follow-up but not implemented here.
 */

import type { Vec2 } from "../core/vec2";
import { sub, cross, dot, len, normalize } from "../core/vec2";
import { signedArea } from "./offset";

/** Corners tighter than this (interior angle) are too acute to relieve sanely. */
const MIN_ANGLE = (20 * Math.PI) / 180;

/**
 * Return the dog-bone or T-bone overcut point for the corner at `v` (with neighbours `p`
 * and `q` on a CCW loop), or `null` if the corner shouldn't be relieved
 * (reflex, straight, too acute, or degenerate).
 *
 * The loop is the tool path, inset from the finished wall by `toolR`.
 */
export function dogbonePoint(
  p: Vec2,
  v: Vec2,
  q: Vec2,
  toolR: number,
  side: "inside" | "outside" = "inside",
  style: "dogbone" | "tbone" = "dogbone"
): Vec2 | null {
  if (toolR <= 0) return null;
  const e1 = sub(v, p); // incoming edge direction
  const e2 = sub(q, v); // outgoing edge direction
  const c = cross(e1, e2);
  
  if (side === "inside") {
    // On a CCW loop, a left turn (cross > 0) is a convex corner — the only kind
    // that leaves a fillet on an inside profile.
    if (c <= 1e-9) return null;
  } else {
    // On a CCW loop, a right turn (cross < 0) is a concave corner — the only kind
    // that leaves a fillet on an outside profile.
    if (c >= -1e-9) return null;
  }

  const u = normalize(sub(p, v)); // unit toward previous vertex
  const w = normalize(sub(q, v)); // unit toward next vertex
  if (len(u) === 0 || len(w) === 0) return null;

  const ang = Math.acos(Math.max(-1, Math.min(1, dot(u, w)))); // interior angle
  if (ang < MIN_ANGLE) return null; // too acute to relieve

  if (style === "tbone") {
    // A T-bone relief extends parallel to one of the walls. To preserve the longer
    // wall, we overcut the shorter wall. Moving along `u` overcuts the outgoing wall
    // and preserves the incoming wall.
    const dU = len(sub(v, p));
    const dW = len(sub(q, v));
    const dir = dU > dW ? u : w; 
    const distFromCorner = toolR / Math.tan(ang / 2);
    if (distFromCorner <= 1e-6) return null;
    return { x: v.x - dir.x * distFromCorner, y: v.y - dir.y * distFromCorner };
  } else {
    // Dogbone: Move along the bisector.
    const s = Math.sin(ang / 2);
    if (s < 1e-6) return null;

    const distFromCorner = toolR * (1 / s - 1);
    if (distFromCorner <= 1e-6) return null;

    // u + w is the internal bisector (pointing into the loop interior, away from the true corner).
    // Moving in the -bis direction moves exactly into the true corner, regardless of whether
    // it's an inside or outside profile.
    const bis = normalize({ x: u.x + w.x, y: u.y + w.y });
    if (len(bis) === 0) return null; // ~180°, no real corner
    
    return { x: v.x - bis.x * distFromCorner, y: v.y - bis.y * distFromCorner };
  }
}

/**
 * Insert corner relief spurs into a closed wall loop (vertices in order, the closing
 * edge implied — no repeated first point, matching `offsetPolygon` output).
 * Returns a new loop; the input is unchanged. A no-op loop (nothing to relieve)
 * comes back with the same vertices.
 */
export function addCornerReliefs(
  loop: Vec2[],
  toolR: number,
  side: "inside" | "outside" = "inside",
  style: "dogbone" | "tbone" = "dogbone"
): Vec2[] {
  const n = loop.length;
  if (n < 3 || toolR <= 0) return loop;
  // Work CCW so `dogbonePoint`'s left-turn test identifies convex corners.
  const ccw = signedArea(loop) >= 0 ? loop : [...loop].reverse();

  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const v = ccw[i];
    const p = ccw[(i - 1 + n) % n];
    const q = ccw[(i + 1) % n];
    out.push({ x: v.x, y: v.y });
    const spur = dogbonePoint(p, v, q, toolR, side, style);
    if (spur) {
      out.push(spur);
      out.push({ x: v.x, y: v.y }); // return to the corner before continuing
    }
  }
  return signedArea(loop) >= 0 ? out : out.reverse();
}
