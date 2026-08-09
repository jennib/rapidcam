/**
 * Facing / surfacing: skim a flat surface level.
 *
 * The one operation with no geometry to point at. Everything else in CAM cuts
 * something you drew; facing cuts the top of the blank — or the spoilboard —
 * so it takes its extent from the job rather than from the canvas, and needs no
 * rectangle drawn round it.
 *
 * It would be tempting to call this a pocket over a rectangle, and that gets
 * close: pocket already rasters, already steps down. The difference is one line
 * of geometry. A pocket insets the tool CENTRE by a radius so the cutting edge
 * stops exactly at the boundary — correct for a pocket, wrong for facing, where
 * the cutter has to run off the edge. Here the centre goes to the boundary and
 * the edge hangs a full radius past it, which is what actually cleans a corner
 * up when the blank is a millimetre bigger than you told the software or sits a
 * degree out of square.
 */

import type { Vec2 } from "../core/vec2";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Which way the rows run. */
export type FaceDirection = "x" | "y";

export interface FacePlan {
  /** Row paths in cutting order, alternating direction (a zig-zag). */
  rows: Vec2[][];
  /** The rectangle actually swept by the cutter's edge, for reporting. */
  swept: Rect;
}

/**
 * Grow a rectangle on every side.
 */
export function growRect(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, width: r.width + by * 2, height: r.height + by * 2 };
}

/**
 * Rows for one facing level.
 *
 * Tool-centre positions run corner to corner of `target` (plus any extra
 * `overhang`), so the cutting edge sweeps a tool radius beyond it on all four
 * sides. Rows alternate direction: a surfacing cut is a finish, and lifting to
 * return to the same side would mark the surface at every row end for no gain.
 *
 * `stepover` is a distance, and wants to be well under the tool diameter here —
 * a surfacing bit leaves a visible scallop between passes long before it leaves
 * uncut stock.
 */
export function facePlan(
  target: Rect,
  toolR: number,
  stepover: number,
  overhang = 0,
  direction: FaceDirection = "x",
): FacePlan | null {
  if (toolR <= 0 || stepover <= 0) return null;
  if (target.width <= 0 || target.height <= 0) return null;

  const box = overhang > 0 ? growRect(target, overhang) : target;
  const rows: Vec2[][] = [];

  // Distance the rows advance across, and the span each row travels.
  const acrossMin = direction === "x" ? box.y : box.x;
  const acrossMax = direction === "x" ? box.y + box.height : box.x + box.width;
  const alongMin = direction === "x" ? box.x : box.y;
  const alongMax = direction === "x" ? box.x + box.width : box.y + box.height;

  // Centres span the box inclusively: the last row lands exactly on the far
  // edge rather than a stepover short of it, which would leave a strip.
  const span = acrossMax - acrossMin;
  const n = Math.max(1, Math.ceil(span / stepover));
  for (let i = 0; i <= n; i++) {
    const t = n === 0 ? 0 : i / n;
    const across = acrossMin + span * t;
    const forward = i % 2 === 0;
    const a = forward ? alongMin : alongMax;
    const b = forward ? alongMax : alongMin;
    rows.push(
      direction === "x"
        ? [
            { x: a, y: across },
            { x: b, y: across },
          ]
        : [
            { x: across, y: a },
            { x: across, y: b },
          ],
    );
  }

  return { rows, swept: growRect(box, toolR) };
}
