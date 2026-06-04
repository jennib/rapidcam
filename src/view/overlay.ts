/** Transient visuals layered on top of the document: tool previews, snap marker, selection box. */

import { Vec2 } from "../core/vec2";
import { SnapPoint, EntityId, Bounds } from "../model/entities";

export type PreviewShape =
  | { kind: "line"; a: Vec2; b: Vec2 }
  | { kind: "circle"; center: Vec2; radius: number }
  | { kind: "arc"; center: Vec2; radius: number; startAngle: number; endAngle: number }
  | { kind: "bezier"; p0: Vec2; p1: Vec2; p2: Vec2; p3: Vec2 }
  | { kind: "rect"; p0: Vec2; p1: Vec2 }
  | { kind: "polyline"; points: Vec2[]; closed: boolean }
  | { kind: "point"; pos: Vec2 };

export interface TransformHandle {
  type: "scale" | "rotate";
  pos: Vec2; // world coords
  id: string; // "nw", "n", "ne", "e", "se", "s", "sw", "w", "rot"
}

export interface TransformBox {
  bounds: Bounds;
  handles: TransformHandle[];
}

export interface Overlay {
  /** In-progress geometry drawn in the preview style. */
  previews: PreviewShape[];
  /** Active snap point to highlight, if any. */
  snap: SnapPoint | null;
  /** Rubber-band selection rectangle, in world coords. */
  selectionRect: { a: Vec2; b: Vec2 } | null;
  /** Entity currently under the cursor. */
  hover: EntityId | null;
  /** Interactive transform handles (drawn in fixed screen size) */
  transformBox?: TransformBox | null;
}

export function emptyOverlay(): Overlay {
  return { previews: [], snap: null, selectionRect: null, hover: null };
}
