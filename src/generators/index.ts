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
import { nextId } from "../model/ids";
import { type Handle, type Pt, Sketch, type TextFlattener } from "./sketch";
import { boxJoint } from "./boxJoint";
import { gear } from "./gear";
import { box } from "./box";

export interface Generator {
  /** Stable id (kebab-case), also the group name prefix. */
  id: string;
  /** Human-readable label for the generator picker. */
  name: string;
  /** Draw the feature into `s`; return the handles that form its output. */
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
}

/** Effective parameter set (every declared param → its resolved value). Stored
 *  on the feature so a re-run reproduces the geometry and exposes all knobs. */
function effectiveParams(sketch: Sketch): Record<string, number> {
  return Object.fromEntries(sketch.params.map((p) => [p.name, p.value]));
}

/** Offset that centres `entities`' combined bounding box on the work-area centre. */
function centreOffset(doc: CADDocument, entities: Entity[]): Pt {
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
 * Place a sketch's entities onto `doc`: apply each entity's layer hint (creating
 * the layer on demand), translate by `offset`, and add. Shared by run + regen.
 */
function commitEntities(doc: CADDocument, sketch: Sketch, offset: Pt): void {
  sketch.entities.forEach((e, i) => {
    const hint = sketch.entityLayers[i];
    if (hint) e.layerId = ensureLayer(doc, hint.name, hint.color);
    e.translate(offset);
    doc.add(e);
  });
  for (const v of sketch.variables) doc.addVariable(v);
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
  opts: { flatten?: TextFlattener } = {},
): GeneratorResult {
  const sketch = new Sketch({ params, flatten: opts.flatten });
  const handles = gen.build(sketch);

  // Generators draw around the origin; place the part in the middle of the work
  // area so it lands where the user is looking, not jammed at the WCS corner.
  const offset = centreOffset(doc, sketch.entities);
  commitEntities(doc, sketch, offset);

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
  };
  doc.features.push(feature);
  doc.emitChange();

  return { feature, group, handles, sketch };
}

/**
 * Regenerate an existing feature in place with `newParams` merged over the ones
 * it was built with. The feature's old entities are removed, the generator is
 * re-run, and the same group/feature records are updated to point at the fresh
 * geometry — so a host can edit the box joint's finger count and see it rebuild
 * without losing the feature's identity.
 *
 * Returns the updated result, or null if the feature or its generator is unknown.
 * (Variables a generator declares are re-added on each run; a generator that
 * declares variables should name them stably — the box joint declares none.)
 */
export function regenerateFeature(
  doc: CADDocument,
  featureId: string,
  newParams: Record<string, number>,
  opts: { flatten?: TextFlattener } = {},
): GeneratorResult | null {
  const feature = doc.features.find((f) => f.id === featureId);
  if (!feature) return null;
  const gen = GENERATORS[feature.generatorId];
  if (!gen) return null;
  const group = doc.groups.find((g) => g.id === feature.groupId);
  if (!group) return null;

  // Drop the old geometry, then re-run with the merged parameters.
  for (const id of group.entityIds) doc.remove(id);

  const merged = { ...feature.params, ...newParams };
  const sketch = new Sketch({ params: merged, flatten: opts.flatten });
  const handles = gen.build(sketch);
  // Re-apply the feature's stored placement so it rebuilds where it sits.
  const offset = feature.offset ?? { x: 0, y: 0 };
  commitEntities(doc, sketch, offset);

  group.entityIds = sketch.entities.map((e) => e.id);
  feature.params = effectiveParams(sketch);
  doc.emitChange();

  return { feature, group, handles, sketch };
}
