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

/** Identifiers in `expr` that name a variable in `names`. */
function referencedVars(expr: string, names: Set<string>): string[] {
  const out: string[] = [];
  const re = /[a-zA-Z_][a-zA-Z0-9_]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr)) !== null) if (names.has(m[0])) out.push(m[0]);
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
export function evaluateVariables(variables: Variable[], displayUnit: Unit): void {
  const byName = new Map(variables.map((v) => [v.name, v]));
  const names = new Set(byName.keys());

  const dependents = new Map<string, string[]>(); // var → vars that reference it
  const indeg = new Map<string, number>();
  for (const v of variables) { dependents.set(v.name, []); indeg.set(v.name, 0); }
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

  while (ready.length) {
    const name = ready.shift()!;
    const v = byName.get(name)!;
    const len = parseLength(v.expr, displayUnit);
    const val = len ?? evalExpr(v.expr, vm);
    if (val !== null && isFinite(val)) v.value = val;
    vm.set(name, v.value);
    for (const d of dependents.get(name)!) {
      indeg.set(d, indeg.get(d)! - 1);
      if (indeg.get(d) === 0) ready.push(d);
    }
  }
}

/**
 * Evaluate all variable exprs, then evaluate any dimension expressions and image
 * formula fields that reference variables. Call this before every solve.
 */
export function evaluateAll(variables: Variable[], dims: Dimension[], displayUnit: Unit, entities: Entity[] = []): void {
  // Phase 1: evaluate variables in dependency order (supports variable-to-variable
  // references, e.g. margin = width * 0.1).
  evaluateVariables(variables, displayUnit);

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
