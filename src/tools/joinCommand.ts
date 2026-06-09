/**
 * Join: chains selected lines, arcs, and open polylines that share endpoints
 * into one polyline per connected run.  Closes the result if the chain loops.
 * Arcs are tessellated (~2° per step) since PolylineEntity stores linear pts.
 */

import { Vec2, dist, clone } from "../core/vec2";
import { Entity, EntityId, LineEntity, ArcEntity, PolylineEntity } from "../model/entities";
import { CADDocument } from "../model/document";
import { TAU } from "../core/geom";

const JOIN_TOL = 0.01; // mm — endpoint-matching tolerance

// ---------------------------------------------------------------------------
// Segment extraction
// ---------------------------------------------------------------------------

interface Seg {
  id: EntityId;
  pts: Vec2[];
}

function tessellateArc(arc: ArcEntity): Vec2[] {
  let span = ((arc.endAngle - arc.startAngle) % TAU + TAU) % TAU;
  if (span < 1e-10) span = TAU;
  const steps = Math.max(4, Math.ceil(span / (Math.PI / 90))); // ~2° per step
  const pts: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = arc.startAngle + (span * i) / steps;
    pts.push({ x: arc.center.x + arc.radius * Math.cos(a), y: arc.center.y + arc.radius * Math.sin(a) });
  }
  return pts;
}

function toSeg(e: Entity): Seg | null {
  if (e.type === "line") {
    const l = e as LineEntity;
    return { id: l.id, pts: [clone(l.a), clone(l.b)] };
  }
  if (e.type === "arc") {
    return { id: e.id, pts: tessellateArc(e as ArcEntity) };
  }
  if (e.type === "polyline") {
    const pl = e as PolylineEntity;
    if (pl.closed || pl.points.length < 2) return null;
    return { id: pl.id, pts: pl.points.map(clone) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Chain building
// ---------------------------------------------------------------------------

interface Chain {
  pts: Vec2[];
  ids: EntityId[];
}

function buildChains(segs: Seg[]): Chain[] {
  const pool = segs.slice();
  const used = new Set<EntityId>();
  const chains: Chain[] = [];

  for (const seed of pool) {
    if (used.has(seed.id)) continue;
    used.add(seed.id);

    const chain: Chain = { pts: seed.pts.slice(), ids: [seed.id] };

    // Grow from the chain's tail
    let grew = true;
    while (grew) {
      grew = false;
      const tail = chain.pts[chain.pts.length - 1];
      for (const seg of pool) {
        if (used.has(seg.id)) continue;
        const s0 = seg.pts[0], sN = seg.pts[seg.pts.length - 1];
        if (dist(tail, s0) < JOIN_TOL) {
          chain.pts.push(...seg.pts.slice(1));
          chain.ids.push(seg.id);
          used.add(seg.id);
          grew = true; break;
        } else if (dist(tail, sN) < JOIN_TOL) {
          chain.pts.push(...seg.pts.slice().reverse().slice(1));
          chain.ids.push(seg.id);
          used.add(seg.id);
          grew = true; break;
        }
      }
    }

    // Grow from the chain's head
    grew = true;
    while (grew) {
      grew = false;
      const head = chain.pts[0];
      for (const seg of pool) {
        if (used.has(seg.id)) continue;
        const s0 = seg.pts[0], sN = seg.pts[seg.pts.length - 1];
        if (dist(head, sN) < JOIN_TOL) {
          chain.pts.unshift(...seg.pts.slice(0, -1));
          chain.ids.push(seg.id);
          used.add(seg.id);
          grew = true; break;
        } else if (dist(head, s0) < JOIN_TOL) {
          chain.pts.unshift(...seg.pts.slice().reverse().slice(0, -1));
          chain.ids.push(seg.id);
          used.add(seg.id);
          grew = true; break;
        }
      }
    }

    chains.push(chain);
  }

  return chains;
}

// ---------------------------------------------------------------------------
// Public command
// ---------------------------------------------------------------------------

/** Join selected lines, arcs, and open polylines into one polyline per
 *  connected chain.  Returns true if anything was changed.
 *  Caller must call pushHistory() before invoking. */
export function joinSelected(doc: CADDocument): boolean {
  const selected = doc.entities.filter(e => e.selected);
  const segs = selected.map(toSeg).filter((s): s is Seg => s !== null);
  if (segs.length < 2) return false;

  const chains = buildChains(segs);
  const joinedIds = new Set<EntityId>();
  const toAdd: PolylineEntity[] = [];

  for (const chain of chains) {
    if (chain.ids.length < 2) continue;

    const head = chain.pts[0];
    const tail = chain.pts[chain.pts.length - 1];
    const closed = dist(head, tail) < JOIN_TOL;
    const pts = closed ? chain.pts.slice(0, -1) : chain.pts;

    const pl = new PolylineEntity(pts, closed);
    pl.selected = true;
    const firstSrc = selected.find(e => e.id === chain.ids[0]);
    if (firstSrc) pl.layerId = firstSrc.layerId;

    for (const id of chain.ids) joinedIds.add(id);
    toAdd.push(pl);
  }

  if (joinedIds.size === 0) return false;

  for (const id of joinedIds) doc.remove(id);
  for (const pl of toAdd) doc.add(pl);
  return true;
}
