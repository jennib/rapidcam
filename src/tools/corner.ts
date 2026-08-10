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
import { LineEntity, PolylineEntity, RectEntity } from "../model/entities";

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
 * Replace a polyline or rectangle corner with `pts`, in place.
 *
 * A rectangle cannot hold a rounded or bevelled corner, so it is converted to
 * an equivalent closed polyline and swapped into the document; a polyline is
 * edited where it stands, which keeps it a single offsettable entity.
 */
export function spliceCornerVertices(
  corner: PolyCorner | RectCorner,
  doc: CADDocument,
  pts: Vec2[],
): void {
  let pl: PolylineEntity;
  if (corner.kind === "poly") {
    pl = corner.entity;
  } else {
    pl = new PolylineEntity(
      corner.entity.corners().map((p) => ({ ...p })),
      true,
    );
    pl.layerId = corner.entity.layerId;
    pl.selected = corner.entity.selected;
  }
  pl.spliceVertices(corner.index, 1, ...pts);
  if (corner.kind === "rect") {
    doc.remove(corner.entity);
    doc.add(pl);
  }
}
