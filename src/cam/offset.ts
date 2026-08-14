import type { Vec2 } from "../core/vec2";
import {
  inflatePathsD,
  intersectD,
  JoinType,
  EndType,
  differenceD,
  unionD,
  FillRule,
} from "clipper2-ts";

/**
 * Re-start a closed path at the midpoint of its longest edge, so a profile's
 * lead-in/out and plunge happen mid-side rather than at a corner. Splits the
 * longest edge: the path begins at its midpoint and the closing move completes
 * that edge. Used by both the G-code generator and the stock-sim preview so they
 * agree on where the cut starts.
 */
export function startAtLongestEdgeMid(path: Vec2[]): Vec2[] {
  const n = path.length;
  if (n < 3) return path;
  let k = 0,
    best = -1;
  for (let i = 0; i < n; i++) {
    const a = path[i],
      b = path[(i + 1) % n];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d > best) {
      best = d;
      k = i;
    }
  }
  const a = path[k],
    b = path[(k + 1) % n];
  const mid: Vec2 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const out: Vec2[] = [mid];
  for (let i = 1; i <= n; i++) out.push(path[(k + i) % n]); // b … a, closing back to mid
  return out;
}

/**
 * Returns true if the closed polygon has at least one reflex (concave) vertex.
 * Triangles are always convex. Uses the sign of consecutive cross products.
 */
export function isConcave(pts: Vec2[]): boolean {
  const n = pts.length;
  if (n < 4) return false;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i],
      b = pts[(i + 1) % n],
      c = pts[(i + 2) % n];
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(z) < 1e-10) continue;
    const s = z > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return true;
  }
  return false;
}

/** Signed area of a closed polygon (positive = CCW in Y-up world). */
export function signedArea(pts: Vec2[]): number {
  let a = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return a / 2;
}

/**
 * Offset a closed polygon by `d` mm using Clipper2.
 * Positive d expands (outward), negative d shrinks (inward).
 * Returns one or more result polygons — a large inward offset on a concave
 * shape can split into multiple pieces, each of which needs to be cut.
 */
export function offsetPolygon(pts: Vec2[], d: number, miterLimit = 4): Vec2[][] {
  if (pts.length < 3) return [];
  const result = inflatePathsD([pts], d, JoinType.Miter, EndType.Polygon, miterLimit);
  return result.map((path) => path.map((pt) => ({ x: pt.x, y: pt.y })));
}

/**
 * Subtract clip polygons from a subject polygon using Clipper2.
 * Returns the resulting paths (may include outer boundaries and holes);
 * passing all result paths together to a multi-contour scanline gives the
 * correct cuttable region via the odd-even rule.
 */
export function subtractPolygons(subject: Vec2[], clips: Vec2[][]): Vec2[][] {
  if (clips.length === 0) return [subject];
  const result = differenceD([subject], clips, FillRule.NonZero);
  return result.map((path) => path.map((pt) => ({ x: pt.x, y: pt.y })));
}

/**
 * Offset a SET of paths as one NonZero region (holes wound opposite the outer
 * offset correctly; lobes merged by a dilation erode back as a unit). The
 * single-path {@link offsetPolygon} can't express either.
 *
 * `join` defaults to the pipeline's miter, but morphological open/close (see
 * cam/machinability.ts) must use `"round"`: a disc-swept cut IS round-join
 * morphology — miter closing wrongly seals corner-open steps a real cutter
 * can reach into (verified on the box generator's rim-corner notches).
 */
export function offsetPolygons(
  paths: Vec2[][],
  d: number,
  opts: { miterLimit?: number; join?: "miter" | "round"; arcTolerance?: number } = {},
): Vec2[][] {
  const closed = paths.filter((p) => p.length >= 3);
  if (closed.length === 0) return [];
  const join = opts.join === "round" ? JoinType.Round : JoinType.Miter;
  // Round joins NEED an explicit arc tolerance — the library default generates
  // pathologically fine arcs (seconds per offset on a gear outline).
  const result = inflatePathsD(
    closed,
    d,
    join,
    EndType.Polygon,
    opts.miterLimit ?? 4,
    undefined,
    opts.arcTolerance,
  );
  return result.map((path) => path.map((pt) => ({ x: pt.x, y: pt.y })));
}

/** Multi-subject variant of {@link subtractPolygons} (NonZero both sides). */
export function subtractPolygonSets(subject: Vec2[][], clips: Vec2[][]): Vec2[][] {
  if (subject.length === 0) return [];
  if (clips.length === 0) return subject;
  const result = differenceD(subject, clips, FillRule.NonZero);
  return result.map((path) => path.map((pt) => ({ x: pt.x, y: pt.y })));
}

/**
 * Self-union a path set, merging overlaps and resolving holes (NonZero).
 *
 * NonZero is what makes this correct for glyphs: a font winds a counter (the
 * hole in an 'e' or 'o') opposite to its outer contour, so the same rule that
 * merges two overlapping same-wound subpaths also keeps the counter open.
 * An EvenOdd union would too, but it would turn any genuine self-overlap into a
 * hole, which is exactly the artefact this exists to remove.
 */
export function unionPolygons(paths: Vec2[][]): Vec2[][] {
  const closed = paths.filter((p) => p.length >= 3);
  if (closed.length === 0) return [];
  const result = unionD(closed, FillRule.NonZero);
  return result.map((path) => path.map((pt) => ({ x: pt.x, y: pt.y })));
}

/** Boolean intersection of two path sets (NonZero). Empty when either is. */
export function intersectPolygonSets(a: Vec2[][], b: Vec2[][]): Vec2[][] {
  if (a.length === 0 || b.length === 0) return [];
  const result = intersectD(a, b, FillRule.NonZero);
  return result.map((path) => path.map((pt) => ({ x: pt.x, y: pt.y })));
}
