/**
 * Inline SVG icons for the per-object state toggles in the Layers panel and the
 * Design Tree. 24×24 on a currentColor stroke, matching tools/icons.ts.
 *
 * These replace emoji (👁 / 🕶). The sunglasses glyph was the specific
 * complaint: it is a DARK glyph, so on a dark panel it read as a smudge, and no
 * amount of framing fixes a shape that is the same colour as its background.
 * Outlining it would have papered over that; a stroked icon inherits the
 * button's colour instead, so it can never be invisible against it.
 *
 * The pair is also the conventional one — an eye, and the same eye struck
 * through — so "hidden" is legible from the SHAPE rather than from noticing
 * that one dark blob differs from another. Emoji additionally render
 * differently per platform, which a drawn icon does not.
 */

const wrap = (inner: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

/** The eye outline both states share. */
const EYE = '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.6"/>';

export const STATE_ICONS = {
  /** Shown / visible. */
  eye: wrap(EYE),
  /**
   * Hidden. The slash is drawn twice — once in the panel's background colour
   * beneath the stroke — so it reads as cutting THROUGH the eye rather than
   * lying on top of it, which is what makes the state obvious at 13px.
   */
  eyeOff: wrap(
    `${EYE}<line x1="3" y1="21" x2="21" y2="3" stroke="var(--panel)" stroke-width="3.4"/>` +
      '<line x1="3" y1="21" x2="21" y2="3"/>',
  ),
  /** Locked: shackle closed. */
  lock: wrap('<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  /** Unlocked: shackle swung open to the right. */
  unlock: wrap(
    '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>',
  ),
} as const;
