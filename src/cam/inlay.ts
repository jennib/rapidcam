/**
 * V-carve inlay — the female pocket and the male plug that fills it.
 *
 * A V-carve inlay is two carves in two boards. The **female** is a V-pocket cut
 * into board A. The **male** is the same design cut into board B with the
 * surrounding field cleared away, so the design stands proud on V-shaped
 * flanks; you saw the plug off, flip it, and glue it into the pocket.
 *
 * ## Why the flip is load-bearing, not a finishing step
 *
 * Both carves come off the same bit, so both flanks sit at ½·vAngle. But they
 * lean opposite ways:
 *
 *     female pocket (board A)          male plug (board B)
 *        ╲            ╱                    ╱          ╲
 *         ╲          ╱                    ╱            ╲
 *          ╲________╱                    ╱______________╲
 *      widest at the MOUTH            widest at the BASE
 *
 * Flipping the plug turns "widest at the base" into "widest at the top", which
 * is what a pocket widest at its mouth can accept. That is why `mirrorX` is
 * applied to the male and not offered as an option — unmirrored, the plug is
 * the wrong-handed part and simply will not seat.
 *
 * ## The glue gap is the whole fit, and it is one number
 *
 * With no clearance the two surfaces are identical and the plug bottoms out on
 * its own point before its flanks ever touch. `startDepth = glueGap` sinks the
 * male's V profile, so reaching depth `d` needs `r = (d − g)·tan(½·vAngle)`
 * rather than `d·tan(½·vAngle)`: the standing plug is **narrower by exactly
 * `g·tan(½·vAngle)` at every depth**. It therefore slides `g` deeper before the
 * flanks make contact, leaving a `g`-deep void at the apex — which is where the
 * glue goes. See `VCarveParams.startDepth`, where that law lives.
 *
 * `sawAllowance` deepens the male only: the plug needs to be longer than the
 * pocket so there is material to saw and plane flush after gluing.
 *
 * ## The complement costs nothing
 *
 * `groupContoursIntoRegions` already nests by even–odd containment. Hand it the
 * design alone and each shape is solid — the female. Hand it a boundary
 * rectangle *with* the design inside and the design becomes a set of HOLES in
 * that rectangle — which is precisely the male's "clear the field" region. So
 * the male needs no complement code: it needs a boundary, and `inlayContours`
 * supplies one when the selection has not already drawn it.
 */
import type { Vec2 } from "../core/vec2";
import type { CAMOperation } from "./types";
import {
  type CarveRegion,
  groupContoursIntoRegions,
  type VCarveParams,
  vcarveParamsForOp,
} from "./vcarve";

export type InlayMode = "female" | "male";

export interface InlayFit {
  /** Pocket floor depth, mm (positive). The female's flat depth. */
  pocketDepth: number;
  /**
   * Clearance for glue, mm (positive). Shrinks the plug by
   * `glueGap · tan(½·vAngle)` at every depth. Typical: 0.25–0.5 mm.
   */
  glueGap: number;
  /** Extra depth on the MALE only, so there is stock to saw through, mm. */
  sawAllowance: number;
}

export const DEFAULT_INLAY_FIT: InlayFit = {
  pocketDepth: 3,
  glueGap: 0.25,
  sawAllowance: 1.5,
};

/** Margin (mm) around the design for the male's auto-generated boundary. */
export const DEFAULT_INLAY_MARGIN = 10;

/** Axis-aligned bounds of a set of contours. */
function boundsOf(contours: readonly Vec2[][]): { min: Vec2; max: Vec2 } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of contours)
    for (const p of c) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  return Number.isFinite(minX) ? { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } } : null;
}

/**
 * Is one of these contours already a boundary enclosing all the others?
 *
 * Deliberately cheap and containment-based, to agree with the even–odd rule
 * `groupContoursIntoRegions` uses: a ring counts as the boundary when every
 * other ring's bounding box sits strictly inside its own. Users who draw the
 * rectangle themselves (the Vectric habit) get exactly what they drew.
 */
export function enclosingContour(contours: readonly Vec2[][]): Vec2[] | null {
  if (contours.length < 2) return null;
  for (const cand of contours) {
    const cb = boundsOf([cand]);
    if (!cb) continue;
    const others = contours.filter((c) => c !== cand);
    const ob = boundsOf(others);
    if (!ob) continue;
    if (ob.min.x > cb.min.x && ob.min.y > cb.min.y && ob.max.x < cb.max.x && ob.max.y < cb.max.y)
      return cand;
  }
  return null;
}

/** A rectangle `margin` mm outside everything given, wound CCW. */
export function boundaryRect(contours: readonly Vec2[][], margin: number): Vec2[] | null {
  const b = boundsOf(contours);
  if (!b) return null;
  const m = Math.max(0, margin);
  const x0 = b.min.x - m;
  const y0 = b.min.y - m;
  const x1 = b.max.x + m;
  const y1 = b.max.y + m;
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

/** Mirror about the vertical line through the contours' own centre. */
export function mirrorX(contours: readonly Vec2[][]): Vec2[][] {
  const b = boundsOf(contours);
  if (!b) return contours.map((c) => c.map((p) => ({ ...p })));
  const axis = b.min.x + b.max.x;
  // Reversed so the winding survives the reflection: mirroring alone flips a
  // CCW ring to CW, which would turn every solid into a hole downstream.
  return contours.map((c) => c.map((p) => ({ x: axis - p.x, y: p.y })).reverse());
}

/**
 * The contours to carve for one side of an inlay.
 *
 * Female: the design as drawn. Male: the design inside a boundary — the user's
 * own if they drew one, otherwise a generated rectangle — and then mirrored, so
 * the plug is the correct hand once flipped.
 */
export function inlayContours(
  contours: readonly Vec2[][],
  mode: InlayMode,
  marginMM: number,
): Vec2[][] {
  const rings = contours.filter((c) => c.length >= 3);
  if (mode === "female") return rings.map((c) => c.map((p) => ({ ...p })));
  if (rings.length === 0) return [];

  const withBoundary = enclosingContour(rings)
    ? rings.map((c) => c.map((p) => ({ ...p })))
    : (() => {
        const rect = boundaryRect(rings, marginMM);
        return rect ? [rect, ...rings.map((c) => c.map((p) => ({ ...p })))] : [];
      })();

  return mirrorX(withBoundary);
}

/** Regions ready for `vcarveRegion` — the complement falls out of even–odd nesting. */
export function inlayRegions(
  contours: readonly Vec2[][],
  mode: InlayMode,
  marginMM: number,
): CarveRegion[] {
  return groupContoursIntoRegions(inlayContours(contours, mode, marginMM));
}

/**
 * Depth and clearance for one side. The female carves to the pocket floor with
 * no offset; the male sinks by the glue gap and runs deeper by the saw
 * allowance.
 */
export function inlayParams(base: VCarveParams, mode: InlayMode, fit: InlayFit): VCarveParams {
  const pocket = Math.abs(fit.pocketDepth);
  return mode === "female"
    ? { ...base, maxDepth: pocket, startDepth: 0 }
    : {
        ...base,
        maxDepth: pocket + Math.max(0, fit.sawAllowance),
        startDepth: Math.max(0, fit.glueGap),
      };
}

/**
 * How much narrower the plug is than the pocket, at every depth, in mm of
 * radial clearance per side. Exposed because it is the number a user actually
 * wants to sanity-check against their glue, and because stating it once keeps
 * the UI from re-deriving it.
 */
export function radialClearance(glueGap: number, vAngleDeg: number): number {
  return Math.max(0, glueGap) * Math.tan((vAngleDeg / 2) * (Math.PI / 180));
}

/** The fit fields read off an inlay op, defaulting to {@link DEFAULT_INLAY_FIT}. */
export function inlayFitForOp(op: CAMOperation): InlayFit {
  return {
    pocketDepth: op.pocketDepth ?? DEFAULT_INLAY_FIT.pocketDepth,
    glueGap: op.glueGap ?? DEFAULT_INLAY_FIT.glueGap,
    sawAllowance: op.sawAllowance ?? DEFAULT_INLAY_FIT.sawAllowance,
  };
}

/** The male boundary margin read off an inlay op, defaulting to {@link DEFAULT_INLAY_MARGIN}. */
export function inlayMarginForOp(op: CAMOperation): number {
  return op.inlayMargin ?? DEFAULT_INLAY_MARGIN;
}

/**
 * The peel params for one side of an inlay, derived from the op the way
 * `vcarveParamsForOp` derives a plain v-carve's. Single source for the G-code
 * generator and the preview rasterizer, so the two agree on the cut.
 */
export function inlayParamsForOp(op: CAMOperation, mode: InlayMode): VCarveParams {
  return inlayParams(vcarveParamsForOp(op), mode, inlayFitForOp(op));
}
