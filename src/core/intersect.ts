/**
 * Geometric intersections between entities, used for "intersection" object
 * snapping. Each entity is reduced to primitives (line segments and circular
 * arcs), and primitives are intersected pairwise with the exact helpers in
 * geom.ts. Only intersections near a query point are returned, and the entity
 * set is pre-filtered by bounding box so this stays cheap on every mouse move.
 */

import type { Vec2 } from "./vec2";
import type {
  Entity,
  LineEntity,
  CircleEntity,
  ArcEntity,
  RectEntity,
  PolylineEntity,
  BezierEntity,
  EntityId,
} from "../model/entities";
import {
  segSegIntersect,
  segCircleIntersect,
  circleCircleIntersect,
  angleInArc,
  flattenBezier,
} from "./geom";

interface Seg {
  a: Vec2;
  b: Vec2;
  /**
   * Which sub-curve of the owning entity this is, as a `#suffix` — a rectangle
   * edge (`mid_b`) or a polyline segment (its start-vertex id). Absent when the
   * entity IS the curve (a line), or when its parts cannot be named (a
   * flattened bezier or text outline).
   *
   * Without this an intersection could only name the whole entity, and
   * `pointOnLine` against a bare rectangle id resolves to nothing — a
   * constraint that looks real and holds the point nowhere.
   */
  ref?: string;
}
/** A full circle (a0/a1 undefined) or an arc spanning CCW from a0 to a1. */
interface Circ {
  c: Vec2;
  r: number;
  a0?: number;
  a1?: number;
}
interface Prims {
  segs: Seg[];
  circs: Circ[];
}

function primitives(e: Entity): Prims {
  switch (e.type) {
    case "line": {
      const l = e as LineEntity;
      return { segs: [{ a: l.a, b: l.b }], circs: [] };
    }
    case "rectangle": {
      // corners() is bl, br, tr, tl — so the edges run bottom, right, top, left,
      // which is exactly the order RECT_EDGE_CORNERS names them in.
      const c = (e as RectEntity).corners();
      return {
        segs: [
          { a: c[0], b: c[1], ref: "mid_b" },
          { a: c[1], b: c[2], ref: "mid_r" },
          { a: c[2], b: c[3], ref: "mid_t" },
          { a: c[3], b: c[0], ref: "mid_l" },
        ],
        circs: [],
      };
    }
    case "polyline": {
      const p = e as PolylineEntity;
      const segs: Seg[] = [];
      const n = p.points.length;
      const count = p.closed ? n : n - 1;
      // Keyed by the segment's START VERTEX id, which is what
      // `segmentByStartVertexId` resolves and what survives a vertex insert.
      for (let i = 0; i < count; i++)
        segs.push({ a: p.points[i], b: p.points[(i + 1) % n], ref: p.vertexIds[i] });
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

/** A crossing plus which sub-curve of each side produced it (see Seg.ref). */
interface PairHit {
  point: Vec2;
  refA?: string;
  refB?: string;
}

function pairIntersections(a: Prims, b: Prims, out: PairHit[]): void {
  for (const s1 of a.segs)
    for (const s2 of b.segs) {
      const r = segSegIntersect(s1.a, s1.b, s2.a, s2.b);
      if (r) out.push({ point: r.point, refA: s1.ref, refB: s2.ref });
    }
  // `flip` keeps the refs on the side they came from: the second call passes
  // b's segments against a's circles, so its seg ref belongs to B.
  const segVsCirc = (segs: Seg[], circs: Circ[], flip: boolean) => {
    for (const s of segs)
      for (const c of circs)
        for (const h of segCircleIntersect(s.a, s.b, c.c, c.r))
          if (onArc(c, h.point))
            out.push(flip ? { point: h.point, refB: s.ref } : { point: h.point, refA: s.ref });
  };
  segVsCirc(a.segs, b.circs, false);
  segVsCirc(b.segs, a.circs, true);
  for (const c1 of a.circs)
    for (const c2 of b.circs)
      for (const p of circleCircleIntersect(c1.c, c1.r, c2.c, c2.r))
        if (onArc(c1, p) && onArc(c2, p)) out.push({ point: p });
}

/**
 * Intersection points between the given entities that lie within `tolWorld`
 * (mm) of `near`. Entities are pre-filtered to those whose bounds reach `near`.
 */
/**
 * A crossing, and the two entities that made it.
 *
 * The ids are the point of this type. Snapping to a crossing and NOT recording
 * what crossed is how a circle centred on an intersection ended up with no
 * constraint at all: the position was right and nothing held it there, so the
 * first edit to either line left the circle behind.
 */
export interface IntersectionHit {
  pos: Vec2;
  ids: [EntityId, EntityId];
}

export function intersectionsNear(
  entities: Entity[],
  near: Vec2,
  tolWorld: number,
): IntersectionHit[] {
  const cand = entities.filter((e) => {
    const b = e.bounds();
    return (
      near.x >= b.min.x - tolWorld &&
      near.x <= b.max.x + tolWorld &&
      near.y >= b.min.y - tolWorld &&
      near.y <= b.max.y + tolWorld
    );
  });
  const prims = cand.map(primitives);
  const hits: IntersectionHit[] = [];
  const raw: PairHit[] = [];
  // `<id>#<edge>` when the crossing is on one named edge of a multi-edge shape,
  // so the constraint names the EDGE and not the whole rectangle.
  const qualify = (id: EntityId, ref?: string) => (ref ? `${id}#${ref}` : id);
  for (let i = 0; i < cand.length; i++) {
    for (let j = i + 1; j < cand.length; j++) {
      raw.length = 0;
      pairIntersections(prims[i], prims[j], raw);
      for (const h of raw) {
        if (Math.abs(h.point.x - near.x) <= tolWorld && Math.abs(h.point.y - near.y) <= tolWorld)
          hits.push({
            pos: h.point,
            ids: [qualify(cand[i].id, h.refA), qualify(cand[j].id, h.refB)],
          });
      }
    }
  }
  return hits;
}
