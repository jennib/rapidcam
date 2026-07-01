import { Unit } from "../core/units";
import { parseLength } from "../core/units";
import { evalExpr, VarMap } from "../core/expr";
import { nextId } from "./ids";
import type { Dimension } from "./dimensions";
import type { Entity } from "./entities";
import { RasterImageEntity } from "./entities";

export interface Variable {
  id: string;
  /** Valid JS identifier: /^[a-zA-Z_][a-zA-Z0-9_]*$/ */
  name: string;
  /** Raw input string (e.g. "100", "50mm", "3.5in"). Stored as entered; evaluated via parseLength. */
  expr: string;
  /** Cached value in internal mm, updated by evaluateAll(). */
  value: number;
}

export function makeVariable(name: string, expr: string, displayUnit: Unit): Variable {
  return {
    id: nextId("var"),
    name,
    expr,
    value: parseLength(expr, displayUnit) ?? 0,
  };
}

/** Build a name→value map suitable for evalExpr(). */
export function varMap(variables: Variable[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of variables) m.set(v.name, v.value);
  return m;
}

/**
 * Evaluate all variable exprs, then evaluate any dimension expressions and image
 * formula fields that reference variables. Call this before every solve.
 */
export function evaluateAll(variables: Variable[], dims: Dimension[], displayUnit: Unit, entities: Entity[] = []): void {
  // Phase 1: update each variable's cached value
  for (const v of variables) {
    const mm = parseLength(v.expr, displayUnit);
    v.value = mm ?? v.value;
  }

  // Phase 2: update dimension values from their expressions
  const vm: VarMap = varMap(variables);
  for (const d of dims) {
    if (!d.expr) continue;
    const v = evalExpr(d.expr, vm);
    if (v !== null && v > 0) d.value = v;
  }

  // Phase 3: drive image width/height/angle from their formula fields. Width and
  // height are mm; the angle formula is in DEGREES (stored as radians). Images
  // aren't solver DOFs, so these are set directly (no conflict with constraints).
  for (const e of entities) {
    if (!(e instanceof RasterImageEntity)) continue;

    // Preserve the image's CURRENT displayed proportions when aspect-locked (same
    // rule as an in-panel literal edit) — captured before any formula changes a side.
    const aspect = e.heightMM !== 0 ? e.widthMM / e.heightMM : 1;
    let widthUpdated = false;
    let heightUpdated = false;

    if (e.widthExpr) {
      const w = evalExpr(e.widthExpr, vm);
      if (w !== null && w > 0) { e.widthMM = w; widthUpdated = true; }
    }
    if (e.heightExpr) {
      const h = evalExpr(e.heightExpr, vm);
      if (h !== null && h > 0) { e.heightMM = h; heightUpdated = true; }
    }
    // Aspect-lock derives the other side only when exactly one has a formula
    // (two explicit formulas win over the lock).
    if (e.aspectLocked && aspect > 0) {
      if (widthUpdated && !heightUpdated) e.heightMM = e.widthMM / aspect;
      else if (heightUpdated && !widthUpdated) e.widthMM = e.heightMM * aspect;
    }

    if (e.angleExpr) {
      const a = evalExpr(e.angleExpr, vm);
      if (a !== null) e.angle = (a * Math.PI) / 180;
    }
  }
}

export function isValidName(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

export function isDuplicateName(name: string, variables: Variable[], excludeId?: string): boolean {
  return variables.some((v) => v.name === name && v.id !== excludeId);
}
