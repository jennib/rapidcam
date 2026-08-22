/**
 * The tool reference table — **one** row per tool, holding every fact the UI
 * needs to describe it: its single-key shortcut, its display name, its
 * status-bar hint, and whether it offers Type to Draw.
 *
 * This used to be three parallel `Record`s keyed by the same tool ids, plus a
 * fourth hand-written copy of all of it in the help dialog. That is the defect
 * class this repo keeps hitting — one fact written down several times with
 * nothing making the copies agree — and it had already gone wrong: the help
 * advertised typed input for tools that had none (Circle, Rotate) while saying
 * nothing about the three that had it, and the hints for Rect, Arc, Slot,
 * Fillet, Chamfer and Polygon never mentioned typing either.
 *
 * So: add a tool here and everywhere describes it. The keyboard handler, the
 * palette tooltips, the `?` overlay and the F1 help all read this table, and
 * `test/toolReference.test.ts` checks each row against the tool's own class.
 */

export interface ToolReference {
  /** Single-key shortcut, lowercase. Absent for tools with no binding. */
  key?: string;
  /** Display name. Must equal the Tool class's own `label` — guarded. */
  label: string;
  /**
   * One-line status-bar hint: what to click next and the modifiers worth
   * knowing. Deliberately static (no per-state machinery) and honest — each
   * line matches the tool's actual first-interaction flow. Keep them SHORT:
   * the status bar carries cursor, zoom, notify, hint and the snap toggles on
   * one row, and a long hint plus a refusal message wraps it to two lines.
   */
  hint: string;
  /**
   * Whether the tool offers **Type to Draw** — the floating field that opens
   * mid-gesture so an exact value can be typed instead of clicking the next
   * point. The keyboard twin of drag-to-draw (dragDraw.ts).
   *
   * `test/typeToDraw.test.ts` drives every tool flagged here and fails if its
   * field does not actually open, so this cannot become a claim again.
   */
  typeToDraw?: boolean;
}

export const TOOLS: Record<string, ToolReference> = {
  select: {
    key: "v",
    label: "Select",
    hint: "Drag = move · Shift+drag = marquee · Ctrl+click = pick points · double-click = chain select",
  },
  line: {
    key: "l",
    label: "Line",
    hint: "Click start then end, or drag · Shift = ortho · type for an exact length/angle",
    typeToDraw: true,
  },
  polyline: {
    key: "p",
    label: "Polyline",
    hint: "Click vertices, or type a length/angle for each · Enter finishes · click the start to close",
    typeToDraw: true,
  },
  rect: {
    key: "r",
    label: "Rectangle",
    hint: "Click two corners, or drag · Alt = from centre · type for an exact W×H",
    typeToDraw: true,
  },
  circle: {
    key: "c",
    label: "Circle",
    hint: "Click the centre then a point on it, or drag out · type for an exact diameter",
    typeToDraw: true,
  },
  arc: {
    key: "a",
    label: "Arc",
    hint: "Click centre → start → end · Tab flips direction · type for an exact arc length",
    typeToDraw: true,
  },
  bezier: {
    key: "b",
    label: "Bezier",
    hint: "Click start and end — or type the chord — then the two curve handles",
    typeToDraw: true,
  },
  polygon: {
    key: "n",
    label: "Polygon",
    hint: "Click the centre then a vertex, or drag out · type the sides and diameter",
    typeToDraw: true,
  },
  slot: {
    key: "u",
    label: "Slot",
    hint: "Click the two slot centres, then drag or type the width",
    typeToDraw: true,
  },
  // No key: "x" is the construction-geometry toggle (Fusion convention, see
  // App.onKeyDown) and intercepts it first. Pick a free key if Text needs one.
  text: {
    label: "Text",
    hint: "Click where to place the text, then type it and set the font in the dialog",
  },
  fillet: {
    key: "f",
    label: "Fillet",
    // "corner" rather than "two lines that meet": a rectangle corner is one of
    // the three things this works on, and on a rectangle it sets an editable
    // radius rather than cutting the shape up.
    hint: "Click a corner to round it · drag or type the radius · Shift = every corner of the shape",
    typeToDraw: true,
  },
  // No key: "c" is Circle. Chamfer lives on the toolbar and the context menu.
  chamfer: {
    label: "Chamfer",
    hint: "Click a corner to bevel it · drag or type the distance",
    typeToDraw: true,
  },
  trim: { key: "t", label: "Trim", hint: "Click the segment you want removed" },
  extend: {
    key: "e",
    label: "Extend",
    hint: "Click near an entity's end to extend it to the next boundary",
  },
  offset: {
    key: "o",
    label: "Offset",
    hint: "Click an entity, then click the side to offset to",
  },
  mirror: {
    key: "m",
    label: "Mirror",
    hint: "Select objects first · click two points to define the mirror axis",
  },
  rotate: {
    key: "q",
    label: "Rotate",
    hint: "Select objects first, then drag to rotate them",
  },
  scale: {
    key: "s",
    label: "Scale",
    hint: "Select objects first, then drag to scale them",
  },
  dimension: {
    key: "d",
    label: "Dimension",
    hint: "Click anywhere on two objects (or a circle), then place the dimension",
  },
  measure: { key: "i", label: "Measure", hint: "Click two points to measure" },
};

/** Single-key shortcuts as key → tool id, for the keyboard handler. */
export const TOOL_SHORTCUTS: Record<string, string> = Object.fromEntries(
  Object.entries(TOOLS)
    .filter(([, t]) => t.key)
    .map(([id, t]) => [t.key as string, id]),
);

/** Status-bar hint per tool id. */
export const TOOL_HINTS: Record<string, string> = Object.fromEntries(
  Object.entries(TOOLS).map(([id, t]) => [id, t.hint]),
);

/** Tool ids that offer Type to Draw. */
export const TYPE_TO_DRAW_TOOLS: readonly string[] = Object.entries(TOOLS)
  .filter(([, t]) => t.typeToDraw)
  .map(([id]) => id);

/** The uppercase shortcut key for a tool id, or undefined if it has none. */
export function shortcutForTool(id: string): string | undefined {
  return TOOLS[id]?.key?.toUpperCase();
}

/**
 * Rows for the F1 help's tool table and the `?` overlay: `[KEY, Name, What it does]`,
 * keyed tools first in table order. Generated rather than written out, because
 * the hand-written copy is what drifted.
 */
export function toolReferenceRows(): [string, string, string][] {
  return Object.entries(TOOLS)
    .filter(([, t]) => t.key)
    .map(([, t]) => [(t.key as string).toUpperCase(), `${t.label} Tool`, t.hint]);
}
