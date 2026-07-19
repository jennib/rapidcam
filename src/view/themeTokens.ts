/**
 * Bridge between the CSS custom-property theme (the single source of truth for
 * color) and the 2D-canvas palette in `colors.ts`.
 *
 * The canvas needs concrete color strings — `ctx.fillStyle = "var(--bg)"` is
 * invalid — so we read the resolved token values once at startup and copy them
 * into `COLORS`. This removes the hand-synced duplication: a change to a CSS
 * variable (e.g. for a future light theme) now flows to the canvas automatically.
 */

/** Read a resolved CSS custom property off :root, or "" if unavailable. */
export function readToken(name: string): string {
  if (typeof document === "undefined" || !document.documentElement) return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
