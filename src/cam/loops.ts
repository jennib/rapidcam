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
} from "../model/entities";

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

/**
 * Collect every closed loop in the given entities: circles, rectangles,
 * closed polylines, and closed chains of line segments. Construction
 * geometry is skipped.
 */
export function collectClosedLoops(entities: Iterable<Entity>): RegionLoop[] {
  const loops: RegionLoop[] = [];
  const lines: LineEntity[] = [];
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
    } else if (e instanceof LineEntity) {
      lines.push(e);
    }
  }
  const { chains } = groupLinesIntoClosedChains(lines);
  for (const chain of chains)
    loops.push({ verts: chainToPolygon(chain), ids: chain.map((s) => s.id) });
  return loops;
}

