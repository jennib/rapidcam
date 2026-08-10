/**
 * What CAM is allowed to cut.
 *
 * Hidden geometry is excluded from output — the AutoCAD convention, where a
 * layer that is off does not plot, and the one most CAD/CAM users expect: if it
 * is not on screen, it does not end up in the program. Both kinds of hidden
 * count, the layer's and the entity's own (see the design tree).
 *
 * The obvious hazard is a silently shortened program, so this is deliberately
 * paired with the `hidden-geometry` pre-flight check in lint.ts: anything
 * dropped here is named before the file reaches the machine. Do not use one
 * without the other.
 *
 * Applied at the single point where each generator builds its id → entity map,
 * rather than at the ten-odd places downstream that resolve an id. Those all
 * already handle a missing entity, so an excluded one simply never arrives.
 */

import type { CADDocument } from "../model/document";
import type { Entity, EntityId } from "../model/entities";

/** True when `e` should reach the toolpath: not construction, and not hidden. */
export function isMachinable(doc: CADDocument, e: Entity): boolean {
  if (e.isConstruction || !e.visible) return false;
  const layer = doc.layerFor(e);
  return layer?.visible !== false;
}

/**
 * The id → entity map the G-code and stock-preview generators resolve against,
 * carrying only what may be cut.
 */
export function machinableEntityMap(doc: CADDocument): Map<EntityId, Entity> {
  return new Map(doc.entities.filter((e) => isMachinable(doc, e)).map((e) => [e.id, e]));
}

/**
 * Ids an operation references that CAM will not cut because they are hidden,
 * ignoring construction geometry (excluding that is long-standing and expected,
 * so warning about it would be noise).
 */
export function hiddenOpEntityIds(doc: CADDocument, entityIds: readonly EntityId[]): EntityId[] {
  const byId = new Map(doc.entities.map((e) => [e.id, e]));
  return entityIds.filter((id) => {
    const e = byId.get(id);
    return !!e && !e.isConstruction && !isMachinable(doc, e);
  });
}
