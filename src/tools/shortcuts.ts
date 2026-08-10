/**
 * Single-key shortcuts that activate a tool (key → tool id). One source of
 * truth, shared by the keyboard handler in app.ts and the tool-palette
 * tooltips, so a shortcut and its tooltip can never drift apart.
 */
export const TOOL_SHORTCUTS: Record<string, string> = {
  v: "select",
  l: "line",
  r: "rect",
  c: "circle",
  a: "arc",
  p: "polyline",
  d: "dimension",
  i: "measure",
  o: "offset",
  b: "bezier",
  q: "rotate",
  s: "scale",
  // NB: no "text" binding — "x" is the construction-geometry toggle (Fusion
  // convention; see App.onKeyDown), which intercepts the key first. Pick a
  // free key here if Text ever needs a shortcut.
  f: "fillet",
  t: "trim",
  e: "extend",
  m: "mirror",
  u: "slot",
  n: "polygon",
};

/**
 * Tools that offer **Type to Draw** — the floating field that opens mid-tool so
 * an exact value can be typed instead of clicking the next point. The keyboard
 * twin of drag-to-draw (dragDraw.ts).
 *
 * One source of truth, because the in-app help has twice advertised typed input
 * for tools that never had any (Circle's "enter exact diameter in the input
 * HUD"; Rotate's "enter angle") while saying nothing about the tools that did.
 * `test/typeToDraw.test.ts` drives every tool named here and fails if its field
 * does not actually open — so the list cannot become a claim again.
 */
export const TYPE_TO_DRAW_TOOLS: readonly string[] = [
  "line",
  "rect",
  "circle",
  "arc",
  "polygon",
  "slot",
  "fillet",
  "chamfer",
];

/**
 * One-line status-bar hint per tool: what to click next and the modifiers worth
 * knowing. Kept deliberately static (no per-state machinery) and honest — each
 * line matches the tool's actual first-interaction flow.
 */
export const TOOL_HINTS: Record<string, string> = {
  select:
    "Drag = move · Shift+drag = marquee · Ctrl+click = pick points · double-click = chain select",
  line: "Click start then end, or drag · Shift = ortho · type for an exact length/angle",
  rect: "Click two corners, or drag",
  circle: "Click the centre then a point on it, or drag out · type for an exact diameter",
  arc: "Click centre → start → end · Tab flips direction",
  polyline: "Click vertices · Esc or double-click finishes",
  dimension: "Click two points (or a circle), then place the dimension",
  measure: "Click two points to measure",
  offset: "Click an entity, then click the side to offset to",
  bezier: "Click start and end, then the two curve handles",
  rotate: "Select objects first, then drag to rotate them",
  scale: "Select objects first, then drag to scale them",
  text: "Set the text in the dialog, then click the canvas to stamp it",
  fillet: "Click two lines that meet (or a polyline corner) to round",
  chamfer: "Click two lines that meet (or a polyline corner) to bevel",
  trim: "Click the segment you want removed",
  extend: "Click near an entity's end to extend it to the next boundary",
  mirror: "Select objects first · click two points to define the mirror axis",
  slot: "Click the two slot centres, then set the width",
  polygon: "Click the centre then a vertex, or drag out",
};

const byTool: Record<string, string> = Object.fromEntries(
  Object.entries(TOOL_SHORTCUTS).map(([key, id]) => [id, key.toUpperCase()]),
);

/** The uppercase shortcut key for a tool id, or undefined if it has none. */
export function shortcutForTool(id: string): string | undefined {
  return byTool[id];
}
