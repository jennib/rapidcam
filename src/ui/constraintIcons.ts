/**
 * Stroke SVG icons for the constraint types, drawn in the same 24x24
 * currentColor style as tools/icons.ts and ui/stateIcons.ts. They replace the
 * mixed-character CONSTRAINT_GLYPH (letters H/V/T/M, emoji-ish ⚓ / ◀▶) on the
 * HTML surfaces — the constraint bar and the design tree — with one consistent
 * drawn symbol per type.
 *
 * Stroke width 2 matches the tool icons (`.tool-btn svg` sets stroke-width: 2),
 * and each glyph is drawn to fill the 24x24 box so a constraint button reads as
 * the same visual weight as a tool button.
 *
 * The canvas renderer keeps CONSTRAINT_GLYPH text badges: a canvas cannot draw
 * SVG, and those badges are tiny and conventional. This is the same "one fact,
 * two renderings" split the status bar already uses (html + short).
 */
import type { ConstraintType } from "../model/constraints";

const wrap = (inner: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

export const CONSTRAINT_ICONS: Record<ConstraintType, string> = {
  coincident: wrap(`<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/>`),
  horizontal: wrap(`<path d="M3 12h18"/>`),
  vertical: wrap(`<path d="M12 3v18"/>`),
  parallel: wrap(`<path d="M8 4l12 12"/><path d="M4 8l12 12"/>`),
  perpendicular: wrap(`<path d="M12 3v10h9"/>`),
  equal: wrap(`<path d="M4 9h16"/><path d="M4 15h16"/>`),
  concentric: wrap(`<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>`),
  pointOnLine: wrap(`<path d="M3 12h18"/><circle cx="17" cy="12" r="2.8" fill="currentColor" stroke="none"/>`),
  tangent: wrap(`<circle cx="7" cy="12" r="6"/><path d="M13 3v18"/>`),
  pointOnArc: wrap(`<path d="M5 19a8 8 0 0 1 14 0"/><circle cx="12" cy="10" r="2.6" fill="currentColor" stroke="none"/>`),
  pointOnCircle: wrap(`<circle cx="12" cy="12" r="9"/><circle cx="12" cy="3" r="2.6" fill="currentColor" stroke="none"/>`),
  symmetric: wrap(`<path d="M12 3v18" stroke-dasharray="3 3"/><rect x="3" y="8" width="6" height="8" rx="1"/><rect x="15" y="8" width="6" height="8" rx="1"/>`),
  collinear: wrap(`<path d="M3 12h6"/><path d="M15 12h6"/>`),
  midpoint: wrap(`<path d="M3 12h18"/><circle cx="12" cy="12" r="2.8" fill="currentColor" stroke="none"/>`),
  angle: wrap(`<path d="M4 20h16"/><path d="M4 20L20 4"/>`),
  fixedPoint: wrap(`<circle cx="12" cy="12" r="8"/><path d="M12 4v16M4 12h16"/>`),
  center: wrap(`<path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><circle cx="12" cy="12" r="3.5"/>`),
  fixed: wrap(`<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/><path d="M12 15v6"/><path d="M8 20h8"/>`),
};