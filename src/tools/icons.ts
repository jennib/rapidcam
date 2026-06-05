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
  arc: wrap('<path d="M5 19 A10 10 0 0 1 19 5"/><circle cx="5" cy="19" r="1.4" fill="currentColor"/><circle cx="19" cy="5" r="1.4" fill="currentColor"/>'),
  offset: wrap('<circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="8.5"/>'),
  bezier: wrap('<path d="M4 18 C6 4 18 20 20 6"/><circle cx="4" cy="18" r="1.5" fill="currentColor"/><circle cx="20" cy="6" r="1.5" fill="currentColor"/><line x1="4" y1="18" x2="6" y2="4" opacity="0.5"/><line x1="20" y1="6" x2="18" y2="20" opacity="0.5"/>'),
  rotate: wrap('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>'),
  scale: wrap('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>'),
  // Two chevrons facing each other across a dashed axis — classic mirror symbol.
  mirror: wrap(
    '<line x1="12" y1="3" x2="12" y2="21" stroke-dasharray="2 2"/>' +
    '<polyline points="9,7 5,12 9,17"/>' +
    '<polyline points="15,7 19,12 15,17"/>',
  ),
  // Two lines meeting at a corner, with a rounded arc replacing the sharp vertex.
  fillet: wrap(
    '<line x1="4" y1="4" x2="4" y2="12"/>' +
    '<path d="M4,12 A8,8 0 0,1 12,20"/>' +
    '<line x1="12" y1="20" x2="20" y2="20"/>',
  ),
  // A line split at a crossing edge, with the middle dashed to indicate removal.
  trim: wrap(
    '<line x1="3" y1="12" x2="10" y2="12"/>' +
    '<line x1="14" y1="12" x2="21" y2="12"/>' +
    '<line x1="12" y1="5" x2="12" y2="19"/>',
  ),
} as const;
