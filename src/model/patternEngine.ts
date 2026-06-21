/**
 * Headless pattern application & regeneration — no DOM, so it's unit-testable
 * and shared by the pattern dialogs (create / re-apply) and the app's
 * stale-pattern regeneration.
 *
 * Regeneration is STABLE: instances are addressed by a structural key
 * (linear → "row,col", circular → "k") and reconciled against the existing
 * copies. A surviving key keeps its instance entities (same ids, geometry
 * refreshed in place); a new key spawns copies; a dropped key removes only its
 * copies. So references to surviving copies (constraints, dimensions, CAM ops)
 * survive a count/spacing change, and growing 5→10 keeps the first copies intact.
 */

import type { CADDocument } from "./document";
import { Entity, EntityId } from "./entities";
import { applyRotate } from "../core/transform";
import { varMap } from "./variables";
import { evalExpr } from "../core/expr";
import {
  PatternDef,
  LinearPatternParams,
  CircularPatternParams,
  makeLinearPattern,
  makeCircularPattern,
  computeSourceSnapshot,
} from "./patterns";

interface Step {
  key: string;
  copies: Entity[];
}

// ---------------------------------------------------------------------------
// Expression resolution — refresh the numeric caches from *Expr fields against
// the document's current variables. The engine is the source of truth at
// create / regen / load time, so a pattern always reflects the latest variable
// values (including its count).

function resolveExpr(expr: string | undefined, cached: number, vm: ReadonlyMap<string, number>): number {
  if (!expr) return cached;
  const v = evalExpr(expr, vm);
  return v !== null && isFinite(v) ? v : cached; // keep last good value on a bad/unknown expr
}

function resolveLinearParams(doc: CADDocument, p: LinearPatternParams): LinearPatternParams {
  const vm = varMap(doc.variables);
  return {
    ...p,
    countX: Math.max(1, Math.round(resolveExpr(p.countXExpr, p.countX, vm))),
    countY: Math.max(1, Math.round(resolveExpr(p.countYExpr, p.countY, vm))),
    spacingX: resolveExpr(p.spacingXExpr, p.spacingX, vm),
    spacingY: resolveExpr(p.spacingYExpr, p.spacingY, vm),
  };
}

function resolveCircularParams(doc: CADDocument, p: CircularPatternParams): CircularPatternParams {
  const vm = varMap(doc.variables);
  return { ...p, count: Math.max(2, Math.round(resolveExpr(p.countExpr, p.count, vm))) };
}

// ---------------------------------------------------------------------------
// Public API

export function createLinearPattern(
  doc: CADDocument,
  sourceIds: EntityId[],
  params: LinearPatternParams,
): PatternDef {
  const p = resolveLinearParams(doc, params);
  const sources = resolveSources(doc, sourceIds);
  const instanceIds = linearSteps(sources, p).map((s) => addCopies(doc, s.copies));
  const snap = computeSourceSnapshot(doc.entities, sourceIds);
  return doc.addPattern(makeLinearPattern(sourceIds, instanceIds, p, snap));
}

export function regenerateLinearPattern(
  doc: CADDocument,
  pat: PatternDef,
  params: LinearPatternParams,
): void {
  const sources = resolveSources(doc, pat.sourceIds);
  if (sources.length === 0) return;
  const p = resolveLinearParams(doc, params);
  const oldMap = linearKeyMap(pat);
  const instanceIds = reconcile(doc, oldMap, linearSteps(sources, p));
  const sourceSnapshot = computeSourceSnapshot(doc.entities, pat.sourceIds);
  doc.updatePattern(pat.id, { instanceIds, params: p, sourceSnapshot });
}

export function createCircularPattern(
  doc: CADDocument,
  sourceIds: EntityId[],
  params: CircularPatternParams,
): PatternDef {
  const p = resolveCircularParams(doc, params);
  const sources = resolveSources(doc, sourceIds);
  const instanceIds = circularSteps(sources, p).map((s) => addCopies(doc, s.copies));
  const snap = computeSourceSnapshot(doc.entities, sourceIds);
  return doc.addPattern(makeCircularPattern(sourceIds, instanceIds, p, snap));
}

export function regenerateCircularPattern(
  doc: CADDocument,
  pat: PatternDef,
  params: CircularPatternParams,
): void {
  const sources = resolveSources(doc, pat.sourceIds);
  if (sources.length === 0) return;
  const p = resolveCircularParams(doc, params);
  const oldMap = circularKeyMap(pat);
  const instanceIds = reconcile(doc, oldMap, circularSteps(sources, p));
  const sourceSnapshot = computeSourceSnapshot(doc.entities, pat.sourceIds);
  doc.updatePattern(pat.id, { instanceIds, params: p, sourceSnapshot });
}

/**
 * Re-apply all patterns whose instances are stale relative to current source
 * geometry / params. Safe with an empty set (no-op). Caller does pushHistory()
 * before and solve()/emitChange() after.
 */
export function regenerateAllStalePatterns(doc: CADDocument, staleIds: Set<string>): void {
  for (const pat of [...doc.patterns]) {
    if (!staleIds.has(pat.id)) continue;
    if (pat.kind === "linear") {
      regenerateLinearPattern(doc, pat, pat.params as LinearPatternParams);
    } else {
      regenerateCircularPattern(doc, pat, pat.params as CircularPatternParams);
    }
  }
}

/**
 * True if a pattern's expression-driven params resolve to something other than
 * its cached values — i.e. a referenced variable changed. Patterns with no
 * `*Expr` are never param-stale (resolved === cached).
 */
export function isParamStale(doc: CADDocument, pat: PatternDef): boolean {
  if (pat.kind === "linear") {
    const p = pat.params as LinearPatternParams;
    const r = resolveLinearParams(doc, p);
    return r.countX !== p.countX || r.countY !== p.countY
      || r.spacingX !== p.spacingX || r.spacingY !== p.spacingY;
  }
  const p = pat.params as CircularPatternParams;
  return resolveCircularParams(doc, p).count !== p.count;
}

/**
 * Regenerate every pattern whose expression-driven params have drifted from
 * their cache (a variable changed). Returns whether anything changed. The
 * caller owns the history transaction.
 */
export function regenerateParamStalePatterns(doc: CADDocument): boolean {
  let changed = false;
  for (const pat of [...doc.patterns]) {
    if (!isParamStale(doc, pat)) continue;
    if (pat.kind === "linear") {
      regenerateLinearPattern(doc, pat, pat.params as LinearPatternParams);
    } else {
      regenerateCircularPattern(doc, pat, pat.params as CircularPatternParams);
    }
    changed = true;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Step builders (the source-of-truth for instance ordering & keys)

function linearSteps(sources: Entity[], p: LinearPatternParams): Step[] {
  const steps: Step[] = [];
  for (let row = 0; row < p.countY; row++) {
    for (let col = 0; col < p.countX; col++) {
      if (row === 0 && col === 0) continue;
      const copies = sources.map((src) => {
        const c = src.duplicate();
        c.translate({ x: col * p.spacingX, y: row * p.spacingY });
        return c;
      });
      steps.push({ key: `${row},${col}`, copies });
    }
  }
  return steps;
}

function circularSteps(sources: Entity[], p: CircularPatternParams): Step[] {
  const step = p.totalAngle / p.count;
  const steps: Step[] = [];
  for (let k = 1; k < p.count; k++) {
    const copies = sources.map((src) => src.duplicate());
    applyRotate(copies, p.cx, p.cy, k * step);
    steps.push({ key: `${k}`, copies });
  }
  return steps;
}

// Rebuild the structural-key → instance-ids map from an existing pattern, using
// its CURRENT (pre-update) params so keys line up with how the instances were
// last spawned. Must mirror the step builders' ordering exactly.
function linearKeyMap(pat: PatternDef): Map<string, EntityId[]> {
  const p = pat.params as LinearPatternParams;
  const map = new Map<string, EntityId[]>();
  let i = 0;
  for (let row = 0; row < p.countY; row++) {
    for (let col = 0; col < p.countX; col++) {
      if (row === 0 && col === 0) continue;
      if (i < pat.instanceIds.length) map.set(`${row},${col}`, pat.instanceIds[i]);
      i++;
    }
  }
  return map;
}

function circularKeyMap(pat: PatternDef): Map<string, EntityId[]> {
  const p = pat.params as CircularPatternParams;
  const map = new Map<string, EntityId[]>();
  for (let k = 1; k < p.count; k++) {
    if (k - 1 < pat.instanceIds.length) map.set(`${k}`, pat.instanceIds[k - 1]);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Reconciliation

function reconcile(doc: CADDocument, oldMap: Map<string, EntityId[]>, steps: Step[]): EntityId[][] {
  const used = new Set<EntityId>();
  const instanceIds = steps.map((step) => {
    const existing = oldMap.get(step.key);
    if (existing && existing.length === step.copies.length) {
      // Surviving key: refresh geometry in place, keep ids.
      return step.copies.map((copy, i) => {
        const id = existing[i];
        doc.replaceInstanceEntity(id, copy);
        used.add(id);
        return id;
      });
    }
    // New key (or source-count change): spawn fresh copies.
    return addCopies(doc, step.copies);
  });

  // Remove any old instance entities whose key no longer exists.
  const removed: EntityId[] = [];
  for (const ids of oldMap.values()) {
    for (const id of ids) if (!used.has(id)) removed.push(id);
  }
  if (removed.length) doc.batchRemove(removed);

  return instanceIds;
}

// ---------------------------------------------------------------------------
// Helpers

function resolveSources(doc: CADDocument, ids: EntityId[]): Entity[] {
  return ids.map((id) => doc.entities.find((e) => e.id === id)).filter(Boolean) as Entity[];
}

function addCopies(doc: CADDocument, copies: Entity[]): EntityId[] {
  return copies.map((c) => {
    doc.add(c);
    return c.id;
  });
}
