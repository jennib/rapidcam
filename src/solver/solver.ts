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
import { CADDocument, ORIGIN_ENTITY_ID } from "../model/document";
import { Entity, ArcEntity } from "../model/entities";
import { Constraint, Geo, constraintResiduals } from "../model/constraints";
import { dimensionResiduals } from "../model/dimensions";
import { solveLinearSystem, matrixRank } from "./linalg";

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
// Drag weights. Both ≪ 1 so hard constraints/dimensions always win.
// The dragged point is SEEDED to the cursor before the solve, so free-DOF responsiveness
// comes from seeding, not from PIN_WEIGHT. PIN_WEIGHT only governs how much constrained
// directions can drift; lower = constraints win harder. ANCHOR holds non-dragged DOFs.
/** Soft weight for the dragged point — kept equal to ANCHOR so constraints dominate. */
const PIN_WEIGHT = 1e-3;
/** Weight holding non-dragged DOFs at their start position (minimal-movement). */
const ANCHOR_WEIGHT = 1e-3;

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
  // WCS origin is always fixed regardless of constraints.
  const originEnt = byId.get(ORIGIN_ENTITY_ID);
  if (originEnt) {
    for (const p of originEnt.dofPoints()) fixed.add(`${ORIGIN_ENTITY_ID}:${p.key}`);
  }

  // Drag pins are SOFT goals, not hard fixes: the dragged point is pulled toward
  // the cursor by a weak residual, so hard constraints win in a conflict while a
  // free point still lands on the cursor. The target also seeds the initial guess.
  const pinEntries: { ent: Entity; key: string; target: Vec2 }[] = [];
  if (pins) {
    for (const [key, target] of pins) {
      if (fixed.has(key)) continue;
      const i = key.indexOf(":");
      const ent = byId.get(key.slice(0, i));
      if (!ent) continue;
      const k = key.slice(i + 1);
      ent.setPoint(k, target);
      pinEntries.push({ ent, key: k, target });
    }
  }

  // Build variables from all non-fixed DOFs (pinned points stay variable).
  // Non-pinned DOFs are always anchored to their current position so the solver
  // makes the MINIMAL change in any situation (drag or dimension edit). This
  // prevents under-constrained geometry from rotating instead of stretching when
  // a driving dimension value is changed.
  const dragging = pinEntries.length > 0;
  const pinnedComponents = new Set<string>();
  const pinnedScalars = new Set<string>();
  if (pins) {
    const coincidentGroups = new Map<string, string[]>();
    for (const c of doc.constraints) {
      if (c.type !== "coincident") continue;
      if (c.points.length < 2) continue;
      const k0 = `${c.points[0].entityId}:${c.points[0].key}`;
      const k1 = `${c.points[1].entityId}:${c.points[1].key}`;
      if (!coincidentGroups.has(k0)) coincidentGroups.set(k0, []);
      if (!coincidentGroups.has(k1)) coincidentGroups.set(k1, []);
      coincidentGroups.get(k0)!.push(k1);
      coincidentGroups.get(k1)!.push(k0);
    }

    const allPinnedKeys = new Set<string>();
    const queue: string[] = [];
    for (const [key] of pins) {
      allPinnedKeys.add(key);
      queue.push(key);
    }
    while (queue.length > 0) {
      const curr = queue.shift()!;
      const neighbors = coincidentGroups.get(curr) ?? [];
      for (const n of neighbors) {
        if (!allPinnedKeys.has(n)) {
          allPinnedKeys.add(n);
          queue.push(n);
        }
      }
    }

    for (const key of allPinnedKeys) {
      const i = key.indexOf(":");
      const ent = byId.get(key.slice(0, i));
      if (!ent) continue;
      const k = key.slice(i + 1);
      for (const affected of ent.dofsAffectedBy(k)) {
        pinnedComponents.add(`${ent.id}:${affected.key}:${affected.axis}`);
      }
      for (const sk of ent.scalarsAffectedBy(k)) {
        pinnedScalars.add(scalarKey(ent.id, sk));
      }
    }
  }

  const vars: Variable[] = [];
  const anchorVars: Variable[] = [];
  for (const ent of doc.entities) {
    for (const p of ent.dofPoints()) {
      if (fixed.has(`${ent.id}:${p.key}`)) continue;
      const vx = pointComponent(ent, p.key, "x");
      const vy = pointComponent(ent, p.key, "y");
      vars.push(vx, vy);
      // Always anchor non-pinned DOFs to prefer minimal-change solutions in
      // under-constrained systems (e.g. editing a dimension without dragging).
      if (!pinnedComponents.has(`${ent.id}:${p.key}:x`)) anchorVars.push(vx);
      if (!pinnedComponents.has(`${ent.id}:${p.key}:y`)) anchorVars.push(vy);
    }
    for (const s of ent.dofScalars()) {
      if (fixed.has(scalarKey(ent.id, s.key))) continue;
      const vs = scalarComponent(ent, s.key);
      vars.push(vs);
      if (!pinnedScalars.has(scalarKey(ent.id, s.key))) anchorVars.push(vs);
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
  // Anchors are always active (not just during drag) so editing a dimension value
  // in an under-constrained sketch prefers minimal movement over an arbitrary
  // null-space solution (e.g. rotation instead of stretching).
  // PIN_WEIGHT = ANCHOR_WEIGHT ≪ 1 so hard constraints always win.
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

  // Post-solve: clamp pointOnArc constrained points to the arc's angular sweep.
  // The residual only enforces the radial distance; this enforces the angular bounds.
  for (const c of doc.constraints) {
    if (c.type !== "pointOnArc") continue;
    const arcEnt = byId.get(c.entities[0]);
    if (!(arcEnt instanceof ArcEntity)) continue;
    const pointEnt = byId.get(c.points[0].entityId);
    if (!pointEnt || fixed.has(`${c.points[0].entityId}:${c.points[0].key}`)) continue;
    const p = pointEnt.getPoint(c.points[0].key);
    const angle = Math.atan2(p.y - arcEnt.center.y, p.x - arcEnt.center.x);
    const clamped = clampAngleToArc(angle, arcEnt.startAngle, arcEnt.endAngle);
    if (Math.abs(arcAngleDiff(clamped, angle)) > 1e-9) {
      pointEnt.setPoint(c.points[0].key, {
        x: arcEnt.center.x + arcEnt.radius * Math.cos(clamped),
        y: arcEnt.center.y + arcEnt.radius * Math.sin(clamped),
      });
    }
  }

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

const TAU = Math.PI * 2;
/** Signed shortest angular difference from `a` to `b`, in (-π, π]. */
function arcAngleDiff(a: number, b: number): number {
  let d = ((b - a) % TAU + TAU) % TAU;
  if (d > Math.PI) d -= TAU;
  return d;
}
/** True if `a` lies on the CCW arc from `s` to `e`. */
function angleInArc(a: number, s: number, e: number): boolean {
  const n = (x: number) => ((x % TAU) + TAU) % TAU;
  const a2 = n(a), s2 = n(s), e2 = n(e);
  return s2 <= e2 ? (a2 >= s2 && a2 <= e2) : (a2 >= s2 || a2 <= e2);
}
/** Clamp `angle` to the CCW arc range [startAngle, endAngle]. */
function clampAngleToArc(angle: number, startAngle: number, endAngle: number): number {
  if (angleInArc(angle, startAngle, endAngle)) return angle;
  const dStart = Math.abs(arcAngleDiff(angle, startAngle));
  const dEnd   = Math.abs(arcAngleDiff(angle, endAngle));
  return dStart <= dEnd ? startAngle : endAngle;
}

// ---------------------------------------------------------------------------
// Rank-based redundancy / over-constraint check (used by the constraint bar)

/**
 * Compute the rank of the constraint Jacobian for doc's current constraints +
 * driving dimensions, optionally including extra proposed constraints.
 * Returns { variables, rankWithout, rankWith } so the caller can determine
 * whether the extras genuinely add information.
 */
export function constraintJacobianRankChange(
  doc: CADDocument,
  extras: Constraint[] = [],
): { variables: number; rankWithout: number; rankWith: number } {
  const byId = new Map<string, Entity>(doc.entities.map((e) => [e.id, e]));
  const geo: Geo = (id) => byId.get(id);

  // Build fixed set (same logic as solve())
  const fixed = new Set<string>();
  for (const c of doc.constraints) {
    if (c.type !== "fixed") continue;
    for (const id of c.entities) {
      const ent = byId.get(id);
      if (!ent) continue;
      for (const p of ent.dofPoints()) fixed.add(`${id}:${p.key}`);
      for (const s of ent.dofScalars()) fixed.add(scalarKey(id, s.key));
    }
  }
  const originEnt = byId.get(ORIGIN_ENTITY_ID);
  if (originEnt) {
    for (const p of originEnt.dofPoints()) fixed.add(`${ORIGIN_ENTITY_ID}:${p.key}`);
  }

  // Build variable list
  const vars: Variable[] = [];
  for (const ent of doc.entities) {
    for (const p of ent.dofPoints()) {
      if (fixed.has(`${ent.id}:${p.key}`)) continue;
      vars.push(pointComponent(ent, p.key, "x"));
      vars.push(pointComponent(ent, p.key, "y"));
    }
    for (const s of ent.dofScalars()) {
      if (fixed.has(scalarKey(ent.id, s.key))) continue;
      vars.push(scalarComponent(ent, s.key));
    }
  }
  const n = vars.length;
  if (n === 0) return { variables: 0, rankWithout: 0, rankWith: 0 };

  const active = doc.constraints.filter((c) => c.type !== "fixed");
  const drivingDims = doc.dimensions.filter((d) => d.driving);
  const extraActive = extras.filter((c) => c.type !== "fixed");

  const buildEvalR = (includeExtras: boolean) => (x: number[]): number[] => {
    vars.forEach((v, i) => v.set(x[i]));
    const out: number[] = [];
    for (const c of active) for (const v of constraintResiduals(c, geo)) out.push(v);
    for (const d of drivingDims) for (const v of dimensionResiduals(d, geo)) out.push(v);
    if (includeExtras) for (const c of extraActive) for (const v of constraintResiduals(c, geo)) out.push(v);
    return out;
  };

  const x = vars.map((v) => v.get());

  const evalWithout = buildEvalR(false);
  const fxWithout = evalWithout(x);
  const Jwithout = fxWithout.length > 0 ? jacobian(evalWithout, x, fxWithout) : [];
  evalWithout(x); // restore

  const evalWith = buildEvalR(true);
  const fxWith = evalWith(x);
  const Jwith = fxWith.length > 0 ? jacobian(evalWith, x, fxWith) : [];
  evalWith(x); // restore

  return {
    variables: n,
    rankWithout: matrixRank(Jwithout),
    rankWith: matrixRank(Jwith),
  };
}
