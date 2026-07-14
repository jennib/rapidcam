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

import type { CADDocument, GroupDef } from "../model/document";
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

/** The outcome of committing a generator run onto a document. */
export interface GeneratorResult {
  group: GroupDef;
  handles: Handle[];
  sketch: Sketch;
}

/**
 * Run `gen` with `params` and commit the result onto `doc`: every emitted entity
 * is added, its ids collected into a new group (the feature), and any declared
 * variables added to the document. Returns the group and the sketch (whose
 * `params` a host reads to build an editor for a later re-run).
 *
 * NOTE: this iteration commits geometry as a plain group; persisting the
 * generator id + parameter blob for in-place *editing* of the feature is the
 * next step and wants a small document field — deliberately out of scope here.
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
  doc.emitChange();

  return { group, handles, sketch };
}
