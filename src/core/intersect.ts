/**
 * Geometric intersections between entities, used for "intersection" object
 * snapping. Each entity is reduced to primitives (line segments and circular
 * arcs), and primitives are intersected pairwise with the exact helpers in
 * geom.ts. Only intersections near a query point are returned, and the entity
 * set is pre-filtered by bounding box so this stays cheap on every mouse move.
 */

import { Vec2 } from "./vec2";
import {
  Entity,
  LineEntity,
  CircleEntity,
  ArcEntity,
  RectEntity,
  PolylineEntity,
  BezierEntity,
} from "../model/entities";
import {
  segSegIntersect,
  segCircleIntersect,
  circleCircleIntersect,
  angleInArc,
  flattenBezier,
} from "./geom";

interface Seg { a: Vec2; b: Vec2; }
/** A full circle (a0/a1 undefined) or an arc spanning CCW from a0 to a1. */
interface Circ { c: Vec2; r: number; a0?: number; a1?: number; }
interface Prims { segs: Seg[]; circs: Circ[]; }

function primitives(e: Entity): Prims {
  switch (e.type) {
    case "line": {
      const l = e as LineEntity;
      return { segs: [{ a: l.a, b: l.b }], circs: [] };
    }
    case "rectangle": {
      const c = (e as RectEntity).corners();
      return {
        segs: [
          { a: c[0], b: c[1] }, { a: c[1], b: c[2] },
          { a: c[2], b: c[3] }, { a: c[3], b: c[0] },
        ],
        circs: [],
      };
    }
    case "polyline": {
      const p = e as PolylineEntity;
      const segs: Seg[] = [];
      const n = p.points.length;
      const count = p.closed ? n : n - 1;
      for (let i = 0; i < count; i++) segs.push({ a: p.points[i], b: p.points[(i + 1) % n] });
      return { segs, circs: [] };
    }
    case "circle": {
      const c = e as CircleEntity;
      return { segs: [], circs: [{ c: c.center, r: c.radius }] };
    }
    case "arc": {
      const a = e as ArcEntity;
      return { segs: [], circs: [{ c: a.center, r: a.radius, a0: a.startAngle, a1: a.endAngle }] };
    }
    case "bezier": {
      const b = e as BezierEntity;
      const pts = flattenBezier(b.p0, b.p1, b.p2, b.p3, 0.1);
      const segs: Seg[] = [];
      for (let i = 0; i < pts.length - 1; i++) segs.push({ a: pts[i], b: pts[i + 1] });
      return { segs, circs: [] };
    }
    default:
      return { segs: [], circs: [] };
  }
}

function onArc(c: Circ, p: Vec2): boolean {
  if (c.a0 === undefined || c.a1 === undefined) return true; // full circle
  return angleInArc(Math.atan2(p.y - c.c.y, p.x - c.c.x), c.a0, c.a1);
}

function pairIntersections(a: Prims, b: Prims, out: Vec2[]): void {
  for (const s1 of a.segs) for (const s2 of b.segs) {
    const r = segSegIntersect(s1.a, s1.b, s2.a, s2.b);
    if (r) out.push(r.point);
  }
  const segVsCirc = (segs: Seg[], circs: Circ[]) => {
    for (const s of segs) for (const c of circs)
      for (const h of segCircleIntersect(s.a, s.b, c.c, c.r))
        if (onArc(c, h.point)) out.push(h.point);
  };
  segVsCirc(a.segs, b.circs);
  segVsCirc(b.segs, a.circs);
  for (const c1 of a.circs) for (const c2 of b.circs)
    for (const p of circleCircleIntersect(c1.c, c1.r, c2.c, c2.r))
      if (onArc(c1, p) && onArc(c2, p)) out.push(p);
}

/**
 * Intersection points between the given entities that lie within `tolWorld`
 * (mm) of `near`. Entities are pre-filtered to those whose bounds reach `near`.
 */
export function intersectionsNear(entities: Entity[], near: Vec2, tolWorld: number): Vec2[] {
  const cand = entities.filter((e) => {
    const b = e.bounds();
    return near.x >= b.min.x - tolWorld && near.x <= b.max.x + tolWorld
      && near.y >= b.min.y - tolWorld && near.y <= b.max.y + tolWorld;
  });
  const prims = cand.map(primitives);
  const hits: Vec2[] = [];
  const raw: Vec2[] = [];
  for (let i = 0; i < cand.length; i++) {
    for (let j = i + 1; j < cand.length; j++) {
      raw.length = 0;
      pairIntersections(prims[i], prims[j], raw);
      for (const p of raw) {
        if (Math.abs(p.x - near.x) <= tolWorld && Math.abs(p.y - near.y) <= tolWorld) hits.push(p);
      }
    }
  }
  return hits;
}
