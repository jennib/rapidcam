/** Inline SVG icons for tool-palette buttons. 24×24, currentColor stroke. */

const wrap = (inner: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ` +
  `stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

export const ICONS = {
  select: wrap('<path d="M5 3l6 14 2-5 5-2z"/>'),
  line: wrap('<line x1="5" y1="19" x2="19" y2="5"/><circle cx="5" cy="19" r="1.6" fill="currentColor"/><circle cx="19" cy="5" r="1.6" fill="currentColor"/>'),
  rect: wrap('<rect x="4" y="6" width="16" height="12" rx="0.5"/>'),
  circle: wrap('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/>'),
  polyline: wrap('<polyline points="4,18 9,8 14,14 20,5"/>'),
  dimension: wrap('<path d="M4 7v10M20 7v10"/><path d="M4 12h16"/><path d="M7 9l-3 3 3 3M17 9l3 3-3 3"/>'),
} as const;
