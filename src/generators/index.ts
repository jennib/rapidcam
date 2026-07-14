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

import type { CADDocument, FeatureInstance, GroupDef } from "../model/document";
import { nextId } from "../model/ids";
import { type Handle, Sketch, type TextFlattener } from "./sketch";
import { boxJoint } from "./boxJoint";

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

  for (const e of sketch.entities) doc.add(e);
  for (const v of sketch.variables) doc.addVariable(v);

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
  for (const e of sketch.entities) doc.add(e);
  for (const v of sketch.variables) doc.addVariable(v);

  group.entityIds = sketch.entities.map((e) => e.id);
  feature.params = effectiveParams(sketch);
  doc.emitChange();

  return { feature, group, handles, sketch };
}
