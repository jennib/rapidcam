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
import {
  type Constraint,
  constraintResiduals,
  type Geo,
  lineRefEntityId,
} from "../model/constraints";
import { dimensionResiduals } from "../model/dimensions";
import { type CADDocument, ORIGIN_ENTITY_ID, STOCK_ENTITY_ID, stockRefEntity } from "../model/document";
import type { EntityId } from "../model/entities";
import { ArcEntity, type Entity, RasterImageEntity, TextEntity } from "../model/entities";
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

/**
 * Whether a solve is healthy. An unconstrained sketch has nothing to converge,
 * so `converged: false` on it is not a failure — only a sketch that HAS
 * constraints and failed to satisfy them counts.
 */
export function solveConverged(res: SolveResult): boolean {
  return !res.hasConstraints || res.converged;
}

/** Object counts that go into a solve-failure report. Counts only — never geometry. */
export interface SolveHealthCounts {
  entities: number;
  constraints: number;
  dimensions: number;
}

/**
 * Build the analytics payload for a sketch that has just stopped solving, or
 * `null` if there is nothing worth reporting.
 *
 * Edge-triggered against `prevConverged`: a broken sketch re-solves on every
 * subsequent edit, so a level-triggered report would fire on every keystroke
 * until it was fixed. The moment it broke is the signal; the rest is noise.
 *
 * Pure, so the decision is testable without standing up an App and its DOM —
 * the caller owns only the previous-state bookkeeping.
 */
export function solveFailureEvent(
  res: SolveResult,
  prevConverged: boolean,
  counts: SolveHealthCounts,
): Record<string, number> | null {
  if (solveConverged(res) || !prevConverged) return null;
  return {
    residual_norm: res.residualNorm,
    dof: res.dof,
    variables: res.variables,
    equations: res.equations,
    entities: counts.entities,
    constraints: counts.constraints,
    dimensions: counts.dimensions,
  };
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
  const geo: Geo = (id) => (id === STOCK_ENTITY_ID ? stockRefEntity(doc) : byId.get(id));
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
  fixRigidBodyScalars(doc, fixed);

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
  // Which entity each variable belongs to, and the reverse. Used to partition the
  // system into independent subsystems below; `Variable` itself is just get/set.
  const entVarIdx = new Map<string, number[]>();
  const noteVar = (entId: string, idx: number): void => {
    const list = entVarIdx.get(entId);
    if (list) list.push(idx);
    else entVarIdx.set(entId, [idx]);
  };
  const anchorVars: Variable[] = [];
  // Anchor j pulls on variable index anchorVarIdx[j] — needed to file each anchor
  // into the right subsystem.
  const anchorVarIdx: number[] = [];
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
      noteVar(ent.id, vars.length);
      noteVar(ent.id, vars.length + 1);
      const ix = vars.length;
      vars.push(vx, vy);
      // Always anchor non-pinned DOFs to prefer minimal-change solutions in
      // under-constrained systems (e.g. editing a dimension without dragging).
      if (!pinnedComponents.has(`${ent.id}:${p.key}:x`)) {
        anchorVars.push(vx);
        anchorVarIdx.push(ix);
        anchorScales.push(1);
      }
      if (!pinnedComponents.has(`${ent.id}:${p.key}:y`)) {
        anchorVars.push(vy);
        anchorVarIdx.push(ix + 1);
        anchorScales.push(1);
      }
    }
    for (const s of ent.dofScalars()) {
      if (fixed.has(scalarKey(ent.id, s.key))) continue;
      const vs = scalarComponent(ent, s.key);
      noteVar(ent.id, vars.length);
      const is = vars.length;
      vars.push(vs);
      if (!pinnedScalars.has(scalarKey(ent.id, s.key))) {
        anchorVars.push(vs);
        anchorVarIdx.push(is);
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

  // --- partition into independent subsystems ---------------------------------
  // Variables interact ONLY through a shared residual, so the constraint graph
  // splits into connected components that can be solved one at a time. That is
  // the difference between one 1000-variable problem and 500 two-variable ones:
  // every per-iteration cost here is superlinear in subsystem size — the normal
  // equations JtJ are O(n^2*m) and the dense solve is O(n^3) — so shrinking n is
  // worth far more than shaving constants.
  //
  // The partition OVER-approximates on purpose: a residual is assumed to depend
  // on every variable of every entity it names, even when it really touches one
  // DOF. Over-merging only costs speed; under-merging would silently solve the
  // wrong geometry. test/solverPartition.test.ts checks the Jacobian sparsity
  // really does respect the split rather than trusting this comment.
  const { find, comps, rootOfRefs, refsOf } = partitionVariables(doc, entVarIdx, n);

  const cActive = new Map<number, typeof active>();
  const cDims = new Map<number, typeof drivingDims>();
  const cBind = new Map<number, { b: (typeof doc.bindings)[number]; i: number }[]>();
  const cCenter = new Map<number, { c: (typeof centerCons)[number]; i: number }[]>();
  const cPins = new Map<number, typeof pinEntries>();
  const cAnchors = new Map<number, number[]>();
  const push = <T>(m: Map<number, T[]>, k: number, v: T): void => {
    if (k < 0) return;
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  for (const c of active) push(cActive, rootOfRefs(refsOf(c)), c);
  for (const d of drivingDims) push(cDims, rootOfRefs(refsOf(d)), d);
  doc.bindings.forEach((b, i) => {
    push(cBind, rootOfRefs([b.entityId]), { b, i });
  });
  centerCons.forEach((c, i) => {
    push(cCenter, rootOfRefs(refsOf(c)), { c, i });
  });
  for (const pe of pinEntries) push(cPins, rootOfRefs([pe.ent.id]), pe);
  for (let j = 0; j < anchorVars.length; j++) push(cAnchors, find(anchorVarIdx[j]), j);

  // --- Levenberg-Marquardt, once per subsystem -------------------------------
  for (const [root, idx] of comps) {
    const cv = idx.map((i) => vars[i]);
    const cn = cv.length;
    const ca = cActive.get(root) ?? [];
    const cd = cDims.get(root) ?? [];
    const cb = cBind.get(root) ?? [];
    const cc = cCenter.get(root) ?? [];
    const cp = cPins.get(root) ?? [];
    const can = cAnchors.get(root) ?? [];

    // A subsystem with no constraint of any kind already sits at its anchors, so
    // its cost starts at zero and the loop below would exit immediately anyway.
    // Skipping keeps a large unconstrained import (DXF, traced outline) genuinely
    // free rather than merely fast.
    if (ca.length === 0 && cd.length === 0 && cb.length === 0 && cc.length === 0 && cp.length === 0)
      continue;

    const compConstraintVec = (): number[] => {
      const out: number[] = [];
      for (const c of ca) for (const v of constraintResiduals(c, geo)) out.push(v);
      for (const d of cd) for (const v of dimensionResiduals(d, geo)) out.push(v);
      for (const bi of cb)
        for (const v of bindingResidualAt(bi.b, geo, bindingTargets[bi.i])) out.push(v);
      for (const ci of cc) {
        const target = centerTargets[ci.i];
        if (!target) continue;
        const mover = byId.get(ci.c.points[0].entityId);
        if (!mover) continue;
        let mp: Vec2;
        try {
          mp = mover.getPoint(ci.c.points[0].key);
        } catch {
          continue;
        }
        const axis = ci.c.params?.[0];
        if (axis !== 1) out.push(mp.x - target.x);
        if (axis !== 0) out.push(mp.y - target.y);
      }
      return out;
    };
    const compResiduals = (): number[] => {
      const out = compConstraintVec();
      for (const pe of cp) {
        const pos = pe.ent.getPoint(pe.key);
        out.push(PIN_WEIGHT * (pos.x - pe.target.x));
        out.push(PIN_WEIGHT * (pos.y - pe.target.y));
      }
      for (const j of can) {
        out.push(anchorW * anchorScales[j] * (anchorVars[j].get() - anchorStart[j]));
      }
      return out;
    };
    const compEquations = compConstraintVec().length;

    const setCX = (xs: number[]) =>
      cv.forEach((v, i) => {
        v.set(xs[i]);
      });
    const evalCR = (xs: number[]): number[] => {
      setCX(xs);
      return compResiduals();
    };

    let x = cv.map((v) => v.get());
    let fx = evalCR(x);
    let cost = sumSq(fx);
    let lambda = 1e-3;

    for (let iter = 0; iter < MAX_ITER && cost > COST_TOL; iter++) {
      const J = jacobian(evalCR, x, fx);
      const m = fx.length;

      const A: number[][] = Array.from({ length: cn }, () => new Array<number>(cn).fill(0));
      const g = new Array<number>(cn).fill(0);
      // Normal equations A = JᵀJ and g = Jᵀf, accumulated over the NON-ZERO
      // entries of each Jacobian row only.
      //
      // A constraint's residual depends on the handful of variables it names —
      // a coincident touches 4 of them — so a row of J is nearly all zeros, and
      // the textbook triple loop spent essentially all of its time adding
      // products that are zero: 98% of a 200-segment chain's solve (6077ms of
      // 6215ms), growing as O(n²·m). Such a chain is ONE connected component,
      // so partitioning cannot shrink it either. Sparse accumulation took that
      // case to 172ms total, and it converges in 2 iterations either way.
      //
      // Zeros contribute nothing to a sum, so this is arithmetically identical,
      // not an approximation. The finite-difference Jacobian yields EXACT zeros
      // for untouched variables — perturbing one variable leaves an unrelated
      // residual bit-identical — so testing `!== 0` is safe.
      for (let k = 0; k < m; k++) {
        const row = J[k];
        const fk = fx[k];
        // Collected per row rather than all up front: each support is used
        // twice here and never again, and keeping them all costs memory
        // proportional to the dense matrix this exists to avoid.
        const cols: number[] = [];
        for (let i = 0; i < cn; i++) if (row[i] !== 0) cols.push(i);
        for (let a = 0; a < cols.length; a++) {
          const i = cols[a];
          const jki = row[i];
          g[i] += jki * fk;
          const Ai = A[i];
          for (let b = 0; b < cols.length; b++) Ai[cols[b]] += jki * row[cols[b]];
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
        const fxn = evalCR(xn);
        const cnew = sumSq(fxn);
        if (cnew < cost) {
          x = xn;
          fx = fxn;
          cost = cnew;
          lambda = Math.max(lambda * 0.3, 1e-12);
          improved = true;
          break;
        }
        lambda *= 10;
      }
      if (!improved) break;
      if (!pins && norm(fx.slice(0, compEquations)) < 1e-4) break;
    }
    setCX(x);
  }

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
 * Pin the scalars of the entities that are RIGID bodies — images and text.
 *
 * An image releases what {@link freeImageScalars} allows; text releases nothing,
 * having no equivalent opt-in. Everything else is fixed, so a constraint
 * translates the object rather than stretching or spinning it to satisfy itself,
 * and a sketch's DOF count doesn't grow by two for every label on it.
 *
 * A scalar driven by a formula binding is always free regardless — that is the
 * channel the parametric fields use, and it must keep working on a rigid body.
 */
function fixRigidBodyScalars(doc: CADDocument, fixed: Set<string>): void {
  for (const ent of doc.entities) {
    const isImage = ent instanceof RasterImageEntity;
    if (!isImage && !(ent instanceof TextEntity)) continue;
    const free = isImage ? freeImageScalars(ent) : [];
    for (const s of ent.dofScalars())
      if (
        !free.includes(s.key) &&
        !doc.bindings.some((b) => b.entityId === ent.id && b.scalarKey === s.key)
      )
        fixed.add(scalarKey(ent.id, s.key));
  }
}
const norm = (v: number[]): number => Math.sqrt(sumSq(v));




/**
 * Split variable indices into independent subsystems.
 *
 * Variables interact only through a shared residual, so the constraint graph
 * breaks into connected components that can be handled one at a time. Every
 * per-iteration cost in this file is superlinear in subsystem size — the normal
 * equations are O(n^2*m), the dense solve and the RREF are O(n^3) — so shrinking
 * n is worth far more than shaving constants.
 *
 * The partition OVER-approximates deliberately: a residual is assumed to depend
 * on every variable of every entity it names, even when it really touches one
 * DOF. Over-merging only costs speed; under-merging would silently drop a
 * constraint and solve the wrong geometry. That is not hypothetical — the first
 * version missed that a polyline SEGMENT is referenced as
 * `${polylineId}#${vertexId}` rather than a bare entity id, so those constraints
 * resolved to no variables and stopped being applied at all.
 * test/solverPartition.test.ts exists to make that class of bug fail loudly.
 *
 * Shared by the solver and the DOF-status pass so the rule — and that gotcha —
 * live in exactly one place.
 */
export interface VarPartition {
  /** Component root for a variable index. */
  find: (i: number) => number;
  /** Root → the variable indices belonging to it. */
  comps: Map<number, number[]>;
  /** Root for a residual source, or -1 when it touches no free variable. */
  rootOfRefs: (ids: readonly string[]) => number;
  /** Entity ids a constraint/dimension names, with segment refs resolved. */
  refsOf: (c: { entities?: string[]; points?: { entityId: string }[] }) => string[];
}

export function partitionVariables(
  doc: CADDocument,
  entVarIdx: Map<string, number[]>,
  n: number,
): VarPartition {
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a: number): number => {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    while (parent[a] !== r) {
      const next = parent[a];
      parent[a] = r;
      a = next;
    }
    return r;
  };
  const refsOf = (c: { entities?: string[]; points?: { entityId: string }[] }): string[] => [
    ...(c.entities ?? []).map(lineRefEntityId),
    ...(c.points ?? []).map((pt) => pt.entityId),
  ];
  const link = (ids: readonly string[]): void => {
    let first = -1;
    for (const id of ids) {
      for (const vi of entVarIdx.get(id) ?? []) {
        if (first < 0) first = vi;
        else {
          const ra = find(first);
          const rb = find(vi);
          if (ra !== rb) parent[ra] = rb;
        }
      }
    }
  };
  for (const c of doc.constraints) {
    if (c.type === "fixed") continue;
    link(refsOf(c));
  }
  for (const d of doc.dimensions) {
    if (d.driving) link(refsOf(d));
  }
  for (const b of doc.bindings) link([b.entityId]);

  const comps = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const list = comps.get(r);
    if (list) list.push(i);
    else comps.set(r, [i]);
  }
  const rootOfRefs = (ids: readonly string[]): number => {
    for (const id of ids) {
      const list = entVarIdx.get(id);
      if (list && list.length > 0) return find(list[0]);
    }
    return -1;
  };
  return { find, comps, rootOfRefs, refsOf };
}

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
  const geo: Geo = (id) => (id === STOCK_ENTITY_ID ? stockRefEntity(doc) : byId.get(id));

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
  fixRigidBodyScalars(doc, fixed);

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

  // Same partition the solver uses, for the same reason: this pass builds a
  // finite-difference Jacobian (n+1 residual evaluations) and then runs an RREF
  // null-space analysis over it, both of which blow up on the whole document.
  // Determinedness is a per-subsystem property — the global Jacobian is
  // block-diagonal across components, so a null vector never spans two of them —
  // which makes analysing each block separately exact, not an approximation.
  //
  // This pass is purely COSMETIC (it drives entity colouring), and before this it
  // dominated everything: at 2000 constrained holes the solver took 19ms and this
  // took 2,998ms.
  const entVarIdx = new Map<string, number[]>();
  for (let i = 0; i < vars.length; i++) {
    const eid = varEntIds[i];
    const list = entVarIdx.get(eid);
    if (list) list.push(i);
    else entVarIdx.set(eid, [i]);
  }
  const part = partitionVariables(doc, entVarIdx, vars.length);

  // File each residual source under its subsystem.
  const cActive = new Map<number, typeof active>();
  const cDims = new Map<number, typeof drivingDims>();
  const cBind = new Map<number, { b: (typeof doc.bindings)[number]; i: number }[]>();
  const file = <T>(m: Map<number, T[]>, k: number, v: T): void => {
    if (k < 0) return;
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  for (const c of active) file(cActive, part.rootOfRefs(part.refsOf(c)), c);
  for (const d of drivingDims) file(cDims, part.rootOfRefs(part.refsOf(d)), d);
  doc.bindings.forEach((b, i) => {
    file(cBind, part.rootOfRefs([b.entityId]), { b, i });
  });

  const x = vars.map((v) => v.get());
  const anyResidual =
    active.length > 0 || drivingDims.length > 0 || doc.bindings.length > 0;

  if (!anyResidual) {
    // No effective constraints → all under-defined, except controlled geometry.
    for (const [eid] of entColsMap)
      statusMap.set(eid, controlled.has(eid) ? "defined" : "under-defined");
    return statusMap;
  }

  // A variable is determined unless its own subsystem says otherwise. Anything in
  // a subsystem with no constraints at all is free by definition, so it is left
  // undetermined without building a Jacobian for it.
  const determined = new Set<number>();
  for (const [root, idx] of part.comps) {
    const ca = cActive.get(root) ?? [];
    const cd = cDims.get(root) ?? [];
    const cb = cBind.get(root) ?? [];
    if (ca.length === 0 && cd.length === 0 && cb.length === 0) continue;

    const cv = idx.map((i) => vars[i]);
    const evalCR = (xs: number[]): number[] => {
      cv.forEach((v, i) => {
        v.set(xs[i]);
      });
      const out: number[] = [];
      for (const c of ca) for (const r of constraintResiduals(c, geo)) out.push(r);
      for (const d of cd) for (const r of dimensionResiduals(d, geo)) out.push(r);
      for (const bi of cb)
        for (const r of bindingResidualAt(bi.b, geo, bTargets[bi.i])) out.push(r);
      return out;
    };
    const cx = cv.map((v) => v.get());
    const cfx = evalCR(cx);
    if (cfx.length === 0) {
      evalCR(cx);
      continue;
    }
    const cJ = jacobian(evalCR, cx, cfx);
    evalCR(cx); // restore entity state for this subsystem
    const cDet = determinedVariables(cJ);
    for (let k = 0; k < idx.length; k++) if (cDet.has(k)) determined.add(idx[k]);
  }

  // Restore every variable to where it started (the per-subsystem loops above
  // each restore their own, but a subsystem that was skipped never moved).
  vars.forEach((v, i) => {
    v.set(x[i]);
  });

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
  const geo: Geo = (id) => (id === STOCK_ENTITY_ID ? stockRefEntity(doc) : byId.get(id));

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
  fixRigidBodyScalars(doc, fixed);

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
