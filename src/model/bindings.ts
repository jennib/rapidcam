/**
 * Headless parametric bindings.
 *
 * A ScalarBinding drives one *scalar* DOF of an entity (identified by its
 * `dofScalars()` key — e.g. "r" for a circle radius) from a variable formula.
 * Unlike a {@link Dimension} it draws nothing on the canvas: it only contributes
 * a driving residual `(currentScalar − evalExpr(expr))` to the solver. So the
 * property field follows the formula, and any conflict with a geometric
 * constraint is reconciled by the SAME over/under-constrained machinery — one
 * parametric channel, no "two masters".
 *
 * This is the general mechanism for scalar-DOF properties (circle/arc radius, arc
 * angles). Measurement properties without a scalar DOF (line length, rect W/H)
 * will instead reuse hidden driving dimensions — see the parametric plan.
 */

import type { EntityId } from "./entities";
import type { Geo } from "./constraints";
import { evalExpr, type VarMap } from "../core/expr";

export interface ScalarBinding {
  id: string;
  /** Entity whose scalar this drives. */
  entityId: EntityId;
  /** A `dofScalars()` key on that entity (e.g. "r"). */
  scalarKey: string;
  /** Variable formula, e.g. "plateW/2". */
  expr: string;
}

/** Driving residual for a binding: `[current − target]`, or `[]` when unresolved. */
export function bindingResiduals(b: ScalarBinding, geo: Geo, vars: VarMap): number[] {
  const ent = geo(b.entityId);
  if (!ent) return [];
  const cur = ent.dofScalars().find((s) => s.key === b.scalarKey)?.value;
  if (cur === undefined) return [];
  const target = evalExpr(b.expr, vars);
  if (target === null || !isFinite(target)) return [];
  return [cur - target];
}

/** The binding driving `(entityId, scalarKey)`, if any. */
export function findBinding(
  bindings: ScalarBinding[], entityId: EntityId, scalarKey: string,
): ScalarBinding | undefined {
  return bindings.find((b) => b.entityId === entityId && b.scalarKey === scalarKey);
}
