/**
 * V-carve halftoning — reproducing a photograph as parallel V-grooves whose
 * WIDTH carries the tone.
 *
 * A V-bit cuts a groove whose width is set by how deep it rides, so a row of
 * grooves at a fixed pitch behaves exactly like a printer's halftone screen:
 * the fraction of surface removed is the tone.
 *
 *      row pitch p
 *   |<----------->|<----------->|
 *   ¯¯\    /¯¯¯¯¯¯¯\   /¯¯¯¯¯¯¯¯¯\      /¯¯   ← surface
 *      \  /         \ /           \    /
 *       \/           v             \  /       ← deeper ⇒ wider ⇒ darker
 *       w(d)                        \/
 *
 * At depth `d` a bit of included angle θ with a flat tip `t` cuts
 *
 *     w(d) = t + 2·d·tan(θ/2)          (capped at the bit's major diameter)
 *
 * and the tone at that dot is the coverage `w(d) / p`. Two consequences drive
 * everything here:
 *
 * 1. **The row pitch must come from the bit and the depth, not from a stepover
 *    heuristic.** A relief's row spacing is chosen for surface smoothness (fine
 *    = fewer scallops); a halftone's is chosen so the darkest grooves just meet.
 *    Space them finer than `w(dₘₐₓ)` and neighbouring grooves eat each other —
 *    the deepest of them wins and the depth map is max-filtered over a groove
 *    width, which is detail thrown away at a cost in cutting time. That is why
 *    this is a MODE and not a change to the relief default: both are right, for
 *    different jobs.
 *
 * 2. **The along-row pitch must stay fine.** `rasterField` defaults the dot
 *    pitch to the line interval (square dots), which is correct for a laser and
 *    for a relief. Here the line interval becomes millimetres, and inheriting
 *    that along the row would quantise the groove's own length into the same
 *    coarse steps — the one axis that should keep the photograph's detail.
 *
 * Pure geometry, no G-code and no document: the emitter (`reliefImage`) and the
 * 3-D preview (`rasRelief`) both read their spacing from {@link reliefSpacing},
 * so a preview that disagrees with the program is a thing that cannot be
 * expressed rather than a thing we remember to keep in step.
 */

import { DEFAULTS, type ToolType } from "./types";

/** Along-row dot pitch for a halftone, mm — fine enough to keep photo detail. */
export const HALFTONE_DOT_PITCH_MM = 0.1;

/**
 * The V-bit geometry the groove width depends on. Structural on purpose: a
 * resolved {@link CAMOperation} satisfies it, and so does the op dialog's state
 * plus a tip diameter read from the tool library.
 */
export interface VBitGeometry {
  /** Included angle ACROSS the point, degrees (60 typical) — not the half-angle. */
  vAngle?: number;
  /** Flat at the point, mm. 0 or absent = perfectly sharp. */
  tipDiameter?: number;
  /** Major (cutting) diameter, mm — the widest the flutes reach; caps the groove. */
  diameter: number;
}

/** Half-angle in radians, clamped to a cutting geometry that exists. */
function halfAngleRad(bit: VBitGeometry): number {
  const deg = bit.vAngle && bit.vAngle > 0 ? bit.vAngle : DEFAULTS.vAngle;
  // 180° would be a flat disc (tan → ∞, infinitely wide groove); 0° an infinitely
  // long needle. Clamp to the range a real bit lives in so the arithmetic below
  // stays finite whatever a document carries.
  const clamped = Math.min(179, Math.max(1, deg));
  return ((clamped / 2) * Math.PI) / 180;
}

/**
 * Width of the groove a V-bit leaves at the surface when its tip rides `depth`
 * below it, mm. Zero at zero depth; capped at the bit's major diameter, past
 * which the flutes have run out and the shank would rub.
 *
 * Note the discontinuity a flat-tip (engraving) bit has at the surface: an
 * infinitesimal plunge already cuts a `tipDiameter`-wide groove, so such a bit
 * cannot render the lightest tones at all — see {@link HalftonePlan.minCoverage}.
 */
export function grooveWidth(depth: number, bit: VBitGeometry): number {
  if (!(depth > 0)) return 0;
  const w = (bit.tipDiameter ?? 0) + 2 * depth * Math.tan(halfAngleRad(bit));
  return Math.min(w, Math.max(0, bit.diameter));
}

/**
 * Depth at which the groove reaches the bit's major diameter, mm. Cutting deeper
 * than this buries the shank: the groove stops widening, so the darkest tones
 * flatten into one another.
 */
export function usableDepth(bit: VBitGeometry): number {
  const spread = Math.max(0, bit.diameter - (bit.tipDiameter ?? 0));
  return spread / (2 * Math.tan(halfAngleRad(bit)));
}

/** The screen a halftone will be cut on: pitch, and the tonal range it can hold. */
export interface HalftonePlan {
  /** Distance between groove centrelines, mm — the derived line interval. */
  rowPitch: number;
  /** Along-row sample pitch, mm. Deliberately NOT the row pitch. */
  dotPitch: number;
  /** Width of the widest groove, at full depth, mm. */
  grooveWidth: number;
  /** Uncut surface left between grooves at full depth, mm. */
  land: number;
  /** Coverage of the darkest tone, 0..1. 1 = grooves touch, i.e. solid black. */
  maxCoverage: number;
  /**
   * Coverage of the lightest tone the bit can actually cut, 0..1. A sharp bit
   * reaches 0 (a groove can be arbitrarily fine); a flat-tip bit cannot go below
   * its own flat, so the bottom of the tonal range prints as white.
   */
  minCoverage: number;
  /** True when the bit's major diameter caps the groove before full depth. */
  capped: boolean;
  /** The depth at which that cap bites, mm (see {@link usableDepth}). */
  usableDepth: number;
}

/**
 * Work out the screen for a halftone: row pitch from the widest groove plus the
 * requested `land`, and an along-row pitch fine enough not to throw away the
 * detail the grooves are carrying.
 *
 * `land` is the surface left standing between grooves in the BLACKEST area — 0
 * makes the darkest tone solid, and a positive value trades peak blackness for a
 * visible line texture (and a shorter cut). It is never negative: overlapping
 * the darkest grooves would saturate the tone before full depth, spending depth
 * range to lose contrast.
 */
export function halftonePlan(
  bit: VBitGeometry,
  maxDepth: number,
  land = 0,
  dotPitchOverride?: number,
): HalftonePlan {
  const w = grooveWidth(maxDepth, bit);
  const l = Math.max(0, land || 0);
  // A degenerate bit (zero diameter) or zero depth cuts nothing; fall back to a
  // pitch that at least keeps the arithmetic downstream finite.
  const rowPitch = w + l > 0 ? w + l : DEFAULTS.rasterLineInterval;
  const dotPitch =
    dotPitchOverride && dotPitchOverride > 0
      ? dotPitchOverride
      : Math.min(HALFTONE_DOT_PITCH_MM, rowPitch / 4);
  const tip = bit.tipDiameter ?? 0;
  return {
    rowPitch,
    dotPitch,
    grooveWidth: w,
    land: l,
    maxCoverage: w > 0 ? Math.min(1, w / rowPitch) : 0,
    minCoverage: tip > 0 ? Math.min(1, tip / rowPitch) : 0,
    capped: maxDepth > usableDepth(bit),
    usableDepth: usableDepth(bit),
  };
}

/** What {@link reliefSpacing} needs off an operation (or the op dialog's state). */
export interface ReliefSpacingInput extends VBitGeometry {
  toolType?: ToolType;
  /** Cut depth, mm — signed as the op carries it; only the magnitude matters. */
  depth: number;
  halftone?: boolean;
  halftoneLand?: number;
  rasterLineInterval?: number;
  rasterDotPitch?: number;
}

export interface ReliefSpacing {
  /** Row pitch to hand `rasterField`, mm. */
  lineInterval: number;
  /** Along-row pitch, or undefined to let `rasterField` use square dots. */
  dotPitch: number | undefined;
  /** The halftone screen, or null when this op is an ordinary relief. */
  plan: HalftonePlan | null;
}

/** Halftoning is a V-bit trick: the width law above is the V's, and nothing else's. */
export function isHalftone(op: ReliefSpacingInput): boolean {
  return op.halftone === true && op.toolType === "v-bit";
}

/**
 * The row/dot pitch for an image engrave, halftone or not. The one place either
 * spacing is decided — `reliefImage` (G-code) and `rasRelief` (3-D preview) both
 * call this, so the preview cannot drift from the program it is previewing.
 */
export function reliefSpacing(op: ReliefSpacingInput): ReliefSpacing {
  if (isHalftone(op)) {
    const plan = halftonePlan(op, Math.abs(op.depth), op.halftoneLand, op.rasterDotPitch);
    return { lineInterval: plan.rowPitch, dotPitch: plan.dotPitch, plan };
  }
  return {
    lineInterval:
      op.rasterLineInterval && op.rasterLineInterval > 0
        ? op.rasterLineInterval
        : DEFAULTS.rasterLineInterval,
    dotPitch: op.rasterDotPitch,
    plan: null,
  };
}

/**
 * How badly a V-bit relief's rows overlap: the groove width at full depth over
 * the row pitch. 1 means the grooves just meet — the halftone condition. Large
 * values mean each groove is re-cut by its neighbours, so the carved surface is
 * the depth map dilated by half a groove: fine detail is replaced by whatever
 * was darkest nearby, and the extra rows are cutting time spent to lose it.
 *
 * Returns 0 when the question doesn't apply (not a V-bit, no depth).
 */
export function grooveOverlapRatio(op: ReliefSpacingInput): number {
  if (op.toolType !== "v-bit") return 0;
  const w = grooveWidth(Math.abs(op.depth), op);
  const { lineInterval } = reliefSpacing(op);
  return w > 0 && lineInterval > 0 ? w / lineInterval : 0;
}

/**
 * Overlap at which a plain (non-halftone) V-bit relief is worth warning about.
 * Some overlap is legitimate — it is how a relief gets a smooth surface — so
 * this is set well clear of "slightly fine" and at "you are cutting each groove
 * three times over".
 */
export const OVERLAP_WARN_RATIO = 3;
