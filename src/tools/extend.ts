/**
 * Extend geometry: grow a line or arc from the clicked end until it meets the
 * nearest other entity. Pure functions so the behaviour is unit-testable; the
 * ExtendTool wraps these with hit-testing, preview, and document mutation.
 */

import { Vec2, dist, sub, dot, normalize } from "../core/vec2";
import {
  Entity, LineEntity, ArcEntity, CircleEntity, PolylineEntity, RectEntity, BezierEntity,
} from "../model/entities";
import { segSegIntersect, segCircleIntersect, circleCircleIntersect, angleInArc, flattenBezier, TAU } from "../core/geom";

const EPS = 1e-7;
const RAY = 1e7; // "infinite" ray length in mm
const normAngle = (a: number): number => ((a % TAU) + TAU) % TAU;
const onCircle = (c: Vec2, r: number, a: number): Vec2 => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });

/** Straight segments of an entity used as extension targets. */
function entitySegs(e: Entity): [Vec2, Vec2][] {
  if (e instanceof LineEntity) return [[e.a, e.b]];
  if (e instanceof PolylineEntity) {
    const n = e.points.length;
    const m = e.closed ? n : n - 1;
    const out: [Vec2, Vec2][] = [];
    for (let i = 0; i < m; i++) out.push([e.points[i], e.points[(i + 1) % n]]);
    return out;
  }
  if (e instanceof RectEntity) {
    const c = e.corners();
    return [[c[0], c[1]], [c[1], c[2]], [c[2], c[3]], [c[3], c[0]]];
  }
  if (e instanceof BezierEntity) {
    const p = flattenBezier(e.p0, e.p1, e.p2, e.p3, 0.1);
    const out: [Vec2, Vec2][] = [];
    for (let i = 0; i + 1 < p.length; i++) out.push([p[i], p[i + 1]]);
    return out;
  }
  return [];
}

/** Forward hits of the ray from `origin` along unit `dir` against `ent`. */
function rayEntityHits(origin: Vec2, dir: Vec2, ent: Entity): { point: Vec2; d: number }[] {
  const far = { x: origin.x + dir.x * RAY, y: origin.y + dir.y * RAY };
  const out: { point: Vec2; d: number }[] = [];
  const push = (p: Vec2) => {
    const d = dot(sub(p, origin), dir);
    if (d > EPS) out.push({ point: p, d });
  };
  if (ent instanceof CircleEntity) {
    for (const h of segCircleIntersect(origin, far, ent.center, ent.radius)) push(h.point);
  } else if (ent instanceof ArcEntity) {
    for (const h of segCircleIntersect(origin, far, ent.center, ent.radius))
      if (angleInArc(h.theta, ent.startAngle, ent.endAngle)) push(h.point);
  } else {
    for (const [a, b] of entitySegs(ent)) {
      const ix = segSegIntersect(origin, far, a, b);
      if (ix) push(ix.point);
    }
  }
  return out;
}

/** Intersection points of the full circle (center, r) with `ent`. */
function circlePoints(center: Vec2, r: number, ent: Entity): Vec2[] {
  if (ent instanceof CircleEntity) return circleCircleIntersect(center, r, ent.center, ent.radius);
  if (ent instanceof ArcEntity)
    return circleCircleIntersect(center, r, ent.center, ent.radius)
      .filter((p) => angleInArc(Math.atan2(p.y - ent.center.y, p.x - ent.center.x), ent.startAngle, ent.endAngle));
  const pts: Vec2[] = [];
  for (const [a, b] of entitySegs(ent))
    for (const h of segCircleIntersect(a, b, center, r)) pts.push(h.point);
  return pts;
}

/**
 * Where to extend `line` to, based on which end the cursor is near. Returns the
 * endpoint to move and its new position, or null if nothing lies ahead.
 */
export function lineExtension(line: LineEntity, clickPos: Vec2, others: Entity[]): { end: "a" | "b"; target: Vec2 } | null {
  const end: "a" | "b" = dist(clickPos, line.a) < dist(clickPos, line.b) ? "a" : "b";
  const origin = end === "a" ? line.a : line.b;
  const other = end === "a" ? line.b : line.a;
  const dir = normalize(sub(origin, other));
  if (dir.x === 0 && dir.y === 0) return null;

  let best: { point: Vec2; d: number } | null = null;
  for (const ent of others)
    for (const h of rayEntityHits(origin, dir, ent))
      if (!best || h.d < best.d) best = h;
  return best ? { end, target: { ...best.point } } : null;
}

/**
 * New angle to extend `arc` to, based on which end the cursor is near. Returns
 * the endpoint to move ("start" sweeps CW, "end" sweeps CCW) and the angle of
 * the first entity it reaches, or null if nothing lies ahead.
 */
export function arcExtension(arc: ArcEntity, clickPos: Vec2, others: Entity[]): { end: "start" | "end"; angle: number } | null {
  const sp = onCircle(arc.center, arc.radius, arc.startAngle);
  const ep = onCircle(arc.center, arc.radius, arc.endAngle);
  const end: "start" | "end" = dist(clickPos, sp) < dist(clickPos, ep) ? "start" : "end";

  let bestAngle: number | null = null;
  let bestOff = Infinity;
  for (const ent of others) {
    for (const p of circlePoints(arc.center, arc.radius, ent)) {
      const theta = Math.atan2(p.y - arc.center.y, p.x - arc.center.x);
      const off = end === "end"
        ? normAngle(theta - arc.endAngle)   // sweep CCW past the end
        : normAngle(arc.startAngle - theta); // sweep CW past the start
      if (off > EPS && off < bestOff) { bestOff = off; bestAngle = theta; }
    }
  }
  return bestAngle === null ? null : { end, angle: bestAngle };
}
