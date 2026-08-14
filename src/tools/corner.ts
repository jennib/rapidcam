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
import { SEGMENT_SEP } from "../model/constraints";
import type { CADDocument } from "../model/document";
import { LineEntity, PolylineEntity, RectEntity } from "../model/entities";

/**
 * Say when a corner operation had to abandon a reference.
 *
 * Rounding a corner away legitimately destroys anything constrained to it —
 * one corner becomes several vertices, so there is no single successor. What
 * was wrong was doing it in silence: a rectangle pinned to the blank lost its
 * pin and looked, from the outside, like "fillet is broken on the stock edge".
 *
 * Takes the `number | null` the apply functions return so both tools report the
 * same way and neither has to remember to.
 */
export function reportDropped(
  dropped: number | null,
  ctx: { notify(msg: string): void },
): void {
  if (!dropped) return;
  ctx.notify(
    dropped === 1
      ? "1 constraint was removed — the corner it held has been rounded away."
      : `${dropped} constraints were removed — the corner they held has been rounded away.`,
  );
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
 * Replace a polyline or rectangle corner with `pts`, in place.
 *
 * A rectangle cannot hold a rounded or bevelled corner, so it is converted to
 * an equivalent closed polyline and swapped into the document; a polyline is
 * edited where it stands, which keeps it a single offsettable entity.
 */
/**
 * Where each of a rect's named points ends up on the polyline that replaces it.
 *
 * The replacement is built from `corners()`, which returns
 * `[bl, br, tr, tl]` — so corner *i* becomes vertex *i*, and the edge leaving
 * corner *i* becomes the segment whose START vertex is *i* (which is how a
 * polyline segment is named; see `pickablePoints`).
 *
 * MUST be called before splicing: splicing renumbers everything after the
 * corner being cut.
 *
 * `center` has no polyline equivalent and is deliberately absent.
 */
function rectKeyMap(pl: PolylineEntity): Map<string, string> {
  const [v0, v1, v2, v3] = pl.vertexIds;
  return new Map([
    ["bl", `v${v0}`],
    ["br", `v${v1}`],
    ["tr", `v${v2}`],
    ["tl", `v${v3}`],
    ["mid_b", `mid_${v0}`],
    ["mid_r", `mid_${v1}`],
    ["mid_t", `mid_${v2}`],
    ["mid_l", `mid_${v3}`],
  ]);
}

/**
 * Swap `rect` for `pl` IN PLACE, keeping the id, and carry every reference over.
 *
 * The old code did `doc.remove(rect)` then `doc.add(pl)`. `remove` calls
 * `pruneReferences`, so every constraint naming the rect was silently deleted:
 * fillet one corner of a rectangle pinned to the stock edge and the pin was
 * simply gone, with nothing said. That was the reported "fillet fails when a
 * corner coincides with the stock boundary".
 *
 * Keeping the id is necessary but NOT sufficient — a constraint would then name
 * a live entity with a key it no longer has, since `"bl"` means nothing on a
 * polyline. So the point keys are remapped too.
 *
 * Returns how many references could not be carried, for the caller to report.
 * Two cases genuinely cannot: the corner being filleted (it becomes several
 * vertices, so there is no single successor) and `center` (polylines have none).
 * Dropping those is right; dropping them SILENTLY was the bug.
 */
function replaceRectInPlace(
  doc: CADDocument,
  rect: RectEntity,
  pl: PolylineEntity,
  keyMap: Map<string, string>,
): number {
  const id = rect.id;
  // The one sanctioned id reuse outside replaceInstanceEntity: references are
  // keyed by id, and this IS the same shape to the user — they filleted a
  // corner, they did not replace their rectangle.
  (pl as { id: string }).id = id;
  const idx = doc.entities.findIndex((e) => e.id === id);
  if (idx === -1) return 0;
  doc.entities[idx] = pl;

  let dropped = 0;
  doc.constraints = doc.constraints.filter((c) => {
    let ok = true;
    for (const p of c.points) {
      if (p.entityId !== id) continue;
      const next = keyMap.get(p.key);
      if (next === undefined) ok = false;
      else p.key = next;
    }
    // Segment references are `<id>#<edgeKey>`; the edge keys remap the same way.
    c.entities = c.entities.map((ref) => {
      if (!ref.startsWith(`${id}${SEGMENT_SEP}`)) return ref;
      const edge = ref.slice(id.length + SEGMENT_SEP.length);
      const next = keyMap.get(edge);
      if (next === undefined) {
        ok = false;
        return ref;
      }
      return `${id}${SEGMENT_SEP}${next.replace(/^mid_/, "")}`;
    });
    if (!ok) dropped++;
    return ok;
  });
  return dropped;
}

/**
 * Cut `pts` into the corner. Returns how many references had to be dropped —
 * see {@link replaceRectInPlace}; the caller tells the user.
 */
export function spliceCornerVertices(
  corner: PolyCorner | RectCorner,
  doc: CADDocument,
  pts: Vec2[],
): number {
  if (corner.kind === "poly") {
    // Spliced in place: the entity, its id and every reference to it survive
    // untouched. Only the rect path has ever needed rescuing.
    corner.entity.spliceVertices(corner.index, 1, ...pts);
    return 0;
  }
  const pl = new PolylineEntity(
    corner.entity.corners().map((p) => ({ ...p })),
    true,
  );
  pl.layerId = corner.entity.layerId;
  pl.selected = corner.entity.selected;
  // Before the splice renumbers anything.
  const keyMap = rectKeyMap(pl);
  // The corner being cut becomes several vertices, so it has no single
  // successor — drop its entries from the map rather than aiming them at a
  // vertex that is only approximately where the old corner was.
  for (const [k, v] of [...keyMap]) {
    if (v === `v${pl.vertexIds[corner.index]}`) keyMap.delete(k);
  }
  pl.spliceVertices(corner.index, 1, ...pts);
  return replaceRectInPlace(doc, corner.entity, pl, keyMap);
}
