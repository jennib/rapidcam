/**
 * Explode: breaks selected rectangles and polylines into individual line
 * segments so each edge can be selected, dimensioned, and constrained on its own.
 *
 * A RectEntity is the simple, whole-shape primitive the Rectangle tool now draws
 * (one editable Width/Height). Exploding it is the "unlock" into the flexible
 * form: four LineEntities wired with the SAME parallel + perpendicular +
 * coincident constraints the old Rectangle tool used to emit up front, so the
 * result is a fully-constrained, rotatable rectangle — nothing is lost versus
 * the four-line rectangle of before, you just start locked and unlock on demand.
 * (Join is a different operation — it chains lines into a closed polyline, not
 * back into a RectEntity.)
 *
 * A polyline explodes into plain, unconstrained segments (its edges carry no
 * implied parallelism). Arcs/circles/beziers are left untouched.
 */

import { type EntityId, LineEntity, type RectEntity, type PolylineEntity } from "../model/entities";
import { type Constraint, makeConstraint } from "../model/constraints";
import type { CADDocument } from "../model/document";

/**
 * Four edge lines of `rect` plus the constraint set that makes them a rigid,
 * rotatable rectangle. Edge directions and endpoint keys match the historical
 * Rectangle tool exactly (bottom bl→br, right br→tr, top tl→tr, left bl→tl), so
 * the coincident corner links line up:
 *   bl: bottom.a = left.a   br: bottom.b = right.a
 *   tr: right.b  = top.b    tl: top.a    = left.b
 * plus bottom∥top, left∥right, bottom⊥left. Together: 4 lines with 5 DOF
 * (position + width + height + rotation), the same as a hand-drawn rectangle.
 */
function explodeRectangle(rect: RectEntity): { lines: LineEntity[]; constraints: Constraint[] } {
  const [bl, br, tr, tl] = rect.corners();
  const bottom = new LineEntity(bl, br);
  const right = new LineEntity(br, tr);
  const top = new LineEntity(tl, tr);
  const left = new LineEntity(bl, tl);

  const coin = (e1: LineEntity, k1: string, e2: LineEntity, k2: string): Constraint =>
    makeConstraint("coincident", {
      points: [
        { entityId: e1.id, key: k1 },
        { entityId: e2.id, key: k2 },
      ],
    });

  const constraints: Constraint[] = [
    makeConstraint("parallel", { entities: [bottom.id, top.id] }),
    makeConstraint("parallel", { entities: [left.id, right.id] }),
    makeConstraint("perpendicular", { entities: [bottom.id, left.id] }),
    coin(bottom, "a", left, "a"), // bottom-left
    coin(bottom, "b", right, "a"), // bottom-right
    coin(right, "b", top, "b"), // top-right
    coin(top, "a", left, "b"), // top-left
  ];
  return { lines: [bottom, right, top, left], constraints };
}

/** Plain (unconstrained) segments of an open or closed polyline. */
function explodePolyline(pl: PolylineEntity): LineEntity[] {
  const out: LineEntity[] = [];
  const n = pl.points.length;
  const count = pl.closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    out.push(new LineEntity(pl.points[i], pl.points[(i + 1) % n]));
  }
  return out;
}

/**
 * Explode selected rectangles/polylines into line segments. A rectangle also
 * gains the constraint set that keeps it a rectangle (see {@link explodeRectangle}).
 * Returns true if anything changed. Caller must pushHistory() before invoking and
 * re-solve afterwards (app.explodeSelectedEntities does both).
 */
export function explodeSelected(doc: CADDocument): boolean {
  const selected = doc.entities.filter((e) => e.selected);
  const toRemove: EntityId[] = [];
  const toAdd: LineEntity[] = [];
  const constraints: Constraint[] = [];

  for (const e of selected) {
    let lines: LineEntity[];
    if (e.type === "rectangle") {
      const r = explodeRectangle(e as RectEntity);
      lines = r.lines;
      constraints.push(...r.constraints);
    } else if (e.type === "polyline") {
      lines = explodePolyline(e as PolylineEntity);
    } else {
      continue; // arcs/circles/beziers/points are left as-is
    }
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
  // Lines must exist before their constraints reference them.
  for (const ln of toAdd) doc.add(ln);
  for (const c of constraints) doc.addConstraint(c);
  return true;
}
