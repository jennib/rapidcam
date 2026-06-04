/** Geometry helpers used for hit-testing, snapping, and the adaptive grid. */

import { Vec2, sub, dot, lenSq, dist, scale, add } from "./vec2";

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/** Closest point on the segment a→b to point p, plus the param t in [0,1]. */
export function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; t: number } {
  const ab = sub(b, a);
  const l2 = lenSq(ab);
  if (l2 === 0) return { point: a, t: 0 };
  const t = clamp(dot(sub(p, a), ab) / l2, 0, 1);
  return { point: add(a, scale(ab, t)), t };
}

/** Distance from point p to segment a→b. */
export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  return dist(p, closestPointOnSegment(p, a, b).point);
}

/** Distance from point p to the circle outline (center c, radius r). */
export function distToCircle(p: Vec2, c: Vec2, r: number): number {
  return Math.abs(dist(p, c) - r);
}

/**
 * Distance from point p to an arc (CCW from startAngle to endAngle, world Y-up).
 * Returns distance to the arc curve itself; falls back to distance to the nearer endpoint.
 */
export function distToArc(p: Vec2, center: Vec2, radius: number, startAngle: number, endAngle: number): number {
  const theta = Math.atan2(p.y - center.y, p.x - center.x);
  // How far (CCW) from startAngle to theta, normalized to [0, 2π)
  const span = ((endAngle - startAngle) % TAU + TAU) % TAU;
  const t = ((theta - startAngle) % TAU + TAU) % TAU;
  if (t <= span) {
    return Math.abs(dist(p, center) - radius);
  }
  // Outside the arc span — distance to the nearer endpoint.
  const arcStart: Vec2 = { x: center.x + radius * Math.cos(startAngle), y: center.y + radius * Math.sin(startAngle) };
  const arcEnd: Vec2 = { x: center.x + radius * Math.cos(endAngle), y: center.y + radius * Math.sin(endAngle) };
  return Math.min(dist(p, arcStart), dist(p, arcEnd));
}

/** True when angle θ lies within the CCW arc from startAngle to endAngle. */
export function angleInArc(theta: number, startAngle: number, endAngle: number): boolean {
  const span = ((endAngle - startAngle) % TAU + TAU) % TAU;
  const t = ((theta - startAngle) % TAU + TAU) % TAU;
  return t <= span;
}

/**
 * Pick a "nice" rounded step (1, 2, 5 × 10ⁿ) that is >= the raw step.
 * Used to choose grid spacing so labels land on sensible values.
 */
export function niceStepUp(raw: number): number {
  if (raw <= 0 || !isFinite(raw)) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  const f = raw / base; // 1..10
  let nice: number;
  if (f <= 1) nice = 1;
  else if (f <= 2) nice = 2;
  else if (f <= 5) nice = 5;
  else nice = 10;
  return nice * base;
}

/** Normalize an angle to (-π, π]. */
export function normalizeAngle(a: number): number {
  while (a <= -Math.PI) a += 2 * Math.PI;
  while (a > Math.PI) a -= 2 * Math.PI;
  return a;
}

export const TAU = Math.PI * 2;
export const RAD2DEG = 180 / Math.PI;
export const DEG2RAD = Math.PI / 180;

// ---------------------------------------------------------------------------
// Cubic Bezier math
// ---------------------------------------------------------------------------

/** Evaluate a cubic Bezier at parameter t ∈ [0, 1]. */
export function evalBezier(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const mt = 1 - t;
  return {
    x: mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
    y: mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y,
  };
}

/** Exact axis-aligned bounding box of a cubic Bezier.
 *  Finds derivative roots (where the curve reaches its x/y extremes) using the
 *  quadratic formula and includes any interior extremes in the result. */
export function bezierBounds(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2): { min: Vec2; max: Vec2 } {
  const xs = [p0.x, p3.x], ys = [p0.y, p3.y];

  for (const axis of ["x", "y"] as const) {
    // Coefficients of dx/dt = 3(at² + bt + c) where:
    const a = -p0[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis];
    const b = 2 * (p0[axis] - 2 * p1[axis] + p2[axis]);
    const c = p1[axis] - p0[axis];
    const arr = axis === "x" ? xs : ys;

    if (Math.abs(a) < 1e-12) {
      if (Math.abs(b) > 1e-12) {
        const t = -c / b;
        if (t > 0 && t < 1) arr.push(evalBezier(p0, p1, p2, p3, t)[axis]);
      }
    } else {
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        for (const s of [-1, 1]) {
          const t = (-b + s * sq) / (2 * a);
          if (t > 0 && t < 1) arr.push(evalBezier(p0, p1, p2, p3, t)[axis]);
        }
      }
    }
  }

  return {
    min: { x: Math.min(...xs), y: Math.min(...ys) },
    max: { x: Math.max(...xs), y: Math.max(...ys) },
  };
}

/** Adaptively flatten a cubic Bezier to a polyline within the given chord tolerance (mm).
 *  The first point (p0) is always included; the result ends at p3. */
export function flattenBezier(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, tolerance: number): Vec2[] {
  const pts: Vec2[] = [{ x: p0.x, y: p0.y }];
  bezierSubdivide(p0, p1, p2, p3, tolerance * tolerance, pts);
  return pts;
}

function bezierSubdivide(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, tol2: number, out: Vec2[]): void {
  const dx = p3.x - p0.x, dy = p3.y - p0.y;
  const len2 = dx * dx + dy * dy;

  const distSq = (p: Vec2): number => {
    if (len2 < 1e-20) return (p.x - p0.x) ** 2 + (p.y - p0.y) ** 2;
    const t = ((p.x - p0.x) * dx + (p.y - p0.y) * dy) / len2;
    const cx = p0.x + t * dx - p.x, cy = p0.y + t * dy - p.y;
    return cx * cx + cy * cy;
  };

  if (Math.max(distSq(p1), distSq(p2)) <= tol2) {
    out.push({ x: p3.x, y: p3.y });
    return;
  }

  // De Casteljau subdivision at t = 0.5
  const m01x = (p0.x + p1.x) * 0.5, m01y = (p0.y + p1.y) * 0.5;
  const m12x = (p1.x + p2.x) * 0.5, m12y = (p1.y + p2.y) * 0.5;
  const m23x = (p2.x + p3.x) * 0.5, m23y = (p2.y + p3.y) * 0.5;
  const m012x = (m01x + m12x) * 0.5, m012y = (m01y + m12y) * 0.5;
  const m123x = (m12x + m23x) * 0.5, m123y = (m12y + m23y) * 0.5;
  const mx = (m012x + m123x) * 0.5, my = (m012y + m123y) * 0.5;

  bezierSubdivide(p0,             { x: m01x,  y: m01y  }, { x: m012x, y: m012y }, { x: mx, y: my }, tol2, out);
  bezierSubdivide({ x: mx, y: my }, { x: m123x, y: m123y }, { x: m23x,  y: m23y  }, p3,             tol2, out);
}
