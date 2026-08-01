/**
 * Press-drag-release as an alternative to click-then-click, for the two-point
 * drawing tools.
 *
 * RapidCAM's tools have always been click-then-click. That is the CAD
 * convention (Fusion, Onshape, AutoCAD), but the graphics and laser tools people
 * arrive from — Illustrator, Figma, and LightBurn above all — are drag-first, so
 * a drag produced nothing and left the tool waiting on a second point. Two of us
 * were caught by it independently, which is enough.
 *
 * The two gestures do not need a setting to tell apart: a click and a drag
 * differ by how far the pointer travelled between press and release. Inferring
 * it means the person who needs drag never has to discover an option, and the
 * person with click-then-click muscle memory notices nothing — a press and
 * release in the same spot is still a click, and still arms the second point.
 *
 * The mechanism is deliberately tiny. A tool records where its anchor was
 * pressed, and on release, if the pointer moved far enough, it re-enters its own
 * `onPointerDown` at the release position — so the drag completes through the
 * EXACT path a second click would take: same snapping (`ToolPointerEvent.world`
 * is already snapped), same degenerate-size guards, same typed-dimension
 * handling, same history entry. Nothing is duplicated, so nothing can drift.
 *
 * Three-or-more-point tools (arc, polyline, bezier, and the slot's
 * centre→centre→width) stay click-only: a drag has no meaning for them, and
 * completing only the first leg would be half a gesture.
 */

import type { Vec2 } from "../core/vec2";
import type { ToolPointerEvent } from "./tool";

/**
 * How far the pointer must travel between press and release, in CSS pixels, for
 * the gesture to count as a drag.
 *
 * Small enough that a deliberate drag always registers, large enough that a
 * shaky click does not — a click read as a drag would commit a near-zero-size
 * shape at the press point. Below the threshold the gesture falls through to
 * "arm the second point", which is also what keeps degenerate shapes out
 * without a separate minimum-size rule.
 */
export const DRAG_THRESHOLD_PX = 4;

/**
 * Did this release complete a drag that began at `anchorScreen`?
 *
 * `null` means no anchor is pending — the tool is idle, or its anchor was placed
 * by something other than a press (so there is no drag in progress to finish).
 */
export function isDragRelease(anchorScreen: Vec2 | null, e: ToolPointerEvent): boolean {
  if (!anchorScreen) return false;
  return Math.hypot(e.screen.x - anchorScreen.x, e.screen.y - anchorScreen.y) >= DRAG_THRESHOLD_PX;
}
