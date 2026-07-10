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
  /**
   * Multiplier converting the formula's value (in the field's display unit) to
   * the scalar's internal unit. Omitted/1 for lengths (mm); π/180 for an angle
   * scalar entered in degrees. Keeps the formula in the unit the user typed.
   */
  scale?: number;
}

/** The binding's target in the scalar's internal unit, or null if unresolvable. */
export function bindingTarget(b: ScalarBinding, vars: VarMap): number | null {
  const t = evalExpr(b.expr, vars);
  if (t === null || !Number.isFinite(t)) return null;
  return t * (b.scale ?? 1);
}

/** Driving residual from a precomputed target: `[current − target]`, or `[]`. The
 *  target is constant during a solve, so the solver hoists it out of the FD loop. */
export function bindingResidualAt(b: ScalarBinding, geo: Geo, target: number | null): number[] {
  if (target === null) return [];
  const cur = geo(b.entityId)
    ?.dofScalars()
    .find((s) => s.key === b.scalarKey)?.value;
  return cur === undefined ? [] : [cur - target];
}

/** Convenience: residual computing its own target (one-off / tests). */
export function bindingResiduals(b: ScalarBinding, geo: Geo, vars: VarMap): number[] {
  return bindingResidualAt(b, geo, bindingTarget(b, vars));
}

/** The binding driving `(entityId, scalarKey)`, if any. */
export function findBinding(
  bindings: ScalarBinding[],
  entityId: EntityId,
  scalarKey: string,
): ScalarBinding | undefined {
  return bindings.find((b) => b.entityId === entityId && b.scalarKey === scalarKey);
}
