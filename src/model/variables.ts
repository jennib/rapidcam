import type { Unit } from "../core/units";
import { parseLength } from "../core/units";
import { evalExpr, type VarMap } from "../core/expr";
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
export function varMap(variables: Variable[], stockThickness?: number): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of variables) m.set(v.name, v.value);
  if (stockThickness !== undefined) m.set("stock", stockThickness);
  return m;
}

/** Identifiers in `expr` that name a variable in `names`. */
function referencedVars(expr: string, names: Set<string>): string[] {
  const out: string[] = [];
  const re = /[a-zA-Z_][a-zA-Z0-9_]*/g;
  let m = re.exec(expr);
  while (m !== null) {
    if (names.has(m[0])) out.push(m[0]);
    m = re.exec(expr);
  }
  return out;
}

/**
 * Evaluate every variable's cached `value`, resolving variable-to-variable
 * references in dependency (topological) order. A plain length ("50mm", "1/2in",
 * or a bare number in the display unit) is parsed unit-aware; an expression that
 * references other variables or uses arithmetic is evaluated via {@link evalExpr}
 * once its dependencies are known (bare numbers are internal mm there, matching
 * dimension formulas). Variables caught in a reference cycle (incl. self-ref) are
 * left at their previous value — no infinite loop. O(V+E) Kahn's sort.
 */
export function evaluateVariables(variables: Variable[], displayUnit: Unit, stockThickness?: number): void {
  const byName = new Map(variables.map((v) => [v.name, v]));
  const names = new Set(byName.keys());

  const dependents = new Map<string, string[]>(); // var → vars that reference it
  const indeg = new Map<string, number>();
  for (const v of variables) {
    dependents.set(v.name, []);
    indeg.set(v.name, 0);
  }
  for (const v of variables) {
    for (const r of new Set(referencedVars(v.expr, names))) {
      indeg.set(v.name, indeg.get(v.name)! + 1);
      // A self-reference adds in-degree but no unblocking edge, so it never
      // becomes ready → stays at its last value (correct for a self-cycle).
      if (r !== v.name) dependents.get(r)!.push(v.name);
    }
  }

  const ready = variables.filter((v) => indeg.get(v.name) === 0).map((v) => v.name);
  const vm = new Map<string, number>();
  for (const v of variables) vm.set(v.name, v.value); // seed (cyclic vars keep these)
  if (stockThickness !== undefined) vm.set("stock", stockThickness);

  while (ready.length) {
    const name = ready.shift()!;
    const v = byName.get(name)!;
    const len = parseLength(v.expr, displayUnit);
    const val = len ?? evalExpr(v.expr, vm);
    if (val !== null && Number.isFinite(val)) v.value = val;
    vm.set(name, v.value);
    for (const d of dependents.get(name)!) {
      indeg.set(d, indeg.get(d)! - 1);
      if (indeg.get(d) === 0) ready.push(d);
    }
  }
}

/**
 * Evaluate all variable exprs, then evaluate any dimension expressions that
 * reference variables. Call this before every solve. (Entity scalar formulas —
 * circle radius, image width/height/angle, etc. — are ScalarBindings resolved by
 * the solver, not here.)
 */
export function evaluateAll(variables: Variable[], dims: Dimension[], displayUnit: Unit, stockThickness?: number): void {
  // Phase 1: evaluate variables in dependency order (supports variable-to-variable
  // references, e.g. margin = width * 0.1).
  evaluateVariables(variables, displayUnit, stockThickness);

  // Phase 2: update dimension values from their expressions
  const vm: VarMap = varMap(variables, stockThickness);
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
