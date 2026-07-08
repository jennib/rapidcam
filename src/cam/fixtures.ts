/**
 * Workholding fixtures — the closed shapes drawn on a layer flagged `fixture`
 * (a clamp, a toe dog, a hold-down). They are NOT machined; instead the pre-flight
 * treats each footprint as a keep-out and flags any move that would drive the tool
 * (or holder) into it below the clamp's height. See cam/lint.ts (checkFixtures).
 */

import type { Vec2 } from "../core/vec2";
import type { CADDocument } from "../model/document";
import { collectClosedLoops } from "./loops";

/** A clamp footprint (work/canvas mm) and how far it stands above the stock top (mm). */
export interface Fixture {
  poly: Vec2[];
  /** Height above the stock top; +Infinity when the layer left it unset (blocks any pass). */
  height: number;
}

/**
 * Every fixture footprint in the document: the closed loops of the geometry on each
 * `fixture` layer, paired with that layer's `fixtureHeight`. Empty when no layer is
 * flagged. Coordinates are work/canvas mm (the caller shifts to emitted coords).
 */
export function fixturePolygons(doc: CADDocument): Fixture[] {
  const heights = new Map<string, number>();
  for (const l of doc.layers) {
    if (l.fixture) heights.set(l.id, l.fixtureHeight && l.fixtureHeight > 0 ? l.fixtureHeight : Number.POSITIVE_INFINITY);
  }
  if (heights.size === 0) return [];

  const out: Fixture[] = [];
  for (const [layerId, height] of heights) {
    const ents = doc.entities.filter((e) => e.layerId === layerId && !e.isConstruction);
    for (const loop of collectClosedLoops(ents)) out.push({ poly: loop.verts, height });
  }
  return out;
}
