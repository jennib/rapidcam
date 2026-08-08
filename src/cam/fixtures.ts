/**
 * Workholding fixtures — the closed shapes drawn on a layer flagged `fixture`
 * (a clamp, a toe dog, a hold-down). They are NOT machined; instead the pre-flight
 * treats each footprint as a keep-out and flags any move that would drive the tool
 * (or holder) into it below the clamp's height. See cam/lint.ts (checkFixtures).
 */

import type { Vec2 } from "../core/vec2";
import type { CADDocument } from "../model/document";
import type { Entity } from "../model/entities";
import { collectClosedLoops } from "./loops";

/** A clamp footprint (work/canvas mm) and how far it stands above the stock top (mm). */
export interface Fixture {
  poly: Vec2[];
  /** Height above the stock top; +Infinity when nothing set one (blocks any pass). */
  height: number;
}

/** A positive, finite height, or null for "not set here". */
function usableHeight(h: number | undefined): number | null {
  return h !== undefined && h > 0 && Number.isFinite(h) ? h : null;
}

/**
 * How tall this clamp stands: the entity's own height if it has one, else the
 * layer's, else +Infinity.
 *
 * The per-entity height is what lets two clamps of different heights share one
 * fixture layer — the layer value went from being the only answer to being the
 * default for clamps that don't override it, so existing documents (which only
 * ever set the layer) resolve exactly as they did before.
 */
function resolveHeight(e: Entity, layerHeight: number | undefined): number {
  return usableHeight(e.fixtureHeight) ?? usableHeight(layerHeight) ?? Number.POSITIVE_INFINITY;
}

/**
 * Every fixture footprint in the document: the closed loops of the geometry on
 * each `fixture` layer, each paired with its own height. Empty when no layer is
 * flagged. Coordinates are work/canvas mm (the caller shifts to emitted coords).
 *
 * A loop can be several entities (four lines forming a rectangle), and they can
 * disagree about height. The TALLEST wins: a height is how far you must climb
 * to clear the thing, so taking the smallest would quietly under-report an
 * obstacle, and an under-reported clamp is one you drive into.
 */
export function fixturePolygons(doc: CADDocument): Fixture[] {
  const layerHeights = new Map<string, number | undefined>();
  for (const l of doc.layers) if (l.fixture) layerHeights.set(l.id, l.fixtureHeight);
  if (layerHeights.size === 0) return [];

  const out: Fixture[] = [];
  for (const [layerId, layerHeight] of layerHeights) {
    const ents = doc.entities.filter((e) => e.layerId === layerId && !e.isConstruction);
    const byId = new Map(ents.map((e) => [e.id, e]));
    for (const loop of collectClosedLoops(ents)) {
      let height = Number.NEGATIVE_INFINITY;
      for (const id of loop.ids) {
        const e = byId.get(id);
        if (e) height = Math.max(height, resolveHeight(e, layerHeight));
      }
      out.push({
        poly: loop.verts,
        // A loop whose members all vanished can't be measured; treat it as
        // unknown rather than as a zero-height (i.e. harmless) obstacle.
        height: Number.isFinite(height) && height > 0 ? height : Number.POSITIVE_INFINITY,
      });
    }
  }
  return out;
}
