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

import type { Vec2 } from "../core/vec2";
import { bindingResidualAt, bindingTarget } from "../model/bindings";
import { type Constraint, constraintResiduals, type Geo } from "../model/constraints";
import { dimensionResiduals } from "../model/dimensions";
import { type CADDocument, ORIGIN_ENTITY_ID } from "../model/document";
import type { EntityId } from "../model/entities";
import { ArcEntity, type Entity, RasterImageEntity } from "../model/entities";
import { determinedVariables, matrixRank, solveLinearSystem } from "./linalg";

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
/**
 * Soft weight for the dragged point. Kept TWO orders below ANCHOR_DRAG so that
 * when the cursor is unreachable (e.g. dragging one end of a length-locked line
 * past its reach) the anchor pins the OTHER end in place and the dragged point
 * slides to the nearest reachable point — instead of both ends sharing the
 * movement (which let the "fixed" end creep). When the cursor IS reachable the
 * dragged point is unanchored and seeded onto the cursor, so it still lands
 * exactly there regardless of how small this weight is.
 */
const PIN_WEIGHT = 1e-5;
/**
 * Anchor weight for drag operations: strong enough to hold non-dragged DOFs in place.
 * For dimension edits (no drag), a much weaker anchor is used (ANCHOR_DIM) so the solver
 * can move geometry freely to satisfy constraints — a 1e-3 anchor on a 12mm displacement
 * produces a gradient 5× larger than the constraint gradient at near-convergence (crn≈1e-4),
 * causing the LM solver to get stuck before converging.
 */
const ANCHOR_DRAG = 1e-3;
// Anchor weight for dimension/constraint solves: weak enough that the constraint gradient
// always dominates (prevents !improved before crn < 1e-4 even for 50mm+ displacements),
// while still selecting the minimum-norm (minimum displacement) null-space element.
const ANCHOR_DIM = 1e-6;

/** Pins: point-ref-key (`${entityId}:${pointKey}`) → world target. */
export type PinMap = Map<string, Vec2>;

export function solve(doc: CADDocument, pins?: PinMap): SolveResult {
  const byId = new Map<string, Entity>(doc.entities.map((e) => [e.id, e]));
  const geo: Geo = (id) => byId.get(id);
  // Binding targets are constant during a solve (they depend only on variables,
  // which are fixed here) — evaluate each once, up front, out of the FD loop.
  const bindingVars = new Map(doc.variables.map((v) => [v.name, v.value]));
  const bindingTargets = doc.bindings.map((b) => bindingTarget(b, bindingVars));

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
  fixImageScalars(doc, fixed);

  // Drag pins are SOFT goals, not hard fixes: the dragged point is pulled toward
  // the cursor by a weak residual, so hard constraints win in a conflict while a
  // free point still lands on the cursor.
  //
  // The target also SEEDS the initial guess — and we flood that seed across
  // COINCIDENT links: every point coincident with a dragged point is seeded to
  // the same target. That makes a *reachable* drag converge exactly even though
  // PIN_WEIGHT is tiny (the whole coincident group starts already satisfied, so
  // the solver has no reason to move it), while still letting the weak pin lose
  // to the anchors when the cursor is *unreachable* (so non-dragged ends hold).
  const coincidentGroups = new Map<string, string[]>();
  if (pins) {
    for (const c of doc.constraints) {
      if (c.type !== "coincident" || c.points.length < 2) continue;
      const k0 = `${c.points[0].entityId}:${c.points[0].key}`;
      const k1 = `${c.points[1].entityId}:${c.points[1].key}`;
      if (!coincidentGroups.has(k0)) coincidentGroups.set(k0, []);
      if (!coincidentGroups.has(k1)) coincidentGroups.set(k1, []);
      coincidentGroups.get(k0)!.push(k1);
      coincidentGroups.get(k1)!.push(k0);
    }
  }

  // Flood each pin's target across its coincident group → key → target map.
  const pinnedKeyTarget = new Map<string, Vec2>();
  if (pins) {
    for (const [key, target] of pins) {
      if (fixed.has(key) || pinnedKeyTarget.has(key)) continue;
      pinnedKeyTarget.set(key, target);
      const queue = [key];
      while (queue.length > 0) {
        const curr = queue.shift()!;
        for (const n of coincidentGroups.get(curr) ?? []) {
          if (!pinnedKeyTarget.has(n) && !fixed.has(n)) {
            pinnedKeyTarget.set(n, target);
            queue.push(n);
          }
        }
      }
    }
  }

  // Seed every pinned/linked point to its target. The SOFT pin residual is added
  // only for the directly-dragged points; coincident partners are held together
  // by the hard coincident constraints, not by extra pins.
  const directPinKeys = new Set(pins ? [...pins.keys()].filter((k) => !fixed.has(k)) : []);
  const pinEntries: { ent: Entity; key: string; target: Vec2 }[] = [];
  for (const [key, target] of pinnedKeyTarget) {
    const i = key.indexOf(":");
    const ent = byId.get(key.slice(0, i));
    if (!ent) continue;
    const k = key.slice(i + 1);
    ent.setPoint(k, target);
    if (directPinKeys.has(key)) pinEntries.push({ ent, key: k, target });
  }

  // Build variables from all non-fixed DOFs (pinned points stay variable).
  // Non-pinned DOFs are always anchored to their current position so the solver
  // makes the MINIMAL change in any situation (drag or dimension edit). This
  // prevents under-constrained geometry from rotating instead of stretching when
  // a driving dimension value is changed. Pinned/linked points are NOT anchored.
  const pinnedComponents = new Set<string>();
  const pinnedScalars = new Set<string>();
  for (const key of pinnedKeyTarget.keys()) {
    const i = key.indexOf(":");
    const ent = byId.get(key.slice(0, i));
    if (!ent) continue;
    const k = key.slice(i + 1);
    for (const affected of ent.dofsAffectedBy(k))
      pinnedComponents.add(`${ent.id}:${affected.key}:${affected.axis}`);
    for (const sk of ent.scalarsAffectedBy(k)) pinnedScalars.add(scalarKey(ent.id, sk));
  }

  const vars: Variable[] = [];
  const anchorVars: Variable[] = [];
  // Per-variable multiplier on anchorW. Arc angle DOFs (sa, ea) are scaled by
  // radius so their anchor cost is normalised to mm of endpoint displacement —
  // without this, rotating a large-radius arc is numerically cheaper than
  // translating it, causing spurious rotation when a dimension is changed.
  const anchorScales: number[] = [];
  for (const ent of doc.entities) {
    for (const p of ent.dofPoints()) {
      if (fixed.has(`${ent.id}:${p.key}`)) continue;
      const vx = pointComponent(ent, p.key, "x");
      const vy = pointComponent(ent, p.key, "y");
      vars.push(vx, vy);
      // Always anchor non-pinned DOFs to prefer minimal-change solutions in
      // under-constrained systems (e.g. editing a dimension without dragging).
      if (!pinnedComponents.has(`${ent.id}:${p.key}:x`)) {
        anchorVars.push(vx);
        anchorScales.push(1);
      }
      if (!pinnedComponents.has(`${ent.id}:${p.key}:y`)) {
        anchorVars.push(vy);
        anchorScales.push(1);
      }
    }
    for (const s of ent.dofScalars()) {
      if (fixed.has(scalarKey(ent.id, s.key))) continue;
      const vs = scalarComponent(ent, s.key);
      vars.push(vs);
      if (!pinnedScalars.has(scalarKey(ent.id, s.key))) {
        anchorVars.push(vs);
        const scale =
          ent instanceof ArcEntity && (s.key === "sa" || s.key === "ea") ? ent.radius : 1;
        anchorScales.push(scale);
      }
    }
  }
  const anchorStart = anchorVars.map((v) => v.get());
  // Use a weaker anchor for dimension/constraint solves (no drag pins) so that the solver
  // can move geometry freely to satisfy constraints.  During drag, ANCHOR_DRAG holds
  // non-pinned DOFs firmly in place; ANCHOR_DIM is weak enough that the constraint
  // gradient always dominates even after large displacements (see constant comments above).
  const anchorW = pins ? ANCHOR_DRAG : ANCHOR_DIM;

  // "center" (directional) constraints are handled separately below via a
  // per-solve snapshot, so they're excluded from the generic residual loop.
  const active = doc.constraints.filter((c) => c.type !== "fixed" && c.type !== "center");
  const drivingDims = doc.dimensions.filter((d) => d.driving);
  const hasConstraints =
    doc.constraints.length > 0 || drivingDims.length > 0 || doc.bindings.length > 0;

  // Directional CENTRE constraints: the mover's centre follows the reference's
  // centre ONE-WAY. Snapshot the reference centre once, now (after pin seeding,
  // so a dragged reference is captured at its new spot), and treat it as a
  // CONSTANT target. Because the target is constant during the solve, the FD
  // Jacobian never couples this residual back to the reference — only the mover
  // moves, and editing the mover can't drift the reference. The snapshot
  // refreshes every solve, so moving/resizing the reference re-centres the mover.
  const centerCons = doc.constraints.filter((c) => c.type === "center");
  const readRefPoint = (ref: { entityId: string; key: string } | undefined): Vec2 | null => {
    if (!ref) return null;
    const e = byId.get(ref.entityId);
    if (!e) return null;
    try {
      return e.getPoint(ref.key);
    } catch {
      return null;
    }
  };
  const centerTargets = centerCons.map((c) => {
    const r1 = readRefPoint(c.points[1]);
    if (!r1) return null;
    // Reference centre = a single point, or the midpoint of two (line-container).
    const r2 = c.points[2] ? readRefPoint(c.points[2]) : null;
    return r2 ? { x: (r1.x + r2.x) / 2, y: (r1.y + r2.y) / 2 } : r1;
  });

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
    // Headless parametric bindings: an additive residual source (currentScalar −
    // formula), so the FD Jacobian and over/under-constrained counting cover them
    // for free — one parametric channel with dimensions/constraints.
    doc.bindings.forEach((b, i) => {
      const r = bindingResidualAt(b, geo, bindingTargets[i]);
      for (const v of r) out.push(v);
    });
    // Directional centre constraints against their per-solve snapshot target.
    centerCons.forEach((c, i) => {
      const target = centerTargets[i];
      if (!target) return;
      const mover = byId.get(c.points[0].entityId);
      if (!mover) return;
      let m: Vec2;
      try {
        m = mover.getPoint(c.points[0].key);
      } catch {
        return;
      }
      const axis = c.params?.[0];
      if (axis !== 1) out.push(m.x - target.x);
      if (axis !== 0) out.push(m.y - target.y);
    });
    return out;
  };
  // Full residual the optimiser minimises: constraints + soft pin goals + anchors.
  // Anchors are always active (not just during drag) so editing a dimension value
  // in an under-constrained sketch prefers minimal movement over an arbitrary
  // null-space solution (e.g. rotation instead of stretching).
  const residuals = (): number[] => {
    const out = constraintVec();
    for (const p of pinEntries) {
      const pos = p.ent.getPoint(p.key);
      out.push(PIN_WEIGHT * (pos.x - p.target.x));
      out.push(PIN_WEIGHT * (pos.y - p.target.y));
    }
    for (let j = 0; j < anchorVars.length; j++) {
      out.push(anchorW * anchorScales[j] * (anchorVars[j].get() - anchorStart[j]));
    }
    return out;
  };

  const equations = constraintVec().length;
  const n = vars.length;
  const dof = Math.max(0, n - equations);

  const finish = (): SolveResult => {
    const crn = norm(constraintVec());
    return {
      hasConstraints,
      converged: crn < 1e-4,
      residualNorm: crn,
      dof,
      variables: n,
      equations,
    };
  };

  if (n === 0 || residuals().length === 0) return finish();

  // --- Levenberg-Marquardt -------------------------------------------------
  const setX = (x: number[]) =>
    vars.forEach((v, i) => {
      v.set(x[i]);
    });
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
      const dx = solveLinearSystem(
        damped,
        g.map((v) => -v),
      );
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
    // For dimension/constraint solves (no drag pins), exit as soon as the hard
    // constraints converge — no need to keep grinding toward COST_TOL, which
    // may never be reached when anchorW is tiny and displacement is large.
    if (!pins && norm(fx.slice(0, equations)) < 1e-4) break;
  }

  setX(x); // make sure the solution is the final state
  normalizeImageAngles(doc);

  return finish();
}

/**
 * Wrap a solver-driven image `angle` into (−π, π]. A single LM step can overshoot
 * a rotation by whole turns and then converge inside that basin — geometrically
 * identical (every corner is read back through cos/sin, and nothing measures an
 * image's cumulative rotation) but it leaves a nonsense number like −15750° in
 * the Properties panel, and the solver can't unwind it afterwards because the
 * route back crosses the constraints.
 *
 * Only angles this solve could actually have wound are touched: the image must
 * allow constraint-driven rotation, and no formula binding may drive it — a
 * binding reads the raw value, so there 720° is a real, intended 720°.
 */
function normalizeImageAngles(doc: CADDocument): void {
  const TWO_PI = Math.PI * 2;
  for (const ent of doc.entities) {
    if (!(ent instanceof RasterImageEntity) || Math.abs(ent.angle) <= Math.PI) continue;
    if (!ent.constraintRotate) continue;
    if (doc.bindings.some((b) => b.entityId === ent.id && b.scalarKey === "angle")) continue;
    ent.angle -= TWO_PI * Math.round(ent.angle / TWO_PI);
  }
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
export function scalarComponent(ent: Entity, key: string): Variable {
  return {
    get: () => {
      const s = ent.dofScalars().find((s) => s.key === key);
      if (!s) {
        throw new Error(`Unknown scalar key '${key}' on ${ent.type} entity '${ent.id}'`);
      }
      return s.value;
    },
    set: (val) => {
      if (!ent.dofScalars().some((s) => s.key === key)) {
        throw new Error(`Unknown scalar key '${key}' on ${ent.type} entity '${ent.id}'`);
      }
      ent.setScalar(key, val);
    },
  };
}

const scalarKey = (id: string, key: string): string => `scalar:${id}:${key}`;
const sumSq = (v: number[]): number => v.reduce((s, x) => s + x * x, 0);

/**
 * The image size/rotation DOFs (w/h/angle) the image hands to the solver.
 *
 * Nothing by default, so an image is a **rigid** body and a corner/centre
 * constraint translates it rather than distorting it to fit (its corners are
 * nonlinear in w/h/angle, so an image left free reflows ambiguously).
 * `constraintResize` adds the size — w alone when the aspect is locked, since h
 * then rides on w inside `setScalar` and the pair is a single uniform-scale DOF
 * whose ratio can't drift — and `constraintRotate` adds the angle.
 */
export function freeImageScalars(ent: RasterImageEntity): string[] {
  const free: string[] = [];
  if (ent.constraintResize) {
    free.push("w");
    if (!ent.aspectLocked) free.push("h");
  }
  if (ent.constraintRotate) free.push("angle");
  return free;
}

/**
 * Fix every image scalar {@link freeImageScalars} doesn't release. A scalar
 * driven by a formula binding is always free regardless, so parametric formulas
 * keep working on a rigid image.
 */
function fixImageScalars(doc: CADDocument, fixed: Set<string>): void {
  for (const ent of doc.entities) {
    if (!(ent instanceof RasterImageEntity)) continue;
    const free = freeImageScalars(ent);
    for (const s of ent.dofScalars())
      if (
        !free.includes(s.key) &&
        !doc.bindings.some((b) => b.entityId === ent.id && b.scalarKey === s.key)
      )
        fixed.add(scalarKey(ent.id, s.key));
  }
}
const norm = (v: number[]): number => Math.sqrt(sumSq(v));



// ---------------------------------------------------------------------------
// Per-entity DOF status for sketch coloring

export type EntityStatus = "defined" | "under-defined" | "conflict";
export type EntityStatusMap = Map<EntityId, EntityStatus>;

/**
 * Compute per-entity constraint status for sketch coloring.
 *   "defined"      – all DOF variables of this entity are uniquely constrained
 *   "under-defined"– some DOF variables remain free
 *   "conflict"     – solver did not converge (over/conflicting constraints)
 *
 * Uses RREF null-space analysis: a variable is "determined" iff it has zero
 * component in every null vector of the constraint Jacobian.
 */
export function computeEntityDofStatus(
  doc: CADDocument,
  lastResult: SolveResult | null,
): EntityStatusMap {
  const statusMap: EntityStatusMap = new Map();
  const byId = new Map<string, Entity>(doc.entities.map((e) => [e.id, e]));
  const geo: Geo = (id) => byId.get(id);

  // Solver didn't converge → everything is in conflict
  if (lastResult?.hasConstraints && !lastResult.converged) {
    for (const e of doc.entities) statusMap.set(e.id, "conflict");
    return statusMap;
  }

  // Build fixed set (identical logic to solve())
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
  fixImageScalars(doc, fixed);

  // Build variable list with per-variable entity tracking
  const vars: Variable[] = [];
  const varEntIds: string[] = [];
  for (const ent of doc.entities) {
    for (const p of ent.dofPoints()) {
      if (fixed.has(`${ent.id}:${p.key}`)) continue;
      vars.push(pointComponent(ent, p.key, "x"), pointComponent(ent, p.key, "y"));
      varEntIds.push(ent.id, ent.id);
    }
    for (const s of ent.dofScalars()) {
      if (fixed.has(scalarKey(ent.id, s.key))) continue;
      vars.push(scalarComponent(ent, s.key));
      varEntIds.push(ent.id);
    }
  }

  // Map entity → column indices in the variable vector
  const entColsMap = new Map<string, number[]>();
  for (let i = 0; i < vars.length; i++) {
    const eid = varEntIds[i];
    if (!entColsMap.has(eid)) entColsMap.set(eid, []);
    entColsMap.get(eid)!.push(i);
  }
  // Entities with no solver variables (fixed or zero DOF) are always "defined"
  for (const e of doc.entities) {
    if (!entColsMap.has(e.id)) statusMap.set(e.id, "defined");
  }

  // Programmatically CONTROLLED geometry — a generator feature's output or a
  // pattern instance — is driven by its feature/pattern, not by the constraint
  // solver, so its free solver DOF are not "loose". Treat it as defined so an
  // inserted Panel/gear/box or a patterned copy doesn't render under-defined
  // (blue) despite being fully controlled. (The pattern SOURCE is ordinary
  // geometry and is left to the normal analysis.)
  const controlled = new Set<EntityId>();
  for (const f of doc.features) {
    const g = doc.groups.find((gr) => gr.id === f.groupId);
    if (g) for (const id of g.entityIds) controlled.add(id);
  }
  for (const p of doc.patterns) {
    for (const inst of p.instanceIds) for (const id of inst) controlled.add(id);
  }

  if (vars.length === 0) return statusMap;

  // Build constraint Jacobian (no anchors/pins — pure constraint equations)
  const active = doc.constraints.filter((c) => c.type !== "fixed");
  const drivingDims = doc.dimensions.filter((d) => d.driving);
  const bTargets = doc.bindings.map((b) =>
    bindingTarget(b, new Map(doc.variables.map((v) => [v.name, v.value]))),
  );

  const evalR = (x: number[]): number[] => {
    vars.forEach((v, i) => {
      v.set(x[i]);
    });
    const out: number[] = [];
    for (const c of active) for (const r of constraintResiduals(c, geo)) out.push(r);
    for (const d of drivingDims) for (const r of dimensionResiduals(d, geo)) out.push(r);
    doc.bindings.forEach((b, i) => {
      for (const r of bindingResidualAt(b, geo, bTargets[i])) out.push(r);
    });
    return out;
  };

  const x = vars.map((v) => v.get());
  const fx = evalR(x);

  if (fx.length === 0) {
    // No effective constraints → all under-defined, except controlled geometry.
    for (const [eid] of entColsMap)
      statusMap.set(eid, controlled.has(eid) ? "defined" : "under-defined");
    evalR(x); // restore entity state
    return statusMap;
  }

  const J = jacobian(evalR, x, fx);
  evalR(x); // restore entity state

  // Find which variable indices are uniquely determined by the constraints
  const determined = determinedVariables(J);

  // An entity is "defined" iff ALL its variables are determined — or it is
  // controlled by a feature/pattern (driven, not loose).
  for (const [eid, cols] of entColsMap) {
    const allDetermined = cols.every((ci) => determined.has(ci));
    statusMap.set(eid, allDetermined || controlled.has(eid) ? "defined" : "under-defined");
  }

  return statusMap;
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
  fixImageScalars(doc, fixed);

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
  const bTargets = doc.bindings.map((b) =>
    bindingTarget(b, new Map(doc.variables.map((v) => [v.name, v.value]))),
  );

  const buildEvalR =
    (includeExtras: boolean) =>
    (x: number[]): number[] => {
      vars.forEach((v, i) => {
        v.set(x[i]);
      });
      const out: number[] = [];
      for (const c of active) for (const v of constraintResiduals(c, geo)) out.push(v);
      for (const d of drivingDims) for (const v of dimensionResiduals(d, geo)) out.push(v);
      doc.bindings.forEach((b, i) => {
        for (const v of bindingResidualAt(b, geo, bTargets[i])) out.push(v);
      });
      if (includeExtras)
        for (const c of extraActive) for (const v of constraintResiduals(c, geo)) out.push(v);
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
