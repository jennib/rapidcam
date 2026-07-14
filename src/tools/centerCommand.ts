/**
 * "Center in…" command. Centres the selected item(s) inside a reference shape
 * (e.g. text inside a rectangle) with a single click — no construction line, no
 * manual Point-on-line.
 *
 * How it works: it adds a directional `center` constraint from the mover's
 * centre to the reference's centre on the chosen axis. That constraint is FULLY
 * LIVE but ONE-WAY — the solver follows the reference via a per-solve snapshot
 * (see solve()), so moving/resizing the reference re-centres the mover, editing
 * the mover (e.g. re-typing text) keeps it centred, and the mover can never drag
 * the reference. (A naive symmetric constraint between the two live centres does
 * drag the reference — measured: a rectangle jumped ~30mm — which is why the
 * `center` constraint is directional.)
 *
 * The reference can be a shape with a real centre point (a circle, image, or
 * RectEntity) OR a container built from lines/polylines — e.g. the Rectangle tool
 * emits FOUR lines, not one rect. For a line container we pin the mover to the
 * midpoint of the container's two diagonal corners, which live-tracks its centre.
 */

import type { Vec2 } from "../core/vec2";
import { type Constraint, makeConstraint, type PointRef, samePointRef } from "../model/constraints";
import type { CADDocument } from "../model/document";
import type { Entity } from "../model/entities";

export type CenterAxis = "h" | "v" | "both";

export type CenterPlan = { ok: true; constraints: Constraint[] } | { ok: false; reason: string };

const NEED_SELECTION = "Select the item(s) to centre plus the shape to centre them in";

/** The key of an entity's centre point (rect/text/image → "center", circle/arc →
 *  "c"), or null when it has none (lines, polylines). Uses pickablePoints, whose
 *  entries always carry a key. */
export function centerKeyOf(ent: Entity): string | null {
  const keys = new Set(ent.pickablePoints().map((p) => p.key));
  if (keys.has("center")) return "center"; // rect / text / image
  if (keys.has("c")) return "c"; // circle / arc centre
  return null;
}

/** Bounding-box area — used to pick the container (largest) as the reference. */
function boundsArea(ent: Entity): number {
  const b = ent.bounds();
  return Math.max(0, b.max.x - b.min.x) * Math.max(0, b.max.y - b.min.y);
}

/**
 * The point ref(s) whose centre/midpoint is the reference's live centre:
 *  - a single shape with a centre point → that point;
 *  - a container of lines/polylines → its two DIAGONAL corners (bbox extremes),
 *    whose midpoint tracks the container centre (exact for axis-aligned rects).
 * Returns null when no usable reference geometry is present.
 */
function referencePoints(refEnts: Entity[]): PointRef[] | null {
  if (refEnts.length === 1) {
    const key = centerKeyOf(refEnts[0]);
    if (key) return [{ entityId: refEnts[0].id, key }];
  }
  const pts: { ref: PointRef; pos: Vec2 }[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of refEnts) {
    for (const p of e.pickablePoints()) {
      pts.push({ ref: { entityId: e.id, key: p.key }, pos: p.pos });
      minX = Math.min(minX, p.pos.x);
      minY = Math.min(minY, p.pos.y);
      maxX = Math.max(maxX, p.pos.x);
      maxY = Math.max(maxY, p.pos.y);
    }
  }
  if (pts.length < 2) return null;
  const nearest = (tx: number, ty: number) => {
    let best = pts[0];
    let bestD = Infinity;
    for (const p of pts) {
      const d = (p.pos.x - tx) ** 2 + (p.pos.y - ty) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best.ref;
  };
  const lo = nearest(minX, minY);
  const hi = nearest(maxX, maxY);
  return samePointRef(lo, hi) ? null : [lo, hi];
}

/** Split the selection into the mover(s) and the reference container. Movers are
 *  the shapes with a centre point; if any line/polyline is selected it forms the
 *  container, otherwise the largest centre-shape is the container. */
function partition(doc: CADDocument): {
  movers: { ent: Entity; key: string }[];
  refEnts: Entity[];
} {
  const sel = doc.selected;
  const withCentre = sel.filter((e) => centerKeyOf(e));
  const withoutCentre = sel.filter((e) => !centerKeyOf(e));

  if (withoutCentre.length > 0) {
    // Lines/polylines present → they form the container; centre-shapes move.
    return {
      movers: withCentre.map((e) => ({ ent: e, key: centerKeyOf(e)! })),
      refEnts: withoutCentre,
    };
  }
  if (withCentre.length < 2) return { movers: [], refEnts: [] };
  // All selected shapes have a centre → the largest is the container.
  let ref = withCentre[0];
  for (const e of withCentre) if (boundsArea(e) > boundsArea(ref)) ref = e;
  return {
    movers: withCentre.filter((e) => e !== ref).map((e) => ({ ent: e, key: centerKeyOf(e)! })),
    refEnts: [ref],
  };
}

/** True when the current selection can be centred (≥1 mover + a reference). */
export function canCenter(doc: CADDocument): boolean {
  if (doc.selected.length < 2) return false;
  const { movers, refEnts } = partition(doc);
  return movers.length > 0 && referencePoints(refEnts) !== null;
}

/** Plan the constraints to centre the selected mover(s) inside the reference.
 *  Pure — the caller applies with history/solve/rollback. */
export function planCenter(doc: CADDocument, axis: CenterAxis): CenterPlan {
  if (doc.selected.length < 2) return { ok: false, reason: NEED_SELECTION };
  const { movers, refEnts } = partition(doc);
  if (movers.length === 0) return { ok: false, reason: NEED_SELECTION };
  const refPoints = referencePoints(refEnts);
  if (!refPoints) return { ok: false, reason: NEED_SELECTION };

  // axis param: 0 = X-only (centre horizontally), 1 = Y-only (centre vertically),
  // absent = both axes.
  const params = axis === "h" ? [0] : axis === "v" ? [1] : undefined;
  const constraints = movers.map((m) =>
    makeConstraint("center", {
      points: [{ entityId: m.ent.id, key: m.key }, ...refPoints],
      params,
    }),
  );
  return { ok: true, constraints };
}
