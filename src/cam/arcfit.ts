/**
 * Greedy arc fitting for tool-compensated profile polylines.
 *
 * When a curved profile is offset by the tool radius (via Clipper), the result
 * comes back as many short straight segments approximating the true offset
 * curve. Posting those verbatim emits a long run of tiny G1 moves — faceted
 * surface finish and a bloated program. This fits circular arcs back onto runs
 * of segments that lie on a common circle (within `tolMM`), so curved profiles
 * post as smooth G2/G3 while straight runs stay G1.
 *
 * Guarantees it never emits *worse* than the G1 facets: every fitted arc keeps
 * all the original vertices it spans within `tolMM` of the arc, and anything
 * that isn't clearly circular falls back to a line. A purely straight-edged
 * profile (rectangle, bracket) therefore posts identically to before.
 *
 * The fit is greedy: from each start vertex, grow the longest run whose points
 * all lie on one circle, capped at {@link MAX_SWEEP} so a single arc never spans
 * an ambiguous near-half-turn (a full circle becomes a few arcs, not one
 * degenerate move). Direction (G2 vs G3) comes from the signed swept angle.
 */

import type { Vec2 } from "../core/vec2";

/** One emitted move. `arc` carries the absolute centre; the poster converts to I/J. */
export type FitMove =
  | { kind: "line"; to: Vec2 }
  | { kind: "arc"; to: Vec2; cx: number; cy: number; cw: boolean };

/** Largest angle (rad) a single fitted arc may sweep (~150°). Keeps the 3-point
 *  circle fit well-conditioned and each arc unambiguously under a half turn. */
const MAX_SWEEP = (150 * Math.PI) / 180;

/** Centre + radius of the circle through three points, or null if collinear. */
function circleFrom3(a: Vec2, b: Vec2, c: Vec2): { cx: number; cy: number; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  const cx = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const cy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { cx, cy, r: Math.hypot(a.x - cx, a.y - cy) };
}

/** Signed swept angle (rad) from pts[i] to pts[j] around the centre; sign: +CCW. */
function sweptAngle(cx: number, cy: number, pts: Vec2[], i: number, j: number): number {
  let total = 0;
  let prev = Math.atan2(pts[i].y - cy, pts[i].x - cx);
  for (let k = i + 1; k <= j; k++) {
    const a = Math.atan2(pts[k].y - cy, pts[k].x - cx);
    let dDelta = a - prev;
    while (dDelta > Math.PI) dDelta -= 2 * Math.PI;
    while (dDelta < -Math.PI) dDelta += 2 * Math.PI;
    total += dDelta;
    prev = a;
  }
  return total;
}

export interface ArcFitOpts {
  /**
   * Max deviation (mm) of any spanned vertex/segment-midpoint from the fitted
   * arc. Default 0.05 — matched to the app's curve tessellation (beziers and
   * text flatten at ~0.05 mm), so arc-fitting actually recognises tessellated
   * curves while staying well inside a typical CNC arc tolerance. Below the
   * tessellation pitch it would never trigger; far above it would round corners.
   */
  tolMM?: number;
  /** Radii above this are treated as straight (a line). Default 5000 mm. */
  maxRadiusMM?: number;
  /** Minimum segments an arc must span (so 2-segment corners stay lines). Default 3. */
  minArcSegs?: number;
}

/**
 * Fit arcs to a polyline `path` (the vertex sequence, in order). Returns a list
 * of {@link FitMove}s whose `to` points, followed in order from `path[0]`,
 * retrace `path` — straight runs as lines, circular runs as arcs.
 */
export function fitArcs(path: Vec2[], opts: ArcFitOpts = {}): FitMove[] {
  const tol = opts.tolMM ?? 0.05;
  const maxR = opts.maxRadiusMM ?? 5000;
  const minSegs = opts.minArcSegs ?? 3;
  const moves: FitMove[] = [];
  const n = path.length;
  if (n < 2) return moves;

  let i = 0;
  while (i < n - 1) {
    let end = -1;
    let endCircle: { cx: number; cy: number; r: number } | null = null;
    for (let j = i + 2; j < n; j++) {
      const c = circleFrom3(path[i], path[(i + j) >> 1], path[j]);
      if (!c || c.r > maxR) break;
      let ok = true;
      for (let k = i; k <= j; k++) {
        if (Math.abs(Math.hypot(path[k].x - c.cx, path[k].y - c.cy) - c.r) > tol) { ok = false; break; }
      }
      // Also require segment MIDPOINTS to lie on the arc. Vertices alone aren't
      // enough: a square's corners all sit on their circumcircle, but the edges
      // chord far inside it — only the midpoint test rejects that and keeps
      // straight-edged profiles as lines.
      if (ok) {
        for (let k = i; k < j; k++) {
          const mx = (path[k].x + path[k + 1].x) / 2, my = (path[k].y + path[k + 1].y) / 2;
          if (Math.abs(Math.hypot(mx - c.cx, my - c.cy) - c.r) > tol) { ok = false; break; }
        }
      }
      if (!ok) break;
      if (Math.abs(sweptAngle(c.cx, c.cy, path, i, j)) > MAX_SWEEP) break;
      end = j;
      endCircle = c;
    }
    if (end >= 0 && end - i >= minSegs && endCircle) {
      const cw = sweptAngle(endCircle.cx, endCircle.cy, path, i, end) < 0;
      moves.push({ kind: "arc", to: path[end], cx: endCircle.cx, cy: endCircle.cy, cw });
      i = end;
    } else {
      moves.push({ kind: "line", to: path[i + 1] });
      i = i + 1;
    }
  }
  return moves;
}
