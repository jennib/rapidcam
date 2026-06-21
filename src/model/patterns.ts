/**
 * Parametric pattern definitions.
 *
 * A PatternDef records:
 *   - which entities are the "source" (the original selection)
 *   - which entity ID groups were generated as copies (one group per step)
 *   - the parameters used to create them
 *
 * Patterns are REGENERATABLE: re-opening the dialog deletes the existing copies
 * and recreates them from the live source geometry with the updated parameters.
 * Spacing fields accept numeric expressions that can reference document variables.
 */

import { EntityId, Entity } from "./entities";
import { nextId } from "./ids";

export interface LinearPatternParams {
  countX: number; // resolved cache of countXExpr (whole number, ≥1)
  countY: number;
  spacingX: number; // mm
  spacingY: number; // mm
  countXExpr?: string; // optional variable expression, e.g. "tabs" or "n + 1"
  countYExpr?: string;
  spacingXExpr?: string; // optional variable expression, e.g. "pitch"
  spacingYExpr?: string;
}

export interface CircularPatternParams {
  count: number; // resolved cache of countExpr (whole number, ≥2)
  cx: number; // rotation centre X (mm)
  cy: number; // rotation centre Y (mm)
  totalAngle: number; // radians — 2π means full circle
  countExpr?: string; // optional variable expression
}

export interface PatternDef {
  id: string;
  kind: "linear" | "circular";
  /** The original entity IDs (not touched when re-applying). */
  sourceIds: EntityId[];
  /** One sub-array per generated instance (step), each listing that step's entity IDs. */
  instanceIds: EntityId[][];
  params: LinearPatternParams | CircularPatternParams;
  /**
   * Hash of the source geometry at the time the pattern was last applied.
   * Undefined for patterns created before snapshotting was introduced.
   * Used to detect when source entities have moved and instances are stale.
   */
  sourceSnapshot?: number;
}

export function makeLinearPattern(
  sourceIds: EntityId[],
  instanceIds: EntityId[][],
  params: LinearPatternParams,
  sourceSnapshot?: number,
): PatternDef {
  return { id: nextId("pat"), kind: "linear", sourceIds, instanceIds, params, sourceSnapshot };
}

export function makeCircularPattern(
  sourceIds: EntityId[],
  instanceIds: EntityId[][],
  params: CircularPatternParams,
  sourceSnapshot?: number,
): PatternDef {
  return { id: nextId("pat"), kind: "circular", sourceIds, instanceIds, params, sourceSnapshot };
}

export function clonePatternDef(p: PatternDef): PatternDef {
  return {
    id: p.id,
    kind: p.kind,
    sourceIds: [...p.sourceIds],
    instanceIds: p.instanceIds.map((inst) => [...inst]),
    params: { ...p.params },
    sourceSnapshot: p.sourceSnapshot,
  };
}

/**
 * Compute a 32-bit fingerprint of the source entities' current DOF geometry.
 * Used to detect when instances are stale after source entities have moved.
 */
export function computeSourceSnapshot(entities: Entity[], sourceIds: EntityId[]): number {
  let h = 0x811c9dc5; // FNV-32 offset basis
  for (const id of sourceIds) {
    const ent = entities.find((e) => e.id === id);
    if (!ent) continue;
    for (const p of ent.dofPoints()) {
      const pt = ent.getPoint(p.key);
      h = (Math.imul(h, 0x01000193) ^ (Math.round(pt.x * 1e6) | 0)) | 0;
      h = (Math.imul(h, 0x01000193) ^ (Math.round(pt.y * 1e6) | 0)) | 0;
    }
    for (const s of ent.dofScalars()) {
      h = (Math.imul(h, 0x01000193) ^ (Math.round(s.value * 1e6) | 0)) | 0;
    }
  }
  return h;
}
