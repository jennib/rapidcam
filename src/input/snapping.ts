/**
 * Snap resolution.
 *
 * Given the raw cursor position, returns where the cursor should actually be
 * placed. Object snaps (endpoints, midpoints, centres, …) win when the cursor is
 * within a pixel tolerance; otherwise, if grid snapping is on, the cursor snaps
 * to the nearest minor grid intersection.
 */

import { Vec2, dist } from "../core/vec2";
import { SnapPoint, EntityId } from "../model/entities";
import { CADDocument } from "../model/document";
import { Viewport } from "../view/viewport";
import { computeGrid } from "../view/grid";
import { intersectionsNear } from "../core/intersect";

/** Clamp `raw` to the nearest cardinal axis (H or V) through `start`. */
export function orthoSnap(start: Vec2, raw: Vec2): Vec2 {
  const dx = raw.x - start.x;
  const dy = raw.y - start.y;
  return Math.abs(dx) >= Math.abs(dy)
    ? { x: raw.x, y: start.y }
    : { x: start.x, y: raw.y };
}

export interface SnapResult {
  /** Final world position to use. */
  world: Vec2;
  /** Object snap that was hit, if any (for the on-screen marker). */
  snap: SnapPoint | null;
}

export class SnapEngine {
  gridEnabled = true;
  objectSnapEnabled = true;
  /** Object-snap pickup radius in screen pixels. */
  pixelTolerance = 10;

  resolve(
    screen: Vec2,
    view: Viewport,
    doc: CADDocument,
    exclude?: Set<EntityId>,
  ): SnapResult {
    const rawWorld = view.screenToWorld(screen);

    // 1) Object snaps (highest priority).
    if (this.objectSnapEnabled) {
      let best: SnapPoint | null = null;
      let bestPx = this.pixelTolerance;
      for (const sp of doc.snapPoints(exclude)) {
        const d = dist(view.worldToScreen(sp.pos), screen);
        if (d <= bestPx) {
          bestPx = d;
          best = sp;
        }
      }
      // Intersection snaps rank just below exact points: a real vertex on/near
      // the crossing keeps priority (strict <), but otherwise the crossing wins.
      const tolWorld = view.toWorldLen(this.pixelTolerance);
      for (const p of intersectionsNear(this.snappableEntities(doc, exclude), rawWorld, tolWorld)) {
        const d = dist(view.worldToScreen(p), screen);
        if (d < bestPx) {
          bestPx = d;
          best = { pos: { ...p }, kind: "intersection", entityId: "" };
        }
      }
      if (best) return { world: { ...best.pos }, snap: best };
    }

    // 2) Grid snap to nearest minor intersection.
    if (this.gridEnabled) {
      const step = computeGrid(view.scale, doc.displayUnit).minorMM;
      return {
        world: {
          x: Math.round(rawWorld.x / step) * step,
          y: Math.round(rawWorld.y / step) * step,
        },
        snap: null,
      };
    }

    return { world: rawWorld, snap: null };
  }

  /** Entities eligible for intersection snapping: visible layers, not excluded. */
  private snappableEntities(doc: CADDocument, exclude?: Set<EntityId>) {
    return doc.entities.filter((e) => {
      if (exclude?.has(e.id)) return false;
      const layer = doc.layers.find((l) => l.id === e.layerId) || doc.layers[0];
      return layer.visible;
    });
  }
}
