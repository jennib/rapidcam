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

import { EntityId } from "./entities";
import { nextId } from "./ids";

export interface LinearPatternParams {
  countX: number;
  countY: number;
  spacingX: number; // mm
  spacingY: number; // mm
  spacingXExpr?: string; // optional variable expression, e.g. "pitch"
  spacingYExpr?: string;
}

export interface CircularPatternParams {
  count: number;
  cx: number; // rotation centre X (mm)
  cy: number; // rotation centre Y (mm)
  totalAngle: number; // radians — 2π means full circle
}

export interface PatternDef {
  id: string;
  kind: "linear" | "circular";
  /** The original entity IDs (not touched when re-applying). */
  sourceIds: EntityId[];
  /** One sub-array per generated instance (step), each listing that step's entity IDs. */
  instanceIds: EntityId[][];
  params: LinearPatternParams | CircularPatternParams;
}

export function makeLinearPattern(
  sourceIds: EntityId[],
  instanceIds: EntityId[][],
  params: LinearPatternParams,
): PatternDef {
  return { id: nextId("pat"), kind: "linear", sourceIds, instanceIds, params };
}

export function makeCircularPattern(
  sourceIds: EntityId[],
  instanceIds: EntityId[][],
  params: CircularPatternParams,
): PatternDef {
  return { id: nextId("pat"), kind: "circular", sourceIds, instanceIds, params };
}

export function clonePatternDef(p: PatternDef): PatternDef {
  return {
    id: p.id,
    kind: p.kind,
    sourceIds: [...p.sourceIds],
    instanceIds: p.instanceIds.map((inst) => [...inst]),
    params: { ...p.params },
  };
}
