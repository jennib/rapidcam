/**
 * Generator registry + runner.
 *
 * A {@link Generator} is a pure function of a {@link Sketch}: it declares
 * parameters, draws geometry, and returns the handles it considers its output.
 * It never touches the CADDocument — {@link runGenerator} is what commits a run
 * onto a document, grouping the emitted entities into one re-runnable feature.
 *
 * v1 covers the eight self-contained entities plus `textToPath`. Live text/image
 * authoring (which needs the embedded-font and image registries) is deferred, so
 * generators — and the eventual user-script sandbox — stay resource-free and
 * Worker-safe. See sketch.ts.
 */

import type { CADDocument, FeatureInstance, GroupDef, LayerDef } from "../model/document";
import type { Entity } from "../model/entities";
import type { CAMOperation } from "../cam/types";
import { nextId } from "../model/ids";
import { evalExpr } from "../core/expr";
import { varMap } from "../model/variables";
import { buildSuggestedOps } from "./suggestOps";
import { type Handle, type Pt, Sketch, type TextFlattener } from "./sketch";
import { boxJoint } from "./boxJoint";
import { gear } from "./gear";
import { box } from "./box";

export interface Generator {
  /** Stable id (kebab-case), also the group name prefix. */
  id: string;
  /** Human-readable label for the generator picker. */
  name: string;
  /**
   * Draw the feature into `s`; return the handles that form its output.
   *
   * ORDERING CONTRACT: emit entities in a deterministic order that is stable
   * across parameter values (append new optional entities at the end).
   * Regeneration matches old→new entities by position to keep entity ids — and
   * therefore CAM ops, constraints, and dimensions — alive across a re-run; an
   * entity that changes position pairs with the wrong id or loses it entirely.
   */
  build(s: Sketch): Handle[];
}

/** Built-in first-party generators, keyed by id. */
export const GENERATORS: Record<string, Generator> = {
  [boxJoint.id]: boxJoint,
  [gear.id]: gear,
  [box.id]: box,
};

/**
 * The feature (if any) whose group holds one of `entityIds` — i.e. the generated
 * feature the current selection belongs to. Lets the UI offer "edit this feature"
 * when a piece of generated geometry is selected. Returns the first match.
 */
export function findFeatureForEntities(
  doc: CADDocument,
  entityIds: readonly string[],
): FeatureInstance | null {
  const ids = new Set(entityIds);
  for (const f of doc.features) {
    const group = doc.groups.find((g) => g.id === f.groupId);
    if (group && group.entityIds.some((id) => ids.has(id))) return f;
  }
  return null;
}

/** The outcome of committing a generator run onto a document. */
export interface GeneratorResult {
  feature: FeatureInstance;
  group: GroupDef;
  handles: Handle[];
  sketch: Sketch;
  /** Suggested CAM ops created for this run (insert with `createOps` only —
   *  regeneration never creates ops; existing ones survive via stable ids). */
  operations: CAMOperation[];
}

/** Effective parameter set (every declared param → its resolved value). Stored
 *  on the feature so a re-run reproduces the geometry and exposes all knobs. */
function effectiveParams(sketch: Sketch): Record<string, number> {
  return Object.fromEntries(sketch.params.map((p) => [p.name, p.value]));
}

/** Offset that centres `entities`' combined bounding box on the work-area centre.
 *  Exported for the dialog's insert-mode ghost preview, which must show the part
 *  where a commit would actually place it. */
export function centreOffset(doc: CADDocument, entities: Entity[]): Pt {
  if (entities.length === 0) return { x: 0, y: 0 };
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const e of entities) {
    const b = e.bounds();
    minX = Math.min(minX, b.min.x);
    minY = Math.min(minY, b.min.y);
    maxX = Math.max(maxX, b.max.x);
    maxY = Math.max(maxY, b.max.y);
  }
  return {
    x: doc.canvas.width / 2 - (minX + maxX) / 2,
    y: doc.canvas.height / 2 - (minY + maxY) / 2,
  };
}

/** Id of the doc layer named `name` (reused across runs), creating it if absent. */
function ensureLayer(doc: CADDocument, name: string, color?: string): string {
  const existing = doc.layers.find((l) => l.name === name);
  if (existing) return existing.id;
  const layer: LayerDef = {
    id: nextId("layer"),
    name,
    color: color ?? "#10b981",
    visible: true,
    locked: false,
  };
  doc.layers.push(layer);
  return layer.id;
}

/**
 * Prepare a sketch's entities for the document without adding them: apply each
 * entity's layer hint (creating the layer on demand) and translate by `offset`.
 * Shared by run + regen — regen installs survivors via `replaceInstanceEntity`
 * rather than `doc.add`, so adding is the caller's job.
 */
function prepareEntities(doc: CADDocument, sketch: Sketch, offset: Pt): void {
  sketch.entities.forEach((e, i) => {
    const hint = sketch.entityLayers[i];
    if (hint) e.layerId = ensureLayer(doc, hint.name, hint.color);
    e.translate(offset);
  });
}

/**
 * Add the sketch's declared variables, skipping names the document already has.
 * `addVariable` does not dedupe by name; without this guard every regeneration
 * would push another copy of each declared variable. An existing variable is
 * left untouched (the user may have edited its expression).
 */
function upsertVariables(doc: CADDocument, sketch: Sketch): void {
  for (const v of sketch.variables) {
    if (!doc.variables.some((existing) => existing.name === v.name)) doc.addVariable(v);
  }
}

/**
 * Pair a feature's existing entity ids with the fresh entities of a re-run, by
 * position: entity k of the new run inherits entity k's id when the types
 * match, so CAM ops, constraints, and dimensions pointing at surviving
 * geometry stay valid across a regeneration (the same id-reuse contract
 * pattern regeneration relies on — see CADDocument.replaceInstanceEntity).
 * A type mismatch at a position breaks the pair: the fresh entity is added
 * under its own new id and the old one is removed.
 */
function matchEntities(
  oldIds: readonly string[],
  byId: ReadonlyMap<string, Entity>,
  fresh: readonly Entity[],
): { pairs: { oldId: string; fresh: Entity }[]; added: Entity[]; removedIds: string[] } {
  const pairs: { oldId: string; fresh: Entity }[] = [];
  const added: Entity[] = [];
  const removedIds: string[] = [];
  const n = Math.max(oldIds.length, fresh.length);
  for (let i = 0; i < n; i++) {
    const oldEnt = i < oldIds.length ? byId.get(oldIds[i]) : undefined;
    const f = i < fresh.length ? fresh[i] : undefined;
    if (oldEnt && f && oldEnt.type === f.type) {
      pairs.push({ oldId: oldEnt.id, fresh: f });
    } else {
      if (f) added.push(f);
      if (oldEnt) removedIds.push(oldEnt.id);
    }
  }
  return { pairs, added, removedIds };
}

/**
 * Run `gen` with `params` and commit the result onto `doc` as a re-editable
 * feature: every emitted entity is added, its ids collected into a group, any
 * declared variables added, and a {@link FeatureInstance} recorded so the
 * feature can later be regenerated in place (see {@link regenerateFeature}).
 */
export function runGenerator(
  doc: CADDocument,
  gen: Generator,
  params: Record<string, number> = {},
  opts: {
    flatten?: TextFlattener;
    paramExprs?: Record<string, string>;
    /** Also create the generator's suggested CAM ops (see sketch.ts OpSuggestion). */
    createOps?: boolean;
  } = {},
): GeneratorResult {
  const sketch = new Sketch({ params, flatten: opts.flatten });
  const handles = gen.build(sketch);

  // Generators draw around the origin; place the part in the middle of the work
  // area so it lands where the user is looking, not jammed at the WCS corner.
  const offset = centreOffset(doc, sketch.entities);
  prepareEntities(doc, sketch, offset);
  for (const e of sketch.entities) doc.add(e);
  upsertVariables(doc, sketch);

  // Suggested ops must be built AFTER the entities land on the doc — pocket
  // regions are seeded against live document geometry. One history step with
  // the geometry (materialTest precedent: commit entities + ops together).
  const operations = opts.createOps ? buildSuggestedOps(doc, sketch) : [];
  doc.operations.push(...operations);

  const group: GroupDef = {
    id: nextId("group"),
    name: gen.name,
    entityIds: sketch.entities.map((e) => e.id),
  };
  doc.groups.push(group);

  const feature: FeatureInstance = {
    id: nextId("feat"),
    generatorId: gen.id,
    params: effectiveParams(sketch),
    groupId: group.id,
    offset,
    ...(opts.paramExprs && Object.keys(opts.paramExprs).length
      ? { paramExprs: { ...opts.paramExprs } }
      : {}),
  };
  doc.features.push(feature);
  doc.emitChange();

  return { feature, group, handles, sketch, operations };
}

/**
 * Regenerate an existing feature in place with `newParams` merged over the ones
 * it was built with. The generator is re-run and the fresh geometry is
 * reconciled against the feature's existing entities so surviving positions
 * KEEP THEIR IDS — CAM operations, constraints, and dimensions that reference
 * generated geometry stay valid across a parameter edit. Entities the re-run no
 * longer produces are removed in one batch; new ones are added.
 *
 * Returns the updated result, or null if the feature or its generator is unknown.
 */
export function regenerateFeature(
  doc: CADDocument,
  featureId: string,
  newParams: Record<string, number>,
  opts: { flatten?: TextFlattener; paramExprs?: Record<string, string> } = {},
): GeneratorResult | null {
  const feature = doc.features.find((f) => f.id === featureId);
  if (!feature) return null;
  const gen = GENERATORS[feature.generatorId];
  if (!gen) return null;
  const group = doc.groups.find((g) => g.id === feature.groupId);
  if (!group) return null;

  const merged = { ...feature.params, ...newParams };
  const sketch = new Sketch({ params: merged, flatten: opts.flatten });
  const handles = gen.build(sketch);
  // Re-apply the feature's stored placement so it rebuilds where it sits.
  const offset = feature.offset ?? { x: 0, y: 0 };
  prepareEntities(doc, sketch, offset);

  const byId = new Map(doc.entities.map((e) => [e.id, e] as const));
  const { pairs, added, removedIds } = matchEntities(group.entityIds, byId, sketch.entities);
  for (const p of pairs) doc.replaceInstanceEntity(p.oldId, p.fresh);
  for (const e of added) doc.add(e);

  // The group record must reflect the new membership BEFORE the batched
  // removal: pruneReferences trims groups to live ids (dropping the feature if
  // its group empties) and must see the post-regen membership, not the stale
  // one. Survivors carry their old ids here — replaceInstanceEntity moved them
  // onto the fresh entities.
  group.entityIds = sketch.entities.map((e) => e.id);
  if (removedIds.length) doc.batchRemove(removedIds);

  upsertVariables(doc, sketch);
  feature.params = effectiveParams(sketch);
  // `paramExprs` replaces wholesale when the caller PROVIDES it (an empty object
  // clears every stored expr — a field the user blanked out reverts to a plain
  // literal); omitting the option leaves whatever exprs are already stored
  // untouched, which is what regenerateStaleFeatures relies on.
  if (opts.paramExprs !== undefined) {
    feature.paramExprs = Object.keys(opts.paramExprs).length ? { ...opts.paramExprs } : undefined;
  }
  doc.emitChange();

  return { feature, group, handles, sketch, operations: [] };
}

// ---------------------------------------------------------------------------
// Expression resolution & auto-regeneration — mirrors patternEngine.ts's
// isParamStale / regenerateStalePatterns / reconcileLoadedPatterns so features
// and patterns behave the same way under variable edits and file load.

/**
 * `f.params` with every `paramExprs` entry re-evaluated against the document's
 * current variables (and `stock`). A param with no expression, or one that
 * fails to evaluate (unknown/renamed variable, syntax error), keeps its cached
 * numeric — the engine is the source of truth at run/regen/load time, so a
 * feature always reflects the latest variable values, but a bad expression
 * never blanks out working geometry.
 */
export function resolveFeatureParams(doc: CADDocument, f: FeatureInstance): Record<string, number> {
  const resolved: Record<string, number> = { ...f.params };
  if (!f.paramExprs) return resolved;
  const vm = varMap(doc.variables, doc.stockThickness);
  for (const [k, expr] of Object.entries(f.paramExprs)) {
    const v = evalExpr(expr, vm);
    if (v !== null && Number.isFinite(v)) resolved[k] = v;
  }
  return resolved;
}

/**
 * True if a feature's expression-driven params would rebuild differently from
 * what is currently on the document — i.e. a referenced variable changed.
 *
 * This is a PROBE-RUN comparison, not a raw compare of resolved exprs against
 * cached params: `Sketch.param` clamps (and may round) a param to its declared
 * [min,max], so a resolved value that lands outside that range would compare
 * unequal to the already-clamped cache FOREVER, flagging the feature stale on
 * every check and causing a regen storm on each variable edit. Building a
 * throwaway probe sketch and comparing ITS effective params (post-clamp)
 * against the cache asks the right question — "would a rebuild produce
 * different effective params?" — which is idempotent: one regeneration makes
 * the feature clean again even when its expression sits outside range.
 */
export function isFeatureStale(doc: CADDocument, f: FeatureInstance): boolean {
  if (!f.paramExprs || Object.keys(f.paramExprs).length === 0) return false;
  const gen = GENERATORS[f.generatorId];
  if (!gen) return false;
  const probe = new Sketch({ params: resolveFeatureParams(doc, f), flatten: () => [] });
  gen.build(probe);
  const fresh = effectiveParams(probe);
  for (const k of Object.keys(fresh)) {
    if (fresh[k] !== f.params[k]) return true;
  }
  return false;
}

/**
 * Regenerate every feature whose expression-driven params are stale relative
 * to the document's current variables. Returns whether anything regenerated;
 * the caller owns the history transaction and re-solves afterwards (mirrors
 * {@link ../model/patternEngine.regenerateStalePatterns}).
 */
export function regenerateStaleFeatures(
  doc: CADDocument,
  opts: { flatten?: TextFlattener } = {},
): boolean {
  let changed = false;
  for (const f of [...doc.features]) {
    if (!isFeatureStale(doc, f)) continue;
    regenerateFeature(doc, f.id, resolveFeatureParams(doc, f), opts);
    changed = true;
  }
  return changed;
}

/**
 * Reconcile features right after a file loads: regenerate any feature whose
 * expression-driven params no longer match the loaded params (the classic
 * hand- or AI-authored mismatch, or a variable edited outside RapidCAM).
 * Well-formed files are untouched (mirrors
 * {@link ../model/patternEngine.reconcileLoadedPatterns}).
 */
export function reconcileLoadedFeatures(doc: CADDocument): void {
  for (const f of [...doc.features]) {
    if (!isFeatureStale(doc, f)) continue;
    regenerateFeature(doc, f.id, resolveFeatureParams(doc, f));
  }
}
