/**
 * Corner picking and corner surgery — shared by the Fillet and Chamfer tools.
 *
 * The two tools do genuinely different geometry (an arc tangent to both legs
 * versus a straight bevel across them), but everything AROUND that geometry was
 * the same, and had been copied verbatim into both files: the hit constants,
 * the Corner union, `findCorner`, `getCornerDirs`, the degenerate-angle check,
 * trimming the legs back to the tangent points, dropping the coincidence that
 * held the corner together, re-linking the new entity to both legs, and the
 * poly/rect splice. ~150 lines with nothing keeping the copies in step.
 *
 * What stays in each tool is only what actually differs: its own `computeGeo`,
 * its own preview, and how it builds the entity it inserts.
 */

import { type Vec2, dist } from "../core/vec2";
import type { CADDocument } from "../model/document";
import {
  CORNER_TYPE_LABELS,
  type CornerType,
  LineEntity,
  PolylineEntity,
  RectEntity,
} from "../model/entities";

/**
 * Shape a rectangle's corner by setting its radius, rather than by cutting the
 * geometry up.
 *
 * This is what retired a whole bug class. A rectangle used to be REPLACED by a
 * polyline on its first fillet, which is why "you can't edit a fillet — it
 * becomes a polyline", and why a rectangle pinned to the stock edge lost its pin
 * (#53 kept the id and remapped the keys, but the corner's own references still
 * had nowhere to go — one corner became forty-nine vertices). Now nothing is
 * replaced: the entity, its id, its `bl`/`br`/`tr`/`tl` keys and every
 * constraint naming them are untouched, and the radius stays editable in
 * Properties afterwards.
 *
 * Returns false when the radius will not fit beside its neighbour's — two
 * corners share an edge, so 30mm and 40mm corners cannot both sit on a 60mm
 * side. The caller says so rather than letting the clamp quietly draw something
 * smaller than was asked for.
 */
export function setRectCorner(corner: RectCorner, value: number, type: CornerType): boolean {
  const rect = corner.entity;
  if (!(value > 0) || !rect.fitsCornerRadius(corner.index, value)) return false;
  rect.cornerType = type;
  rect.cornerRadii[corner.index] = value;
  return true;
}

/**
 * Tell the user when shaping one corner re-typed the others.
 *
 * A rectangle has ONE corner type (as in Vectric), so filleting a corner of an
 * already-chamfered rectangle rounds all four. That is the right model — the
 * alternative is a preview that draws an arc and a tool that cuts a bevel — but
 * it is not guessable, so it is said out loud, and only when other corners were
 * actually shaped and therefore actually changed.
 */
export function reportRetype(
  corner: Corner,
  type: CornerType,
  ctx: { notify(msg: string): void },
): void {
  if (corner.kind !== "rect") return;
  const rect = corner.entity;
  if (rect.cornerType === type) return;
  if (!rect.cornerRadii.some((r, i) => i !== corner.index && r > 0)) return;
  ctx.notify(`All corners are now ${CORNER_TYPE_LABELS[type]} — a rectangle has one corner type.`);
}

/**
 * Whether `value` can be applied at this corner.
 *
 * Only rectangles can refuse: their two corners share an edge, so a radius that
 * is fine against its own legs still has to leave room for its neighbour. Used
 * by the previews as well as the commit, so a drag that has gone too far stops
 * drawing an arc that will not be created.
 */
export function cornerValueFits(corner: Corner, value: number): boolean {
  return corner.kind !== "rect" || corner.entity.fitsCornerRadius(corner.index, value);
}

/**
 * Every corner of the shape `corner` belongs to, HIGHEST INDEX FIRST.
 *
 * AutoCAD's `FILLET → Polyline` rounds every vertex of a polyline in one go, and
 * Illustrator's corner widgets round all corners together; doing a rectangle one
 * corner at a time is the friction that was reported. This is the corner list
 * that operation walks.
 *
 * **Descending order is load-bearing for a polyline, not tidiness.** Each fillet
 * replaces one vertex with several, so every index above it shifts. Walking down
 * means the indices still to come are all below the splice and therefore
 * untouched — no re-derivation, no bookkeeping. A rectangle's four corners are
 * fixed and cannot shift, so the order is merely harmless there.
 *
 * A line-line corner has no enclosing shape, so it yields only itself.
 */
export function shapeCorners(corner: Corner, doc: CADDocument): Corner[] {
  if (corner.kind === "line") return [corner];
  const id = corner.entity.id;
  const live = doc.entities.find((e) => e.id === id);
  const out: Corner[] = [];
  if (live instanceof RectEntity) {
    const c = live.corners();
    for (let i = 3; i >= 0; i--) out.push({ kind: "rect", entity: live, index: i, pos: c[i] });
  } else if (live instanceof PolylineEntity) {
    const n = live.points.length;
    for (let i = n - 1; i >= 0; i--) {
      // An open polyline's ends are not corners — nothing on the far side.
      if (!live.closed && (i === 0 || i === n - 1)) continue;
      out.push({ kind: "poly", entity: live, index: i, pos: live.points[i] });
    }
  }
  return out;
}

/**
 * Re-read the corner at `index` from the live document.
 *
 * A descriptor from {@link shapeCorners} carries a position, and shaping one
 * corner of a polyline moves the indices (and therefore the positions) of the
 * ones after it. Re-reading by id keeps a whole-shape walk honest, and returns
 * null for an index that no longer exists so the caller can report a skip
 * rather than working on a stale point.
 */
export function refreshCorner(corner: Corner, doc: CADDocument): Corner | null {
  if (corner.kind === "line") return corner;
  const live = doc.entities.find((e) => e.id === corner.entity.id);
  if (live instanceof RectEntity) {
    const c = live.corners();
    if (corner.index > 3) return null;
    return { kind: "rect", entity: live, index: corner.index, pos: c[corner.index] };
  }
  if (live instanceof PolylineEntity) {
    if (corner.index >= live.points.length) return null;
    return { kind: "poly", entity: live, index: corner.index, pos: live.points[corner.index] };
  }
  return null;
}

/** Two points closer than this are the same corner. */
export const CORNER_EPS = 1e-4;
/** Corner pick radius, in SCREEN pixels — divided by the view scale to get world units. */
export const HIT_PX = 16;
/** Pointer travel past which a press-release is a drag (live preview) rather than a click. */
export const DRAG_THRESHOLD_PX = 4;

export interface LineCorner {
  kind: "line";
  line1: LineEntity;
  key1: "a" | "b";
  line2: LineEntity;
  key2: "a" | "b";
  pos: Vec2;
}

export interface PolyCorner {
  kind: "poly";
  entity: PolylineEntity;
  index: number;
  pos: Vec2;
}

export interface RectCorner {
  kind: "rect";
  entity: RectEntity;
  index: number; // 0–3 in corners() order
  pos: Vec2;
}

export type Corner = LineCorner | PolyCorner | RectCorner;

/** The corner point and the two unit directions leading away from it, with leg lengths. */
export interface CornerDirs {
  P: Vec2;
  d1: Vec2;
  len1: number;
  d2: Vec2;
  len2: number;
}

// ---------------------------------------------------------------------------
// Corner detection
// ---------------------------------------------------------------------------

export function findCorner(worldPos: Vec2, doc: CADDocument, scale: number): Corner | null {
  const thresh = HIT_PX / scale;
  let best: { corner: Corner; d: number } | null = null;

  // Line-line corners
  let nearestPt: { line: LineEntity; key: "a" | "b"; pos: Vec2; d: number } | null = null;
  for (const ent of doc.entities) {
    if (!(ent instanceof LineEntity) || ent.isConstruction) continue;
    for (const key of ["a", "b"] as const) {
      const d = dist(worldPos, ent[key]);
      if (d < thresh && (!nearestPt || d < nearestPt.d))
        nearestPt = { line: ent, key, pos: ent[key], d };
    }
  }
  if (nearestPt) {
    for (const ent of doc.entities) {
      if (!(ent instanceof LineEntity) || ent.isConstruction || ent.id === nearestPt.line.id)
        continue;
      for (const key of ["a", "b"] as const) {
        if (dist(ent[key], nearestPt.pos) < CORNER_EPS) {
          if (!best || nearestPt.d < best.d)
            best = {
              corner: {
                kind: "line",
                line1: nearestPt.line,
                key1: nearestPt.key,
                line2: ent,
                key2: key,
                pos: nearestPt.pos,
              },
              d: nearestPt.d,
            };
        }
      }
    }
  }

  // Polyline vertices
  for (const ent of doc.entities) {
    if (!(ent instanceof PolylineEntity) || ent.isConstruction) continue;
    const n = ent.points.length;
    for (let i = 0; i < n; i++) {
      if (!ent.closed && (i === 0 || i === n - 1)) continue;
      const d = dist(worldPos, ent.points[i]);
      if (d < thresh && (!best || d < best.d))
        best = { corner: { kind: "poly", entity: ent, index: i, pos: ent.points[i] }, d };
    }
  }

  // Rect corners
  for (const ent of doc.entities) {
    if (!(ent instanceof RectEntity) || ent.isConstruction) continue;
    const corners = ent.corners();
    for (let i = 0; i < 4; i++) {
      const d = dist(worldPos, corners[i]);
      if (d < thresh && (!best || d < best.d))
        best = { corner: { kind: "rect", entity: ent, index: i, pos: corners[i] }, d };
    }
  }

  return best?.corner ?? null;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export function getCornerDirs(corner: Corner): CornerDirs | null {
  if (corner.kind === "line") {
    const { line1, key1, line2, key2, pos: P } = corner;
    const o1 = key1 === "a" ? line1.b : line1.a;
    const o2 = key2 === "a" ? line2.b : line2.a;
    return dirsFrom(P, o1, o2);
  } else if (corner.kind === "poly") {
    const { entity: pl, index: i } = corner;
    const n = pl.points.length;
    if (!pl.closed && (i === 0 || i === n - 1)) return null;
    return dirsFrom(pl.points[i], pl.points[(i - 1 + n) % n], pl.points[(i + 1) % n]);
  } else {
    const { entity: rect, index: i } = corner;
    const c = rect.corners();
    return dirsFrom(c[i], c[(i + 3) % 4], c[(i + 1) % 4]);
  }
}

/** Unit directions from `P` toward its two neighbours; null if either leg is degenerate. */
function dirsFrom(P: Vec2, prev: Vec2, next: Vec2): CornerDirs | null {
  const len1 = dist(P, prev),
    len2 = dist(P, next);
  if (len1 < CORNER_EPS || len2 < CORNER_EPS) return null;
  return {
    P,
    d1: { x: (prev.x - P.x) / len1, y: (prev.y - P.y) / len1 },
    len1,
    d2: { x: (next.x - P.x) / len2, y: (next.y - P.y) / len2 },
    len2,
  };
}

/**
 * The included angle at the corner, or null when there is nothing to work on —
 * the legs are collinear (a straight run) or folded back on themselves, and
 * neither a fillet nor a chamfer is defined there.
 */
export function cornerAngle(dirs: CornerDirs): number | null {
  const cosA = dirs.d1.x * dirs.d2.x + dirs.d1.y * dirs.d2.y;
  const angle = Math.acos(Math.max(-1, Math.min(1, cosA)));
  if (angle < 1e-4 || Math.abs(angle - Math.PI) < 1e-4) return null;
  return angle;
}

// ---------------------------------------------------------------------------
// Surgery
// ---------------------------------------------------------------------------

/** Pull both legs back to their tangent points, so the new entity has room. */
export function trimCornerLegs(corner: LineCorner, T1: Vec2, T2: Vec2): void {
  const { line1, key1, line2, key2 } = corner;
  if (key1 === "a") line1.a = T1;
  else line1.b = T1;
  if (key2 === "a") line2.a = T2;
  else line2.b = T2;
}

/**
 * Drop the coincidence that held the two legs together. They no longer meet, so
 * leaving it would fight the solver.
 */
export function dropCornerJoin(doc: CADDocument, corner: LineCorner): void {
  const { line1, key1, line2, key2 } = corner;
  doc.constraints = doc.constraints.filter((c) => {
    if (c.type !== "coincident" || c.points.length !== 2) return true;
    const has1 = c.points.some((p) => p.entityId === line1.id && p.key === key1);
    const has2 = c.points.some((p) => p.entityId === line2.id && p.key === key2);
    return !(has1 && has2);
  });
}

/**
 * Constrain the inserted entity's two ends to the legs it bridges, so the
 * rounded/bevelled corner survives the next solve as one connected chain.
 */
export function joinCornerEnds(
  doc: CADDocument,
  corner: LineCorner,
  newEntityId: string,
  startKey: string,
  endKey: string,
  idPrefix: string,
): void {
  const link = (n: 1 | 2, lineId: string, lineKey: string, newKey: string): void => {
    doc.addConstraint({
      id: `${idPrefix}-c${n}-${newEntityId}`,
      type: "coincident",
      points: [
        { entityId: lineId, key: lineKey },
        { entityId: newEntityId, key: newKey },
      ],
      entities: [],
      params: [],
    });
  };
  link(1, corner.line1.id, corner.key1, startKey);
  link(2, corner.line2.id, corner.key2, endKey);
}

/**
 * Cut `pts` into a polyline corner, in place.
 *
 * The entity, its id and every reference to it survive untouched — a polyline's
 * vertices carry stable ids, so the constraints on the vertices either side of
 * the splice keep pointing at the same physical corners.
 *
 * Rectangles no longer come through here. They used to: a rectangle was
 * converted to a polyline and swapped into the document, which cost it its
 * editability and (before #53) its constraints. A rectangle corner is now a
 * radius on the entity — see {@link setRectCorner}.
 */
export function spliceCornerVertices(corner: PolyCorner, pts: Vec2[]): void {
  corner.entity.spliceVertices(corner.index, 1, ...pts);
}
