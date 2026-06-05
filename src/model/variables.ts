import { Unit } from "../core/units";
import { parseLength } from "../core/units";
import { evalExpr, VarMap } from "../core/expr";
import { nextId } from "./ids";
import type { Dimension } from "./dimensions";

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
 * Evaluate all variable exprs, then evaluate any dimension expressions that
 * reference variables. Call this before every solve.
 */
export function evaluateAll(variables: Variable[], dims: Dimension[], displayUnit: Unit): void {
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
}

export function isValidName(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

export function isDuplicateName(name: string, variables: Variable[], excludeId?: string): boolean {
  return variables.some((v) => v.name === name && v.id !== excludeId);
}
