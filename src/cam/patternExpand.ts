import type { CADDocument } from "../model/document";
import type { CAMOperation } from "./types";

/**
 * Expand an operation's `entityIds` to cover whole patterns: if the op
 * references ANY member of a pattern (its source or any instance), include every
 * member. So a toolpath assigned to patterned geometry automatically follows the
 * instance count — drill a bolt circle once and new holes are cut when the count
 * grows; removed instances drop out (pruned from the op on regen).
 *
 * Resolution happens at toolpath/preview time (generateGCode, rasterizeStock),
 * keeping the pattern the single source of truth; the op's stored `entityIds`
 * stay as authored. Returns the op unchanged when nothing is added.
 */
export function expandOpPatternTargets(op: CAMOperation, doc: CADDocument): CAMOperation {
  if (doc.patterns.length === 0 || op.entityIds.length === 0) return op;
  const ids = new Set(op.entityIds);
  let added = false;
  for (const pat of doc.patterns) {
    const members = [...pat.sourceIds, ...pat.instanceIds.flat()];
    if (members.some((m) => ids.has(m))) {
      for (const m of members) {
        if (!ids.has(m)) {
          ids.add(m);
          added = true;
        }
      }
    }
  }
  return added ? { ...op, entityIds: [...ids] } : op;
}
