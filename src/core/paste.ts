/**
 * Placement geometry for paste/duplicate. Kept as a pure function (no App/doc
 * state) so the cascade behaviour is unit-testable without a live editor.
 */

import type { Entity } from "../model/entities";
import type { Vec2 } from "./vec2";
import { selectionBounds } from "./transform";

/** Offset applied to pasted/duplicated copies so they don't hide the original. */
export const PASTE_OFFSET_MM = 5;

/**
 * Produce placed clones of `sources` for a paste.
 *
 * - `at` given: the clones' bounds are centred on `at` (paste-at-cursor); `count`
 *   is ignored.
 * - `at` omitted: the clones are offset from the source by `count * PASTE_OFFSET_MM`
 *   so successive plain pastes **cascade** rather than stacking exactly on top of
 *   one another. `count` is 1-based (1 = first paste of the current clipboard).
 *
 * Never mutates `sources` — only the returned clones are translated.
 */
export function placePasteClones(sources: Entity[], count: number, at?: Vec2): Entity[] {
  const clones = sources.map((c) => c.duplicate());
  if (at) {
    const b = selectionBounds(clones);
    if (b) {
      const d = { x: at.x - (b.min.x + b.max.x) / 2, y: at.y - (b.min.y + b.max.y) / 2 };
      for (const c of clones) c.translate(d);
    }
  } else {
    const dx = PASTE_OFFSET_MM * count;
    for (const c of clones) c.translate({ x: dx, y: -dx });
  }
  return clones;
}
