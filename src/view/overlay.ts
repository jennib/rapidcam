/** Transient visuals layered on top of the document: tool previews, snap marker, selection box. */

import type { Vec2 } from "../core/vec2";
import type { SnapPoint, EntityId, Bounds } from "../model/entities";

export type PreviewShape =
  | { kind: "line"; a: Vec2; b: Vec2 }
  | { kind: "circle"; center: Vec2; radius: number }
  | { kind: "arc"; center: Vec2; radius: number; startAngle: number; endAngle: number }
  | { kind: "bezier"; p0: Vec2; p1: Vec2; p2: Vec2; p3: Vec2 }
  | { kind: "rect"; p0: Vec2; p1: Vec2 }
  | { kind: "polyline"; points: Vec2[]; closed: boolean }
  | { kind: "point"; pos: Vec2 }
  /** Screen-space hint label anchored to a world position (px offset applied after projection). */
  | { kind: "text"; pos: Vec2; text: string; dx?: number; dy?: number };

export interface TransformHandle {
  type: "scale" | "rotate" | "scale-arrow";
  pos: Vec2; // world coords
  id: string; // "nw", "n", "ne", "e", "se", "s", "sw", "w", "rot", "rot-nw", "rot-ne", "rot-sw", "rot-se", "scale-a", etc.
  stem?: boolean; // draw a stem line from the selection box top-center to this handle
}

export interface TransformBox {
  bounds: Bounds;
  handles: TransformHandle[];
  hideBox?: boolean;
  polygon?: Vec2[]; // optional oriented bounding box
}

/** A located DXF-import problem, drawn as a fixed-size marker (see Babel / dxfRepair). */
export interface DiagnosticMarker {
  pos: Vec2; // world coords
  kind: "gap" | "open-contour" | "duplicate" | "degenerate";
}

/** Stitch tiled-milling preview: the tile grid and registration features (world coords). */
export interface StitchPreview {
  tiles: Bounds[];
  features: Vec2[];
}

/** Flip (double-sided) preview: the flip axis line and registration pin holes (world coords). */
export interface FlipPreview {
  /** The mirror line the flip reflects about. */
  axis: { a: Vec2; b: Vec2 };
  /** Registration pin-hole centres. */
  pins: Vec2[];
}

export interface Overlay {
  /** In-progress geometry drawn in the preview style. */
  previews: PreviewShape[];
  /** Located import problems to highlight (Babel diagnose mode), if any. */
  diagnostics?: DiagnosticMarker[] | null;
  /** Stitch tiled-milling preview (tile grid + registration features), if any. */
  stitchPreview?: StitchPreview | null;
  /** Flip (double-sided) preview (flip axis + registration pins), if any. */
  flipPreview?: FlipPreview | null;
  /** Active snap point to highlight, if any. */
  snap: SnapPoint | null;
  /** Rubber-band selection rectangle, in world coords. */
  selectionRect: { a: Vec2; b: Vec2; crossing: boolean } | null;
  /** Entity currently under the cursor. */
  hover: EntityId | null;
  /** Constraint currently under the cursor. */
  hoverConstraint: string | null;
  /** Dimension currently under the cursor. */
  hoverDimension?: string | null;
  /** Interactive transform handles (drawn in fixed screen size) */
  transformBox?: TransformBox | null;
}

export function emptyOverlay(): Overlay {
  return { previews: [], snap: null, selectionRect: null, hover: null, hoverConstraint: null, hoverDimension: null };
}
