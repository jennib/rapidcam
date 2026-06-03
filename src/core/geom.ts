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
