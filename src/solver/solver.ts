/**
 * Geometric constraint solver (Levenberg-Marquardt).
 *
 * Strategy (the SolveSpace/FreeCAD approach):
 *   1. Collect every free scalar DOF from the entities into a variable vector x.
 *   2. Build a residual vector r(x) by writing x back into the entities and
 *      evaluating every constraint equation.
 *   3. Minimise |r(x)|² with damped least squares, using a finite-difference
 *      Jacobian. Damping (λ) keeps the step stable even when the system is
 *      under- or over-determined.
 *
 * `fixed` constraints and drag "pins" remove DOFs from x (the geometry is held),
 * so the rest of the sketch reflows around them.
 */

import { Vec2 } from "../core/vec2";
import { CADDocument } from "../model/document";
import { Entity } from "../model/entities";
import { Geo, constraintResiduals } from "../model/constraints";
import { dimensionResiduals } from "../model/dimensions";
import { solveLinearSystem } from "./linalg";

export interface SolveResult {
  hasConstraints: boolean;
  converged: boolean;
  residualNorm: number;
  /** Remaining degrees of freedom (variables − equations), floored at 0. */
  dof: number;
  variables: number;
  equations: number;
}

/** Maps a point DOF to one solver variable component. */
interface Variable {
  get(): number;
  set(v: number): void;
}

const MAX_ITER = 80;
const LAMBDA_TRIES = 12;
const RESIDUAL_TOL = 1e-6; // mm
const COST_TOL = RESIDUAL_TOL * RESIDUAL_TOL;
// Drag weights. Both ≪ 1 so hard constraints/dimensions always win; ANCHOR ≫ PIN so
// non-dragged DOFs prefer to stay rather than help the dragged point reach the cursor.
// The pin is a linear goal the solver still hits exactly when unconstrained, so a small
// weight costs no precision but minimises how much the drag "leaks" into anchored geometry.
/** Weak weight pulling the dragged point toward the cursor (still hit exactly when free). */
const PIN_WEIGHT = 1e-3;
/** Stronger weight holding non-dragged DOFs at their start position (minimal-movement). */
const ANCHOR_WEIGHT = 1e-1;

/** Pins: point-ref-key (`${entityId}:${pointKey}`) → world target. */
export type PinMap = Map<string, Vec2>;

export function solve(doc: CADDocument, pins?: PinMap): SolveResult {
  const byId = new Map<string, Entity>(doc.entities.map((e) => [e.id, e]));
  const geo: Geo = (id) => byId.get(id);

  const fixed = new Set<string>();

  // `fixed` constraints lock all DOFs of their entities (removed from variables).
  for (const c of doc.constraints) {
    if (c.type !== "fixed") continue;
    for (const id of c.entities) {
      const ent = byId.get(id);
      if (!ent) continue;
      for (const p of ent.dofPoints()) fixed.add(`${id}:${p.key}`);
      for (const s of ent.dofScalars()) fixed.add(scalarKey(id, s.key));
    }
  }

  // Drag pins are SOFT goals, not hard fixes: the dragged point is pulled toward
  // the cursor by a weak residual, so hard constraints win in a conflict while a
  // free point still lands on the cursor. The target also seeds the initial guess.
  const pinEntries: { ent: Entity; key: string; target: Vec2 }[] = [];
  if (pins) {
    for (const [key, target] of pins) {
      const i = key.indexOf(":");
      const ent = byId.get(key.slice(0, i));
      if (!ent) continue;
      const k = key.slice(i + 1);
      ent.setPoint(k, target);
      pinEntries.push({ ent, key: k, target });
    }
  }

  // Build variables from all non-fixed DOFs (pinned points stay variable).
  // During a drag, every NON-dragged DOF is anchored to its current position so
  // the solver makes the MINIMAL change: geometry that a hard constraint doesn't
  // force to move stays put instead of sliding to absorb the dragged point. (This
  // is why dragging one end of a length-dimensioned line leaves the other end fixed.)
  const dragging = pinEntries.length > 0;
  const pinnedKeys = new Set(pinEntries.map((p) => `${p.ent.id}:${p.key}`));

  const vars: Variable[] = [];
  const anchorVars: Variable[] = [];
  for (const ent of doc.entities) {
    for (const p of ent.dofPoints()) {
      if (fixed.has(`${ent.id}:${p.key}`)) continue;
      const vx = pointComponent(ent, p.key, "x");
      const vy = pointComponent(ent, p.key, "y");
      vars.push(vx, vy);
      if (dragging && !pinnedKeys.has(`${ent.id}:${p.key}`)) anchorVars.push(vx, vy);
    }
    for (const s of ent.dofScalars()) {
      if (fixed.has(scalarKey(ent.id, s.key))) continue;
      const vs = scalarComponent(ent, s.key);
      vars.push(vs);
      if (dragging) anchorVars.push(vs);
    }
  }
  const anchorStart = anchorVars.map((v) => v.get());

  const active = doc.constraints.filter((c) => c.type !== "fixed");
  const drivingDims = doc.dimensions.filter((d) => d.driving);
  const hasConstraints = doc.constraints.length > 0 || drivingDims.length > 0;

  // Constraint + driving-dimension residuals define convergence and the reported DOF.
  const constraintVec = (): number[] => {
    const out: number[] = [];
    for (const c of active) {
      const r = constraintResiduals(c, geo);
      for (const v of r) out.push(v);
    }
    for (const d of drivingDims) {
      const r = dimensionResiduals(d, geo);
      for (const v of r) out.push(v);
    }
    return out;
  };
  // Full residual the optimiser minimises: constraints + soft pin goals + anchors.
  // ANCHOR_WEIGHT > PIN_WEIGHT, so an un-forced point prefers to stay (anchor) over
  // helping the dragged point reach the cursor (pin); both are ≪ 1 so hard
  // constraints always win.
  const residuals = (): number[] => {
    const out = constraintVec();
    for (const p of pinEntries) {
      const pos = p.ent.getPoint(p.key);
      out.push(PIN_WEIGHT * (pos.x - p.target.x));
      out.push(PIN_WEIGHT * (pos.y - p.target.y));
    }
    for (let j = 0; j < anchorVars.length; j++) {
      out.push(ANCHOR_WEIGHT * (anchorVars[j].get() - anchorStart[j]));
    }
    return out;
  };

  const equations = constraintVec().length;
  const n = vars.length;
  const dof = Math.max(0, n - equations);

  const finish = (): SolveResult => {
    const crn = norm(constraintVec());
    return { hasConstraints, converged: crn < 1e-4, residualNorm: crn, dof, variables: n, equations };
  };

  if (n === 0 || residuals().length === 0) return finish();

  // --- Levenberg-Marquardt -------------------------------------------------
  const setX = (x: number[]) => vars.forEach((v, i) => v.set(x[i]));
  const evalR = (x: number[]): number[] => {
    setX(x);
    return residuals();
  };

  let x = vars.map((v) => v.get());
  let fx = evalR(x);
  let cost = sumSq(fx);
  let lambda = 1e-3;

  for (let iter = 0; iter < MAX_ITER && cost > COST_TOL; iter++) {
    const J = jacobian(evalR, x, fx);
    const m = fx.length;

    // Normal equations: A = JᵀJ (n×n), g = Jᵀfx (n).
    const A: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    const g = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < m; k++) g[i] += J[k][i] * fx[k];
      for (let j = 0; j < n; j++) {
        let s = 0;
        for (let k = 0; k < m; k++) s += J[k][i] * J[k][j];
        A[i][j] = s;
      }
    }

    let improved = false;
    for (let t = 0; t < LAMBDA_TRIES; t++) {
      const damped = A.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-9 : v)));
      const dx = solveLinearSystem(damped, g.map((v) => -v));
      if (!dx) {
        lambda *= 10;
        continue;
      }
      const xn = x.map((v, i) => v + dx[i]);
      const fxn = evalR(xn);
      const cn = sumSq(fxn);
      if (cn < cost) {
        x = xn;
        fx = fxn;
        cost = cn;
        lambda = Math.max(lambda * 0.3, 1e-12);
        improved = true;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break; // stuck — likely over-constrained / conflicting
  }

  setX(x); // make sure the solution is the final state
  return finish();
}

// --- finite-difference Jacobian (m×n) --------------------------------------
function jacobian(evalR: (x: number[]) => number[], x: number[], fx: number[]): number[][] {
  const n = x.length;
  const m = fx.length;
  const J: number[][] = Array.from({ length: m }, () => new Array<number>(n).fill(0));
  for (let j = 0; j < n; j++) {
    const h = 1e-6 * (1 + Math.abs(x[j]));
    const xp = x.slice();
    xp[j] += h;
    const fp = evalR(xp);
    for (let k = 0; k < m; k++) J[k][j] = (fp[k] - fx[k]) / h;
  }
  evalR(x); // restore entity state to base x
  return J;
}

// --- variable adapters ------------------------------------------------------
function pointComponent(ent: Entity, key: string, axis: "x" | "y"): Variable {
  return {
    get: () => ent.getPoint(key)[axis],
    set: (val) => {
      const p = ent.getPoint(key);
      ent.setPoint(key, axis === "x" ? { x: val, y: p.y } : { x: p.x, y: val });
    },
  };
}
function scalarComponent(ent: Entity, key: string): Variable {
  return {
    get: () => ent.dofScalars().find((s) => s.key === key)?.value ?? 0,
    set: (val) => ent.setScalar(key, val),
  };
}

const scalarKey = (id: string, key: string): string => `scalar:${id}:${key}`;
const sumSq = (v: number[]): number => v.reduce((s, x) => s + x * x, 0);
const norm = (v: number[]): number => Math.sqrt(sumSq(v));
