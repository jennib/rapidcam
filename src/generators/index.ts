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

import {
  type CADDocument,
  type FeatureInstance,
  type GroupDef,
  type LayerDef,
  stockBox,
} from "../model/document";
import type { Bounds, Entity } from "../model/entities";
import type { CAMOperation } from "../cam/types";
import { nextId } from "../model/ids";
import { evalExpr } from "../core/expr";
import { varMap } from "../model/variables";
import { buildSuggestedOps } from "./suggestOps";
import {
  type Handle,
  type LayerHint,
  type Pt,
  Sketch,
  type StockDatum,
  type TextFlattener,
} from "./sketch";
import { panel } from "./panel";
import { boxJoint } from "./boxJoint";
import { gear } from "./gear";
import { box } from "./box";
import { clamp } from "./clamp";
import { kumiko } from "./kumiko";

export interface Generator {
  /** Stable id (kebab-case), also the group name prefix. */
  id: string;
  /** Human-readable label for the generator picker. */
  name: string;
  /**
   * Where the run lands.
   *
   * `"centre"` (the default, and what every part generator wants) draws around
   * the origin and lets the runner centre the result on the work area, nudged
   * clear of existing features.
   *
   * `"stock"` means the generator has already placed itself in absolute document
   * coordinates by reading {@link Sketch.stock}, so the runner must not move it —
   * a clamp on the blank's left edge is *at* the blank's left edge, and centring
   * it would put it in the middle of the part. Such a feature is also rebuilt
   * whenever the blank changes (see {@link regenerateStockPlacedFeatures}), which
   * is what makes workholding follow a resized stock.
   */
  placement?: "centre" | "stock";
  /**
   * Draw the feature into `s`; return the handles that form its output.
   *
   * IDENTITY CONTRACT: name entities via `s.key()` — keyed entities keep their
   * document ids across regeneration BY KEY, immune to output reordering and
   * partial deletes. Unkeyed entities fall back to positional matching, so if
   * any go unkeyed, emit them in a deterministic order that is stable across
   * parameter values (append new optional entities at the end); an unkeyed
   * entity that changes position pairs with the wrong id or loses it entirely.
   */
  build(s: Sketch): Handle[];
}

/** Built-in first-party generators, keyed by id. */
export const GENERATORS: Record<string, Generator> = {
  [panel.id]: panel,
  [boxJoint.id]: boxJoint,
  [gear.id]: gear,
  [box.id]: box,
  [clamp.id]: clamp,
  [kumiko.id]: kumiko,
};

/** True when `gen` places itself against the blank rather than being centred. */
function stockPlaced(gen: Generator): boolean {
  return gen.placement === "stock";
}

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
    if (group?.entityIds.some((id) => ids.has(id))) return f;
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

/** Combined bounding box of `entities`, or null if there are none. */
function boundsOf(entities: readonly Entity[]): Bounds | null {
  if (entities.length === 0) return null;
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
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

/** Offset that centres `entities`' combined bounding box on the work-area centre.
 *  Exported for the dialog's insert-mode ghost preview, which must show the part
 *  where a commit would actually place it. */
export function centreOffset(doc: CADDocument, entities: Entity[]): Pt {
  const b = boundsOf(entities);
  if (!b) return { x: 0, y: 0 };
  return {
    x: doc.canvas.width / 2 - (b.min.x + b.max.x) / 2,
    y: doc.canvas.height / 2 - (b.min.y + b.max.y) / 2,
  };
}

/** Strict rectangle overlap — touching edges (equal coordinates) don't count. */
function rectsOverlap(a: Bounds, b: Bounds): boolean {
  return a.min.x < b.max.x && a.max.x > b.min.x && a.min.y < b.max.y && a.max.y > b.min.y;
}

/**
 * Nudge `start` (centreOffset's proposed translation) so the incoming
 * geometry — `bounds`, its untranslated bbox — doesn't land on top of an
 * existing feature. Repeated inserts used to stack dead-centre on the work
 * area. Each step JUMPS PAST the first colliding feature's bbox (a fixed
 * small step exhausts against any part wider than step×tries — a big first
 * insert would make every later part pile at the same offset). If a jump
 * would push the candidate outside the work area, or the blocker count runs
 * out, return `start` — stacking at centre is better than wandering off the
 * stock, and there the user can see the pile-up.
 *
 * Pure: only reads doc state, never mutates. Exported for tests.
 */
export function nudgeOffset(doc: CADDocument, bounds: Bounds, start: Pt): Pt {
  const byId = new Map(doc.entities.map((e) => [e.id, e] as const));
  // Combined bbox of each feature's group — only groups a feature actually
  // references, and only their still-live entities (a group a regen emptied
  // out contributes nothing).
  const existing: Bounds[] = [];
  for (const f of doc.features) {
    const group = doc.groups.find((g) => g.id === f.groupId);
    if (!group) continue;
    const liveEntities = group.entityIds.map((id) => byId.get(id)).filter((e): e is Entity => !!e);
    const b = boundsOf(liveEntities);
    if (b) existing.push(b);
  }

  const MARGIN = 10;
  const MAX_JUMPS = 8;
  let offset: Pt = { x: start.x, y: start.y };
  for (let jumps = 0; jumps <= MAX_JUMPS; jumps++) {
    const candidate: Bounds = {
      min: { x: bounds.min.x + offset.x, y: bounds.min.y + offset.y },
      max: { x: bounds.max.x + offset.x, y: bounds.max.y + offset.y },
    };
    const blocker = existing.find((o) => rectsOverlap(candidate, o));
    if (!blocker) return offset;
    // Jump to just past the blocker's right edge; wrap into a "next row"
    // below the blocker when that would leave the work area horizontally.
    const dx = blocker.max.x - candidate.min.x + MARGIN;
    if (candidate.max.x + dx <= doc.canvas.width) {
      offset = { x: offset.x + dx, y: offset.y };
      continue;
    }
    const dy = blocker.max.y - candidate.min.y + MARGIN;
    if (candidate.max.y + dy <= doc.canvas.height) {
      offset = { x: start.x, y: offset.y + dy };
      continue;
    }
    return start; // no room anywhere sensible — stack at centre, visibly
  }
  return start;
}

/**
 * Id of the doc layer matching `hint` (reused across runs), creating it if absent.
 *
 * Matching is on name AND kind, not name alone: promoting an existing ordinary
 * layer called "Workholding" to a fixture layer would silently reclassify
 * everything already on it as a clamp — geometry that then stops being cut and
 * starts blocking toolpaths. A name collision across kinds gets its own layer
 * instead, which is visible in the layers panel rather than silent.
 */
function ensureLayer(doc: CADDocument, hint: LayerHint): string {
  const wantFixture = hint.fixture === true;
  const existing = doc.layers.find(
    (l) => l.name === hint.name && (l.fixture === true) === wantFixture,
  );
  if (existing) return existing.id;
  const name = doc.layers.some((l) => l.name === hint.name)
    ? `${hint.name} (${wantFixture ? "workholding" : "geometry"})`
    : hint.name;
  const layer: LayerDef = {
    id: nextId("layer"),
    name,
    color: hint.color ?? "#10b981",
    visible: true,
    locked: false,
    // Deliberately no `fixtureHeight`: the height lives on each clamp entity so
    // features sharing this layer keep their own (see Sketch.layer).
    ...(wantFixture ? { fixture: true } : {}),
  };
  doc.layers.push(layer);
  return layer.id;
}

/**
 * The blank as a generator sees it — plain data, so the Sketch stays pure.
 * Every production Sketch is built with this; see {@link Sketch.stock}.
 */
export function stockDatum(doc: CADDocument): StockDatum {
  return { ...stockBox(doc), thickness: doc.stockThickness };
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
    if (hint) e.layerId = ensureLayer(doc, hint);
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
 * Pair a feature's existing entity ids with the fresh entities of a re-run so
 * surviving entities KEEP their ids (CAM ops, constraints, and dimensions stay
 * valid — the same id-reuse contract pattern regeneration relies on, see
 * CADDocument.replaceInstanceEntity). Two passes:
 *
 * 1. KEYED: a fresh entity named via `Sketch.key()` claims the id its key
 *    mapped to last run (`keyIds`), regardless of where either sits in the
 *    sequence — immune to output reordering and to earlier entities having
 *    been deleted.
 * 2. INDEX: the remainders pair by position with same-entity-type required
 *    (unkeyed generators take this path wholesale — the original behavior).
 *
 * Anything left unpaired is added (fresh) or removed (old).
 */
function matchEntities(
  oldIds: readonly string[],
  byId: ReadonlyMap<string, Entity>,
  fresh: readonly Entity[],
  freshKeys: readonly (string | undefined)[] = [],
  keyIds: Readonly<Record<string, string>> = {},
): { pairs: { oldId: string; fresh: Entity }[]; added: Entity[]; removedIds: string[] } {
  const pairs: { oldId: string; fresh: Entity }[] = [];
  const added: Entity[] = [];
  const removedIds: string[] = [];
  const usedOld = new Set<string>();
  const pairedFresh = new Set<number>();

  fresh.forEach((f, i) => {
    const k = freshKeys[i];
    if (!k) return;
    const oldEnt = keyIds[k] ? byId.get(keyIds[k]) : undefined;
    if (oldEnt && !usedOld.has(oldEnt.id) && oldEnt.type === f.type) {
      pairs.push({ oldId: oldEnt.id, fresh: f });
      usedOld.add(oldEnt.id);
      pairedFresh.add(i);
    }
  });

  const remOld = oldIds.filter((id) => !usedOld.has(id));
  const remFresh = fresh.filter((_, i) => !pairedFresh.has(i));
  const n = Math.max(remOld.length, remFresh.length);
  for (let i = 0; i < n; i++) {
    const oldEnt = i < remOld.length ? byId.get(remOld[i]) : undefined;
    const f = i < remFresh.length ? remFresh[i] : undefined;
    if (oldEnt && f && oldEnt.type === f.type) {
      pairs.push({ oldId: oldEnt.id, fresh: f });
    } else {
      if (f) added.push(f);
      if (oldEnt) removedIds.push(oldEnt.id);
    }
  }
  return { pairs, added, removedIds };
}

/** Key → committed-entity-id map from a built sketch (empty object if unkeyed). */
function collectKeyIds(sketch: Sketch): Record<string, string> {
  const out: Record<string, string> = {};
  sketch.entityKeys.forEach((k, i) => {
    if (k) out[k] = sketch.entities[i].id;
  });
  return out;
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
  const sketch = new Sketch({
    params,
    flatten: opts.flatten,
    stock: stockDatum(doc),
    displayUnit: doc.displayUnit,
  });
  const handles = gen.build(sketch);

  // Generators draw around the origin; place the part in the middle of the work
  // area so it lands where the user is looking, not jammed at the WCS corner.
  // Repeated inserts used to stack dead-centre on top of each other — nudge
  // off any existing feature's footprint so they land visibly apart instead.
  //
  // A stock-placed generator has already put itself where it belongs by reading
  // the blank, so it gets no offset at all: centring a clamp would move it off
  // the edge it grips, and nudging it "clear of existing features" would shove
  // it off deliberately — overlapping the part is what workholding DOES.
  const offset = stockPlaced(gen)
    ? { x: 0, y: 0 }
    : nudgeOffset(
        doc,
        boundsOf(sketch.entities) ?? { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } },
        centreOffset(doc, sketch.entities),
      );
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

  const keyIds = collectKeyIds(sketch);
  const feature: FeatureInstance = {
    id: nextId("feat"),
    generatorId: gen.id,
    params: effectiveParams(sketch),
    groupId: group.id,
    offset,
    ...(opts.paramExprs && Object.keys(opts.paramExprs).length
      ? { paramExprs: { ...opts.paramExprs } }
      : {}),
    ...(Object.keys(keyIds).length ? { keyIds } : {}),
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
  const sketch = new Sketch({
    params: merged,
    flatten: opts.flatten,
    stock: stockDatum(doc),
    displayUnit: doc.displayUnit,
  });
  const handles = gen.build(sketch);
  // Re-apply the feature's stored placement so it rebuilds where it sits — but a
  // stock-placed feature re-derives its position from the CURRENT blank on every
  // rebuild, which is exactly how a clamp follows a resized stock.
  const offset = stockPlaced(gen) ? { x: 0, y: 0 } : (feature.offset ?? { x: 0, y: 0 });
  prepareEntities(doc, sketch, offset);

  const byId = new Map(doc.entities.map((e) => [e.id, e] as const));
  const { pairs, added, removedIds } = matchEntities(
    group.entityIds,
    byId,
    sketch.entities,
    sketch.entityKeys,
    feature.keyIds ?? {},
  );
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
  // Ids are final here (survivors got theirs back via replaceInstanceEntity),
  // so the key map can be rebuilt for the next regeneration.
  const keyIds = collectKeyIds(sketch);
  feature.keyIds = Object.keys(keyIds).length ? keyIds : undefined;
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
  const probe = new Sketch({
    params: resolveFeatureParams(doc, f),
    flatten: () => [],
    stock: stockDatum(doc),
  });
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
 * Rebuild every feature that placed itself against the blank. Returns whether
 * anything rebuilt; the caller owns the history transaction and re-solves.
 *
 * Unconditional for those features rather than staleness-checked, because the
 * thing that changed — where the blank is — is not one of their PARAMS, so
 * {@link isFeatureStale} cannot see it. Rebuilding is cheap (there are only ever
 * a handful of clamps), idempotent, and preserves entity ids through
 * `regenerateFeature`, so attached ops, constraints and dimensions survive.
 *
 * This is what makes a clamp stay on the edge it grips when the stock is resized
 * or moved. Without it a clamp would keep the position the blank had when it was
 * inserted, quietly describing workholding that is no longer there — and the
 * pre-flight collision check would be reasoning about the wrong geometry.
 */
export function regenerateStockPlacedFeatures(
  doc: CADDocument,
  opts: { flatten?: TextFlattener } = {},
): boolean {
  let changed = false;
  for (const f of [...doc.features]) {
    const gen = GENERATORS[f.generatorId];
    if (!gen || !stockPlaced(gen)) continue;
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
