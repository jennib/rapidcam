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
 */

import { type Constraint, makeConstraint } from "../model/constraints";
import type { CADDocument } from "../model/document";
import type { Entity } from "../model/entities";

export type CenterAxis = "h" | "v" | "both";

export type CenterPlan = { ok: true; constraints: Constraint[] } | { ok: false; reason: string };

/** The key of an entity's centre point (rect/text/image → "center", circle/arc →
 *  "c"), or null when it has none. Uses pickablePoints, whose entries always carry
 *  a key (a rectangle's centre SNAP point, by contrast, has no key). */
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

/** Selected entities that expose a centre point, each paired with its key. */
function centreCandidates(doc: CADDocument): { ent: Entity; key: string }[] {
  const out: { ent: Entity; key: string }[] = [];
  for (const ent of doc.selected) {
    const key = centerKeyOf(ent);
    if (key) out.push({ ent, key });
  }
  return out;
}

/** True when the current selection can be centred (≥1 mover + 1 reference). */
export function canCenter(doc: CADDocument): boolean {
  return centreCandidates(doc).length >= 2;
}

/**
 * Plan the constraints to centre the selected mover(s) inside the reference.
 * Reference = the largest-area candidate (the container); movers = the rest.
 * Pure — the caller applies with history/solve/rollback.
 */
export function planCenter(doc: CADDocument, axis: CenterAxis): CenterPlan {
  const candidates = centreCandidates(doc);
  if (candidates.length < 2)
    return { ok: false, reason: "Select the item(s) to centre plus the shape to centre them in" };

  // Largest-area candidate is the container/reference; the others are the movers.
  let ref = candidates[0];
  for (const c of candidates) if (boundsArea(c.ent) > boundsArea(ref.ent)) ref = c;
  const movers = candidates.filter((c) => c.ent !== ref.ent);
  if (movers.length === 0)
    return { ok: false, reason: "Select the item(s) to centre plus the shape to centre them in" };

  const refPoint = { entityId: ref.ent.id, key: ref.key };
  // axis param: 0 = X-only (centre horizontally), 1 = Y-only (centre vertically),
  // absent = both axes.
  const params = axis === "h" ? [0] : axis === "v" ? [1] : undefined;
  const constraints = movers.map((m) =>
    makeConstraint("center", {
      points: [{ entityId: m.ent.id, key: m.key }, refPoint],
      params,
    }),
  );
  return { ok: true, constraints };
}
