/**
 * Closed-loop utilities shared by the CAM dialog (region picking) and the
 * G-code / stock-preview generators (chaining line segments into polygons).
 */

import type { Vec2 } from "../core/vec2";
import {
  type Entity,
  LineEntity,
  CircleEntity,
  RectEntity,
  PolylineEntity,
  ArcEntity,
  BezierEntity,
} from "../model/entities";
import { flattenBezier } from "../core/geom";

const TAU = Math.PI * 2;

const EPS = 1e-4;

/**
 * Group an array of LineEntity objects into:
 *   chains  — arrays that form closed loops (≥3 segments, endpoints meet)
 *   singles — remaining open-path segments not part of any closed loop
 */
export function groupLinesIntoClosedChains(lines: LineEntity[]): { chains: LineEntity[][], singles: LineEntity[] } {
  const unused = new Set(lines);
  const chains: LineEntity[][] = [];
  const singles: LineEntity[] = [];

  while (unused.size > 0) {
    const start = unused.values().next().value as LineEntity;
    unused.delete(start);

    const component: LineEntity[] = [start];
    let frontA = { x: start.a.x, y: start.a.y };
    let frontB = { x: start.b.x, y: start.b.y };

    let growing = true;
    while (growing) {
      growing = false;
      for (const seg of unused) {
        const da_a = Math.hypot(frontA.x - seg.a.x, frontA.y - seg.a.y);
        const da_b = Math.hypot(frontA.x - seg.b.x, frontA.y - seg.b.y);
        const db_a = Math.hypot(frontB.x - seg.a.x, frontB.y - seg.a.y);
        const db_b = Math.hypot(frontB.x - seg.b.x, frontB.y - seg.b.y);
        if (db_a < EPS) { component.push(seg);    unused.delete(seg); frontB = { x: seg.b.x, y: seg.b.y }; growing = true; break; }
        if (db_b < EPS) { component.push(seg);    unused.delete(seg); frontB = { x: seg.a.x, y: seg.a.y }; growing = true; break; }
        if (da_a < EPS) { component.unshift(seg); unused.delete(seg); frontA = { x: seg.b.x, y: seg.b.y }; growing = true; break; }
        if (da_b < EPS) { component.unshift(seg); unused.delete(seg); frontA = { x: seg.a.x, y: seg.a.y }; growing = true; break; }
      }
    }

    const closed = component.length >= 3 &&
      Math.hypot(frontA.x - frontB.x, frontA.y - frontB.y) < EPS;

    if (closed) chains.push(component);
    else singles.push(...component);
  }

  return { chains, singles };
}

/** Ordered polygon vertices from a closed chain (as produced by groupLinesIntoClosedChains). */
export function chainToPolygon(chain: LineEntity[]): Vec2[] {
  const near = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y) < EPS;
  // Start at the endpoint of seg 0 that does NOT touch seg 1, then walk forward.
  const s0 = chain[0], s1 = chain[1];
  let cur = (near(s0.b, s1.a) || near(s0.b, s1.b)) ? { ...s0.a } : { ...s0.b };
  const poly: Vec2[] = [];
  for (const seg of chain) {
    poly.push(cur);
    cur = near(seg.a, cur) ? { ...seg.b } : { ...seg.a };
  }
  return poly;
}

export interface ChainedPolygon {
  verts: Vec2[];
  segs: LineEntity[];
}

/**
 * Chain loose line segments into as many closed polygons as they form.
 * `leftover` holds segments that do not belong to any closed loop.
 */
export function chainLinesIntoPolygons(lines: LineEntity[]): { polygons: ChainedPolygon[]; leftover: LineEntity[] } {
  const { chains, singles } = groupLinesIntoClosedChains(lines);
  return {
    polygons: chains.map((c) => ({ verts: chainToPolygon(c), segs: c })),
    leftover: singles,
  };
}

/** Even-odd ray-cast point-in-polygon test. */
export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) &&
        p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside;
  }
  return inside;
}

/** A closed loop usable for region picking: polygon outline plus its source entity id(s). */
export interface RegionLoop {
  verts: Vec2[];
  ids: string[];
}

/** An open curve (line/arc/bezier/open-polyline) flattened for loop chaining. */
interface OpenSeg {
  id: string;
  a: Vec2;          // first endpoint
  b: Vec2;          // last endpoint
  pts: Vec2[];      // densified vertices a→b inclusive (≥2)
}

/** Tessellate an arc (CCW from startAngle to endAngle) into polyline points. */
function arcPoints(arc: ArcEntity): Vec2[] {
  let span = ((arc.endAngle - arc.startAngle) % TAU + TAU) % TAU;
  if (span < 1e-9) span = TAU; // full circle
  const steps = Math.max(2, Math.ceil(span / (Math.PI / 45))); // ~4° chords
  return Array.from({ length: steps + 1 }, (_, k) => {
    const a = arc.startAngle + (span * k) / steps;
    return { x: arc.center.x + arc.radius * Math.cos(a), y: arc.center.y + arc.radius * Math.sin(a) };
  });
}

/** An open curve as a chainable segment, or null for non-open-curve entities. */
function openSegOf(e: Entity): OpenSeg | null {
  if (e instanceof LineEntity) return { id: e.id, a: { ...e.a }, b: { ...e.b }, pts: [{ ...e.a }, { ...e.b }] };
  if (e instanceof ArcEntity) {
    const pts = arcPoints(e);
    return { id: e.id, a: pts[0], b: pts[pts.length - 1], pts };
  }
  if (e instanceof BezierEntity) {
    const pts = flattenBezier(e.p0, e.p1, e.p2, e.p3, 0.1);
    return { id: e.id, a: pts[0], b: pts[pts.length - 1], pts };
  }
  if (e instanceof PolylineEntity && !e.closed && e.points.length >= 2) {
    const pts = e.points.map((p) => ({ ...p }));
    return { id: e.id, a: pts[0], b: pts[pts.length - 1], pts };
  }
  return null;
}

/** Walk open segments into closed chains by endpoint adjacency (any curve type). */
function groupSegsIntoClosedChains(segs: OpenSeg[]): OpenSeg[][] {
  const near = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y) < EPS;
  const unused = new Set(segs);
  const chains: OpenSeg[][] = [];
  while (unused.size > 0) {
    const start = unused.values().next().value as OpenSeg;
    unused.delete(start);
    const comp: OpenSeg[] = [start];
    let frontA = start.a, frontB = start.b;
    let growing = true;
    while (growing) {
      growing = false;
      for (const s of unused) {
        if (near(frontB, s.a)) { comp.push(s);    unused.delete(s); frontB = s.b; growing = true; break; }
        if (near(frontB, s.b)) { comp.push(s);    unused.delete(s); frontB = s.a; growing = true; break; }
        if (near(frontA, s.a)) { comp.unshift(s); unused.delete(s); frontA = s.b; growing = true; break; }
        if (near(frontA, s.b)) { comp.unshift(s); unused.delete(s); frontA = s.a; growing = true; break; }
      }
    }
    if (comp.length >= 2 && near(frontA, frontB)) chains.push(comp);
  }
  return chains;
}

/** Concatenate a chain's densified points into a single closed polygon outline. */
function chainSegsToPolygon(chain: OpenSeg[]): Vec2[] {
  const near = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y) < EPS;
  // Start at the endpoint of seg 0 that does NOT meet seg 1.
  let cur: Vec2;
  if (chain.length === 1) cur = chain[0].a;
  else {
    const s0 = chain[0], s1 = chain[1];
    cur = (near(s0.b, s1.a) || near(s0.b, s1.b)) ? s0.a : s0.b;
  }
  const poly: Vec2[] = [];
  for (const seg of chain) {
    const pts = near(seg.a, cur) ? seg.pts : [...seg.pts].reverse();
    for (let i = 0; i < pts.length - 1; i++) poly.push({ ...pts[i] }); // drop joint (== next start)
    cur = pts[pts.length - 1];
  }
  return poly;
}

/**
 * Collect every closed loop in the given entities: circles, rectangles, closed
 * polylines, and closed chains of any open curves (lines, arcs, beziers, and
 * open polylines — e.g. a rectangle whose corner was filleted into a line+arc
 * loop). Construction geometry is skipped.
 */
export function collectClosedLoops(entities: Iterable<Entity>): RegionLoop[] {
  const loops: RegionLoop[] = [];
  const segs: OpenSeg[] = [];
  for (const e of entities) {
    if (e.isConstruction) continue;
    if (e instanceof CircleEntity) {
      const n = Math.max(64, Math.ceil((2 * Math.PI * e.radius) / 0.5));
      loops.push({
        verts: Array.from({ length: n }, (_, i) => {
          const a = (i / n) * 2 * Math.PI;
          return { x: e.center.x + e.radius * Math.cos(a), y: e.center.y + e.radius * Math.sin(a) };
        }),
        ids: [e.id],
      });
    } else if (e instanceof RectEntity) {
      loops.push({ verts: [...e.corners()], ids: [e.id] });
    } else if (e instanceof PolylineEntity && e.closed && e.points.length >= 3) {
      loops.push({ verts: e.points, ids: [e.id] });
    } else {
      const s = openSegOf(e);
      if (s) segs.push(s);
    }
  }
  for (const chain of groupSegsIntoClosedChains(segs)) {
    const verts = chainSegsToPolygon(chain);
    if (verts.length >= 3) loops.push({ verts, ids: chain.map((s) => s.id) });
  }
  return loops;
}

