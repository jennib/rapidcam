import type { Unit } from "../core/units";
import { parseLength } from "../core/units";
import { evalExpr, type VarMap } from "../core/expr";
import { nextId } from "./ids";
import type { Dimension } from "./dimensions";
import type { CAMOperation } from "../cam/types";

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

/**
 * Pin every bare-number variable to the unit it was authored in, before the
 * project's display unit changes underneath it.
 *
 * A variable stores its RAW input (`expr`) and re-parses it on every solve via
 * `parseLength(expr, displayUnit)`. That makes a bare `"10"` mean "10 of
 * whatever the project currently displays" — so flipping a mm project to inches
 * silently rewrote `10` to 254mm on the next solve, dragging every dimension and
 * binding driven from it. The corruption was invisible at the moment of the
 * switch, because nothing re-evaluates until something else triggers a solve.
 *
 * Appending the authored unit makes the expr self-describing and the value
 * exact — no round-trip through a converted decimal — and it is a form the user
 * can already type ("50mm", "3.5in"). Exprs that already carry a unit, and
 * formulas (which `parseLength` rejects, so they resolve as mm via `evalExpr`
 * like every other formula in the app), are left alone.
 */
export function pinVariableUnits(variables: Variable[], authoredUnit: Unit): void {
  for (const v of variables) {
    const asMM = parseLength(v.expr, "mm");
    const asIn = parseLength(v.expr, "in");
    // null → a formula, not a plain length. Equal → already unit-qualified (or
    // zero), so the display unit never affected it.
    if (asMM === null || asIn === null || asMM === asIn) continue;
    v.expr = `${v.expr.trim()}${authoredUnit}`;
  }
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
 * Valid range for every expression-drivable CAM operation field, plus where the
 * value lives on the operation.
 *
 * This is the SINGLE source of truth for CAM field bounds. The dialog rows clamp
 * through `clampOpParam` when a value is committed, and `applyOpParam` clamps
 * through the same table on every solve — so a hand-typed value and an
 * expression-driven one can never settle on different numbers. Keeping two
 * tables in sync by hand had already drifted on five fields.
 *
 * Where those two disagreed, the TIGHTER bound wins: a bound exists to catch a
 * slipped decimal, and no looser value here enabled a real cut. The exception is
 * a bound that rejects something legitimate (`spindleSpeed`, see below) — then
 * the looser one is the correct one.
 */
interface OpParamSpec {
  clamp: (v: number) => number;
  read: (op: CAMOperation) => number | undefined;
  write: (op: CAMOperation, v: number) => void;
  /** Nested fields only: whether the parent object (tabs/leadIn/leadOut) exists. */
  present?: (op: CAMOperation) => boolean;
}

const atLeast =
  (min: number) =>
  (v: number): number =>
    Math.max(min, v);
const within =
  (min: number, max: number) =>
  (v: number): number =>
    Math.min(max, Math.max(min, v));
const intAtLeast =
  (min: number) =>
  (v: number): number =>
    Math.max(min, Math.round(v));

/** Spec for a plain numeric field directly on the operation. */
function flat(key: keyof CAMOperation, clamp: (v: number) => number): OpParamSpec {
  return {
    clamp,
    read: (op) => op[key] as number | undefined,
    write: (op, v) => {
      (op as unknown as Record<string, number>)[key] = v;
    },
  };
}

/**
 * Spec for a field inside `tabs`/`leadIn`/`leadOut`. An expression targeting one
 * is inert while its parent is absent, and starts applying once the parent
 * exists — it never brings the parent into being.
 */
function inside(
  parent: "tabs" | "leadIn" | "leadOut",
  key: string,
  clamp: (v: number) => number,
): OpParamSpec {
  const obj = (op: CAMOperation) => op[parent] as Record<string, number> | undefined;
  return {
    clamp,
    present: (op) => obj(op) !== undefined,
    read: (op) => obj(op)?.[key],
    write: (op, v) => {
      const o = obj(op);
      if (o) o[key] = v;
    },
  };
}

const OP_PARAMS: Record<string, OpParamSpec> = {
  // Cut geometry. `depth` is always below the surface and `stepdown` always a
  // magnitude, so "-stock" and "stock" drive them identically.
  depth: flat("depth", (v) => -Math.abs(v)),
  stepdown: flat("stepdown", (v) => Math.max(0.01, Math.abs(v))),
  stepover: flat("stepover", within(0.01, 1)),
  peckDepth: flat("peckDepth", atLeast(0)),
  finishAllowance: flat("finishAllowance", atLeast(0)),
  // Rest machining: the diameter of the tool that already roughed this pocket.
  // 0 means off, so it floors at 0 rather than at a smallest sensible cutter.
  restToolDiameter: flat("restToolDiameter", atLeast(0)),
  // Facing: extra travel past the target's edge, on top of the tool radius the
  // cutter already overhangs by. 0 is the normal answer, hence the floor.
  faceOverhang: flat("faceOverhang", atLeast(0)),
  chamferWidth: flat("chamferWidth", atLeast(0)),
  rampAngle: flat("rampAngle", within(0.5, 45)),
  vStep: flat("vStep", atLeast(0.01)),
  vHopClearance: flat("vHopClearance", atLeast(0)),
  reliefGamma: flat("reliefGamma", atLeast(0.01)),

  // Tool + feeds.
  //
  // Cutting rates floor at 1 because F0 faults or stalls the controller, and
  // safeZ floors above 0 because a negative "safe" height turns every retract
  // into a rapid INTO the stock. (That rationale was written on the old
  // camBar's feed/safeZ rows and lost when it was split into modules; it is the
  // reason these two numbers are what they are, so it lives with them now.)
  //
  // spindleSpeed has no floor above 0 — the pre-refactor dialog never clamped it
  // (`Math.round(v)`), a laser or manually-driven router legitimately posts S0,
  // and the schema's minimum is 0. It is the one bound where the looser value is
  // the correct one.
  toolNumber: flat("toolNumber", intAtLeast(1)),
  diameter: flat("diameter", atLeast(0.01)),
  vAngle: flat("vAngle", within(1, 179)),
  tipAngle: flat("tipAngle", within(1, 179)),
  feedrate: flat("feedrate", atLeast(1)),
  plungeRate: flat("plungeRate", atLeast(1)),
  spindleSpeed: flat("spindleSpeed", intAtLeast(0)),
  safeZ: flat("safeZ", atLeast(0.1)),

  // Laser / raster. The pitch floors are 0.01mm = 10µm, already finer than any
  // real beam spot (~50–200µm) or ball-nose stepover, so they cost nothing
  // physical while still catching a slipped decimal: `rasterLineInterval` is
  // shared by laser raster AND mill relief, and at 0.001 a 100mm-wide relief
  // would silently become a 100,000-pass job.
  laserPower: flat("laserPower", within(0, 100)),
  laserPasses: flat("laserPasses", intAtLeast(1)),
  kerfWidth: flat("kerfWidth", atLeast(0)),
  laserFillSpacing: flat("laserFillSpacing", atLeast(0.01)),
  laserOverscan: flat("laserOverscan", atLeast(0)),
  rasterLineInterval: flat("rasterLineInterval", atLeast(0.01)),
  rasterDotPitch: flat("rasterDotPitch", atLeast(0)),
  rasterMinPower: flat("rasterMinPower", within(0, 100)),

  // Nested. Both the flat and dotted spelling are accepted, as documented in
  // the format guide — hand- and AI-authored files use either.
  tabCount: inside("tabs", "count", intAtLeast(1)),
  "tabs.count": inside("tabs", "count", intAtLeast(1)),
  tabSpacing: inside("tabs", "spacing", atLeast(1)),
  "tabs.spacing": inside("tabs", "spacing", atLeast(1)),
  tabWidth: inside("tabs", "width", atLeast(0.1)),
  "tabs.width": inside("tabs", "width", atLeast(0.1)),
  tabHeight: inside("tabs", "height", atLeast(0.1)),
  "tabs.height": inside("tabs", "height", atLeast(0.1)),
  leadInLen: inside("leadIn", "length", atLeast(0.1)),
  "leadIn.length": inside("leadIn", "length", atLeast(0.1)),
  leadOutLen: inside("leadOut", "length", atLeast(0.1)),
  "leadOut.length": inside("leadOut", "length", atLeast(0.1)),
};

/**
 * Every field name `clampOpParam`/`applyOpParam` understands. A CAM dialog row
 * whose key is missing here is inert — it can neither be typed into nor driven
 * by a formula — so `test/cam-parametric.test.ts` asserts the dialog's keys are
 * a subset of these.
 */
export const OP_PARAM_KEYS: readonly string[] = Object.keys(OP_PARAMS);

/**
 * Clamp a raw number to the valid range for a CAM operation field. Returns null
 * for a non-finite value or a field that cannot be expression-driven, so callers
 * can tell "no opinion" from a legitimately clamped 0.
 */
export function clampOpParam(key: string, v: number): number | null {
  const spec = OP_PARAMS[key];
  if (!spec || !Number.isFinite(v)) return null;
  return spec.clamp(v);
}

/**
 * Clamp an evaluated number and assign it to a CAM operation field. Returns
 * whether the operation actually changed, so a solve can skip redundant work.
 */
export function applyOpParam(op: CAMOperation, key: string, v: number): boolean {
  const spec = OP_PARAMS[key];
  if (!spec || !Number.isFinite(v)) return false;
  if (spec.present && !spec.present(op)) return false;
  const target = spec.clamp(v);
  if (spec.read(op) === target) return false;
  spec.write(op, target);
  return true;
}

/**
 * Re-evaluate all CAM operations' `paramExprs` against current variables and stock.
 */
export function evaluateOperations(
  ops: CAMOperation[],
  variables: Variable[],
  stockThickness?: number,
): boolean {
  const vm = varMap(variables, stockThickness);
  let changed = false;
  for (const op of ops) {
    if (!op.paramExprs) continue;
    for (const [key, expr] of Object.entries(op.paramExprs)) {
      if (!expr || expr.trim() === "") continue;
      const v = evalExpr(expr, vm);
      if (v !== null && Number.isFinite(v)) {
        if (applyOpParam(op, key, v)) changed = true;
      }
    }
  }
  return changed;
}

/**
 * Evaluate all variable exprs, dimension expressions, and CAM operation expressions
 * that reference variables. Call this before every solve or when variables change.
 */
export function evaluateAll(
  variables: Variable[],
  dims: Dimension[],
  displayUnit: Unit,
  stockThickness?: number,
  ops?: CAMOperation[],
): boolean {
  let changed = false;

  // Phase 1: evaluate variables in dependency order
  evaluateVariables(variables, displayUnit, stockThickness);

  // Phase 2: update dimension values from their expressions
  const vm: VarMap = varMap(variables, stockThickness);
  for (const d of dims) {
    if (!d.expr) continue;
    const v = evalExpr(d.expr, vm);
    if (v !== null && v > 0 && d.value !== v) {
      d.value = v;
      changed = true;
    }
  }

  // Phase 3: update CAM operation values from their parametric expressions
  if (ops && ops.length > 0 && evaluateOperations(ops, variables, stockThickness)) {
    changed = true;
  }

  return changed;
}

export function isValidName(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

export function isDuplicateName(name: string, variables: Variable[], excludeId?: string): boolean {
  return variables.some((v) => v.name === name && v.id !== excludeId);
}
