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

const byTool: Record<string, string> = Object.fromEntries(
  Object.entries(TOOL_SHORTCUTS).map(([key, id]) => [id, key.toUpperCase()]),
);

/** The uppercase shortcut key for a tool id, or undefined if it has none. */
export function shortcutForTool(id: string): string | undefined {
  return byTool[id];
}
