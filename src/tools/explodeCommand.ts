/**
 * Explode: breaks selected rectangles and polylines into their individual line
 * segments, so each edge can be selected, dimensioned, and constrained on its
 * own. The inverse of Join. Arcs/circles/beziers are left untouched.
 */

import { Entity, EntityId, LineEntity, RectEntity, PolylineEntity } from "../model/entities";
import { CADDocument } from "../model/document";

function explodeEntity(e: Entity): LineEntity[] {
  if (e.type === "rectangle") {
    const c = (e as RectEntity).corners();
    return [
      new LineEntity(c[0], c[1]),
      new LineEntity(c[1], c[2]),
      new LineEntity(c[2], c[3]),
      new LineEntity(c[3], c[0]),
    ];
  }
  if (e.type === "polyline") {
    const pl = e as PolylineEntity;
    const out: LineEntity[] = [];
    const n = pl.points.length;
    const count = pl.closed ? n : n - 1;
    for (let i = 0; i < count; i++) {
      out.push(new LineEntity(pl.points[i], pl.points[(i + 1) % n]));
    }
    return out;
  }
  return [];
}

/**
 * Explode selected rectangles/polylines into line segments. Returns true if
 * anything changed. Caller must pushHistory() before invoking.
 */
export function explodeSelected(doc: CADDocument): boolean {
  const selected = doc.entities.filter((e) => e.selected);
  const toRemove: EntityId[] = [];
  const toAdd: LineEntity[] = [];

  for (const e of selected) {
    const lines = explodeEntity(e);
    if (lines.length === 0) continue;
    for (const ln of lines) {
      ln.layerId = e.layerId;
      ln.isConstruction = e.isConstruction;
      ln.selected = true;
    }
    toRemove.push(e.id);
    toAdd.push(...lines);
  }

  if (toRemove.length === 0) return false;
  for (const id of toRemove) doc.remove(id);
  for (const ln of toAdd) doc.add(ln);
  return true;
}
