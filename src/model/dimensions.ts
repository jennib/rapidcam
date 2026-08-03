/**
 * Dimensions.
 *
 * A dimension is an annotation that measures geometry AND, when `driving`, a
 * constraint that forces that measurement to equal `value`. Driving dimensions
 * contribute one residual (`measure − value`) to the same solver the geometric
 * constraints use, so editing a dimension's value reflows the sketch.
 *
 * Values are millimetres (radians for "angle"). Linear dimensions are point-to-
 * point; their `type` (aligned / horizontal / vertical) and `offset` (how far the
 * dimension line sits from the geometry) are chosen interactively while placing.
 * Geometry is derived from the references + offset every frame, so dimensions
 * follow the geometry as it moves.
 */

import {
  type Vec2,
  sub,
  add,
  scale,
  mid,
  dist,
  len,
  normalize,
  perp,
  dot,
  cross,
  angle as vecAngle,
} from "../core/vec2";
import { distToSegment } from "../core/geom";
import { type Unit, formatLengthWithUnit, formatAngle } from "../core/units";
import {
  type EntityId,
  CircleEntity,
  LineEntity,
  ArcEntity,
  PolylineEntity,
  edgeEndsOf,
} from "./entities";
import type { Geo, PointRef } from "./constraints";
import { nextId } from "./ids";

export type DimensionType =
  | "distance"
  | "horizontal"
  | "vertical"
  | "radius"
  | "diameter"
  | "angle"
  | "arclength"
  | "line-distance"
  | "circle-gap";
export type LinearDimType = "distance" | "horizontal" | "vertical" | "line-distance";

export interface Dimension {
  id: string;
  type: DimensionType;
  points: PointRef[]; // linear dims: the 2 measured points
  entities: EntityId[]; // radius/diameter: 1 circle
  value: number; // mm, or radians for angle
  driving: boolean;
  /**
   * Placement:
   *  - linear  → signed scalar position of the dimension line along its normal
   *  - radius/diameter → leader direction angle (radians) from the circle centre
   */
  offset: number;
  /** Parametric anchors [t1, t2] for drawing visual extension lines on line-distance dims. */
  anchors?: [number, number];
  /** Formula string when the value is driven by an expression (e.g. "width * 2"). */
  expr?: string;
  /**
   * Not drawn on the canvas. A `hidden` driving dimension is how a formula typed
   * into a *measurement* property field (line length, rect W/H) parks in the
   * engine — it drives geometry like any dimension but shows no annotation. See
   * the parametric plan / property-field bindings.
   */
  hidden?: boolean;
}

export function makeDimension(
  type: DimensionType,
  opts: {
    points?: PointRef[];
    entities?: EntityId[];
    value: number;
    offset: number;
    driving?: boolean;
    anchors?: [number, number];
    expr?: string;
    hidden?: boolean;
  },
): Dimension {
  return {
    id: nextId("dim"),
    type,
    points: opts.points ?? [],
    entities: opts.entities ?? [],
    value: opts.value,
    driving: opts.driving ?? true,
    offset: opts.offset,
    anchors: opts.anchors,
    expr: opts.expr,
    hidden: opts.hidden,
  };
}

export const LEADER_MM = 9; // world-space leader length for radius/diameter

// ---------------------------------------------------------------------------
// Geometry access

function readPoint(geo: Geo, ref: PointRef | undefined): Vec2 | null {
  if (!ref) return null;
  const e = geo(ref.entityId);
  if (!e) return null;
  // Circle/arc boundary anchor: key "edge@<angleRadians>" resolves to a point on
  // the rim (centre + R·dir). Handled here, not via Entity.getPoint, so the
  // constraint system never sees these synthetic, non-DOF refs.
  if (ref.key.startsWith("edge@")) {
    const g = circularGeom(geo, ref.entityId);
    if (!g) return null;
    const theta = parseFloat(ref.key.slice(5));
    if (!Number.isFinite(theta)) return null;
    return {
      x: g.center.x + g.radius * Math.cos(theta),
      y: g.center.y + g.radius * Math.sin(theta),
    };
  }
  try {
    return e.getPoint(ref.key);
  } catch {
    return null;
  }
}
function readCircle(geo: Geo, id: EntityId | undefined): CircleEntity | null {
  if (!id) return null;
  const e = geo(id);
  return e instanceof CircleEntity ? e : null;
}
function readArc(geo: Geo, id: EntityId | undefined): ArcEntity | null {
  if (!id) return null;
  const e = geo(id);
  return e instanceof ArcEntity ? e : null;
}
/** Center + radius from a circle OR arc entity, or null if neither. */
function circularGeom(geo: Geo, id: EntityId | undefined): { center: Vec2; radius: number } | null {
  const c = readCircle(geo, id);
  if (c) return { center: c.center, radius: c.radius };
  const a = readArc(geo, id);
  if (a) return { center: a.center, radius: a.radius };
  return null;
}
/**
 * Geometry for a gap dimension between two circles/arcs.
 * `nested` is true when one boundary lies inside the other (the concentric
 * inner/outer-offset case), in which case the measured gap is radial.
 */
function gapGeom(
  geo: Geo,
  id1: EntityId | undefined,
  id2: EntityId | undefined,
): {
  cInner: Vec2;
  rInner: number;
  cOuter: Vec2;
  rOuter: number;
  d: number;
  nested: boolean;
} | null {
  const a = circularGeom(geo, id1);
  const b = circularGeom(geo, id2);
  if (!a || !b) return null;
  const inner = a.radius <= b.radius ? a : b;
  const outer = a.radius <= b.radius ? b : a;
  const d = dist(inner.center, outer.center);
  const nested = d <= outer.radius - inner.radius + 1e-6;
  return {
    cInner: inner.center,
    rInner: inner.radius,
    cOuter: outer.center,
    rOuter: outer.radius,
    d,
    nested,
  };
}

function readLineGeom(geo: Geo, id: EntityId | undefined): { a: Vec2; b: Vec2 } | null {
  if (!id) return null;
  const sep = id.indexOf("#");
  if (sep >= 0) {
    const base = geo(id.slice(0, sep));
    const suffix = id.slice(sep + 1);
    if (base instanceof PolylineEntity) {
      const seg = base.segmentByStartVertexId(suffix);
      return seg ? { a: seg[0], b: seg[1] } : null;
    }
    // "<id>#mid_l" — one named edge of a rectangle, image, or the stock rect.
    return edgeEndsOf(base, suffix);
  }
  const e = geo(id);
  return e instanceof LineEntity ? { a: e.a, b: e.b } : null;
}

/** Compute the vertex and arm directions for an angle between two lines. */
function linesAngleGeometry(
  l1: { a: Vec2; b: Vec2 },
  l2: { a: Vec2; b: Vec2 },
): { vertex: Vec2; d1: Vec2; d2: Vec2 } | null {
  const EPS = 1e-6;
  // Prefer a shared endpoint as the vertex.
  const ends1 = [
    { v: l1.a, far: l1.b },
    { v: l1.b, far: l1.a },
  ];
  const ends2 = [
    { v: l2.a, far: l2.b },
    { v: l2.b, far: l2.a },
  ];
  for (const e1 of ends1) {
    for (const e2 of ends2) {
      if (dist(e1.v, e2.v) < EPS) {
        const d1 = normalize(sub(e1.far, e1.v));
        const d2 = normalize(sub(e2.far, e2.v));
        if (len(d1) < EPS || len(d2) < EPS) continue;
        return { vertex: e1.v, d1, d2 };
      }
    }
  }
  // Find intersection of infinite lines.
  const dir1 = sub(l1.b, l1.a);
  const dir2 = sub(l2.b, l2.a);
  const denom = cross(dir1, dir2);
  if (Math.abs(denom) < EPS) return null; // parallel
  const t = cross(sub(l2.a, l1.a), dir2) / denom;
  const vertex = add(l1.a, scale(dir1, t));
  // Arm directions: from vertex toward each line's midpoint.
  const raw1 = sub(mid(l1.a, l1.b), vertex);
  const raw2 = sub(mid(l2.a, l2.b), vertex);
  if (len(raw1) < EPS || len(raw2) < EPS) return null;
  return { vertex, d1: normalize(raw1), d2: normalize(raw2) };
}

// ---------------------------------------------------------------------------
// Measurement + solver residual

/** The current measured value of the dimension (mm / rad), or null if unresolved. */
export function dimensionMeasure(dim: Dimension, geo: Geo): number | null {
  switch (dim.type) {
    case "distance": {
      const [p, q] = [readPoint(geo, dim.points[0]), readPoint(geo, dim.points[1])];
      return p && q ? dist(p, q) : null;
    }
    case "horizontal": {
      const [p, q] = [readPoint(geo, dim.points[0]), readPoint(geo, dim.points[1])];
      return p && q ? Math.abs(p.x - q.x) : null;
    }
    case "vertical": {
      const [p, q] = [readPoint(geo, dim.points[0]), readPoint(geo, dim.points[1])];
      return p && q ? Math.abs(p.y - q.y) : null;
    }
    case "radius": {
      const g = circularGeom(geo, dim.entities[0]);
      return g ? g.radius : null;
    }
    case "diameter": {
      const g = circularGeom(geo, dim.entities[0]);
      return g ? g.radius * 2 : null;
    }
    case "arclength": {
      const a = readArc(geo, dim.entities[0]);
      if (!a) return null;
      const span = (((a.endAngle - a.startAngle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      return a.radius * span;
    }
    case "angle": {
      const l1 = readLineGeom(geo, dim.entities[0]);
      const l2 = readLineGeom(geo, dim.entities[1]);
      if (!l1 || !l2) return null;
      const ag = linesAngleGeometry(l1, l2);
      if (!ag) return null;
      return Math.acos(Math.max(-1, Math.min(1, dot(ag.d1, ag.d2))));
    }
    case "line-distance": {
      const l1 = readLineGeom(geo, dim.entities[0]);
      const l2 = readLineGeom(geo, dim.entities[1]);
      if (!l1 || !l2) return null;
      const dir2 = normalize(sub(l2.b, l2.a));
      const normal2 = { x: -dir2.y, y: dir2.x };
      const m1 = mid(l1.a, l1.b);
      return Math.abs(dot(sub(m1, l2.a), normal2));
    }
    case "circle-gap": {
      const g = gapGeom(geo, dim.entities[0], dim.entities[1]);
      if (!g) return null;
      // Nested (incl. concentric, the inner/outer-offset case): the radial gap
      // is the difference of radii. We deliberately ignore any centre offset —
      // it keeps the measure smooth (the centre-distance term has a gradient
      // kink at d=0 that wrecks solver convergence for concentric rings).
      // External (separate) circles: edge-to-edge distance along the centres.
      return g.nested ? g.rOuter - g.rInner : g.d - g.rOuter - g.rInner;
    }
  }
}

/** Residual for a driving dimension: measured − target. Empty if non-driving/unresolved. */
export function dimensionResiduals(dim: Dimension, geo: Geo): number[] {
  if (!dim.driving) return [];
  const m = dimensionMeasure(dim, geo);
  return m === null ? [] : [m - dim.value];
}

// ---------------------------------------------------------------------------
// Layout (world-space geometry for rendering / hit-testing)

export interface DimLayout {
  /** Lines to stroke (extension lines + the dimension line). */
  segments: [Vec2, Vec2][];
  /** Arrowheads: tip position + unit direction the head points toward. */
  arrows: { tip: Vec2; dir: Vec2 }[];
  /** Where the value text sits. */
  textPos: Vec2;
  /** Display string, e.g. "50.00 mm", "R8.00 mm", "⌀16.00 mm". */
  label: string;
  /** Arc segment for angle dimensions (world-space). */
  arc?: { center: Vec2; radius: number; startDir: Vec2; endDir: Vec2; ccw: boolean };
}

function linearNormal(type: LinearDimType, p: Vec2, q: Vec2): Vec2 {
  if (type === "horizontal") return { x: 0, y: 1 };
  if (type === "vertical") return { x: 1, y: 0 };
  return perp(normalize(sub(q, p))); // aligned
}

/** Choose the linear sub-type from where the cursor is placed (SolidWorks-style). */
export function chooseLinearType(p: Vec2, q: Vec2, cursor: Vec2): LinearDimType {
  const o = sub(cursor, mid(p, q));
  const ax = Math.abs(o.x);
  const ay = Math.abs(o.y);
  if (ax > ay * 1.4) return "vertical"; // dragging sideways → vertical dim line → measures Δy
  if (ay > ax * 1.4) return "horizontal"; // dragging up/down → horizontal dim line → measures Δx
  return "distance"; // aligned
}

/** Ensure the dimension line never sits exactly on top of the measured geometry. */
function clampMinOffset(val: number, min = 10): number {
  if (Math.abs(val) < min) return (val >= 0 ? 1 : -1) * min;
  return val;
}

/** Recompute `offset` from the cursor for the dimension's current type. */
export function dimensionOffsetFromCursor(dim: Dimension, geo: Geo, cursor: Vec2): number {
  if (dim.type === "radius" || dim.type === "diameter") {
    const g = circularGeom(geo, dim.entities[0]);
    return g ? vecAngle(sub(cursor, g.center)) : dim.offset;
  }
  if (dim.type === "circle-gap") {
    const g = gapGeom(geo, dim.entities[0], dim.entities[1]);
    return g ? vecAngle(sub(cursor, g.cInner)) : dim.offset;
  }
  if (dim.type === "arclength") {
    const a = readArc(geo, dim.entities[0]);
    if (!a) return dim.offset;
    return Math.max(5, Math.min(40, dist(cursor, a.center) - a.radius));
  }
  if (dim.type === "angle") {
    const l1 = readLineGeom(geo, dim.entities[0]);
    const l2 = readLineGeom(geo, dim.entities[1]);
    if (!l1 || !l2) return dim.offset;
    const ag = linesAngleGeometry(l1, l2);
    if (!ag) return dim.offset;
    return Math.max(5, dist(cursor, ag.vertex));
  }
  // A gap dimension has no perpendicular standoff to compute: its shaft IS
  // the span between the two lines, so it has nowhere to sit but between
  // them. Where it slides ALONG the lines is `anchors`, not `offset` — see
  // dimensionAnchorsFromCursor and the layout branch.
  if (dim.type === "line-distance") return 0;
  const p = readPoint(geo, dim.points[0]);
  const q = readPoint(geo, dim.points[1]);
  if (!p || !q) return dim.offset;
  const m = mid(p, q);
  if (dim.type === "horizontal") return clampMinOffset(cursor.y - m.y);
  if (dim.type === "vertical") return clampMinOffset(cursor.x - m.x);
  // aligned
  return clampMinOffset(dot(sub(cursor, m), linearNormal("distance", p, q)));
}

/** Project `p` onto segment a→b, as a parameter clamped to [0, 1]. */
export function projectOnLine(p: Vec2, a: Vec2, b: Vec2): number {
  const v = sub(b, a);
  const l2 = v.x * v.x + v.y * v.y;
  if (l2 < 1e-9) return 0.5;
  const t = dot(sub(p, a), v) / l2;
  return Math.max(0, Math.min(1, t));
}

/**
 * Resolve BOTH of a line-distance dimension's anchors from one reference
 * point, so they always sit directly across from each other (a straight,
 * perpendicular dimension), and re-derived fresh every call so neither
 * anchor goes stale if the lines move independently afterward.
 *
 * The key move is clamping to the OVERLAP of what l1 and l2 can each reach
 * tangentially, not clamping each line's projection independently. Clamping
 * independently lets one anchor slide freely while the other pins to its
 * line's nearest end the moment the reference goes past what THAT line
 * alone supports — even while the other line still has plenty of room — so
 * the shaft pivots around the pinned point and stretches out to meet the
 * still-sliding one. That's what read as "nodes where the dimension can
 * pivot... causing the dimension line to be too long": a pivot that fired
 * long before it needed to, and dragged the shaft's far end away with it.
 * Clamping the shared position to the overlap keeps both anchors moving
 * together across the full range they can BOTH support, so a pivot only
 * happens in the genuine edge case where the two lines don't tangentially
 * overlap at all — and even then, it lands at the nearest valid edge
 * instead of wherever the reference point happened to wander off to.
 */
function resolveLineDistanceCrossing(
  reference: Vec2,
  l1: { a: Vec2; b: Vec2 },
  l2: { a: Vec2; b: Vec2 },
): { p: Vec2; q: Vec2; t1: number; t2: number } {
  const d1 = sub(l1.b, l1.a);
  const len1 = len(d1);
  if (len1 < 1e-9) {
    const t2 = projectOnLine(l1.a, l2.a, l2.b);
    return { p: l1.a, q: add(l2.a, scale(sub(l2.b, l2.a), t2)), t1: 0.5, t2 };
  }
  const dir = scale(d1, 1 / len1);
  const s1a = dot(l1.a, dir);
  const s1b = s1a + len1; // dir IS l1's own unit direction, so l1.b is exactly len1 further
  const lo1 = Math.min(s1a, s1b);
  const hi1 = Math.max(s1a, s1b);

  const d2 = sub(l2.b, l2.a);
  const s2a = dot(l2.a, dir);
  const s2b = s2a + dot(d2, dir); // signed: handles l2 running either direction along dir
  const lo2 = Math.min(s2a, s2b);
  const hi2 = Math.max(s2a, s2b);

  const overlapLo = Math.max(lo1, lo2);
  const overlapHi = Math.min(hi1, hi2);
  const sRef = dot(reference, dir);
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  // Overlap exists -> clamp to it so both anchors can always meet perpendicular.
  // No overlap (rare) -> fall back to l1's own extent; some pivot is unavoidable.
  const s = overlapLo <= overlapHi ? clamp(sRef, overlapLo, overlapHi) : clamp(sRef, lo1, hi1);

  const t1 = clamp((s - s1a) / len1, 0, 1);
  const p = add(l1.a, scale(d1, t1));
  const t2 = projectOnLine(p, l2.a, l2.b); // final safety clamp against l2's real extent
  const q = add(l2.a, scale(d2, t2));
  return { p, q, t1, t2 };
}

/**
 * Anchor a line-distance dimension's two ends so they sit DIRECTLY ACROSS
 * from each other. Used for both the initial two-click placement and
 * drag-to-reposition.
 */
export function chainProjectAnchors(
  cursor: Vec2,
  l1: { a: Vec2; b: Vec2 },
  l2: { a: Vec2; b: Vec2 },
): [number, number] {
  const { t1, t2 } = resolveLineDistanceCrossing(cursor, l1, l2);
  return [t1, t2];
}

/**
 * Recompute a line-distance dimension's anchors [t1, t2] from the cursor.
 * dimensionOffsetFromCursor alone only ever moves the shaft perpendicular to
 * the two lines (the gap it reports is invariant to anchor position) —
 * dragging along the lines' own direction had nothing to drive it, so e.g. a
 * dimension between two vertical lines could be dragged left/right but never
 * up/down. Returns null for every other dimension type.
 */
export function dimensionAnchorsFromCursor(
  dim: Dimension,
  geo: Geo,
  cursor: Vec2,
): [number, number] | null {
  if (dim.type !== "line-distance") return null;
  const l1 = readLineGeom(geo, dim.entities[0]);
  const l2 = readLineGeom(geo, dim.entities[1]);
  if (!l1 || !l2) return null;
  return chainProjectAnchors(cursor, l1, l2);
}

/**
 * Real on-screen width of a dimension label, installed by the renderer so the
 * fit test uses the font the label is actually drawn in.
 *
 * A per-character estimate was measurably wrong — 6.7px/char guessed 115px for
 * a label that measures 97px, a 19% overshoot that pushed labels outside spans
 * they comfortably fitted. The exact width also depends on which monospace
 * face the platform resolves, so no constant is right everywhere. Hit-testing
 * calls the same function, so the clickable label cannot drift from the drawn
 * one.
 */
let measureLabelPx: ((label: string) => number) | null = null;
export function setDimLabelMeasurer(fn: ((label: string) => number) | null): void {
  measureLabelPx = fn;
}

/**
 * Where the value text sits on a linear dimension: centred on the dimension
 * line normally, shifted just past the far arrow when it would not fit
 * between them.
 *
 * The label is drawn with an OPAQUE background (it deliberately breaks the
 * dimension line so the number stays readable over geometry). On a narrow
 * measurement that box is wider than the whole span, so it covered the shaft
 * and both arrowheads — the dimension rendered as a bare number floating
 * between two lines with no visible graphic at all. Standard drafting moves
 * the text outside once it stops fitting.
 *
 * `pxPerMm` is the viewport scale, since fitting is a screen-space question:
 * text is a fixed pixel size, so the same dimension fits when zoomed in and
 * not when zoomed out. Callers without a viewport omit it and keep the
 * always-centred behaviour — but any caller that HIT-TESTS must pass the same
 * scale the renderer used, or the clickable label drifts from the drawn one.
 */
function linearTextPos(
  p2: Vec2,
  q2: Vec2,
  dir: Vec2,
  label: string,
  pxPerMm: number | undefined,
): { pos: Vec2; leaderSegment?: [Vec2, Vec2] } {
  const centre = mid(p2, q2);
  if (!pxPerMm || pxPerMm <= 0) return { pos: centre };
  // + 4px padding each side, matching drawDimText's background box. The
  // fallback estimate is only used before the renderer installs a measurer
  // (headless callers, tests).
  const textPx = (measureLabelPx?.(label) ?? label.length * 6.05) + 8;
  const spanPx = len(sub(q2, p2)) * pxPerMm;
  if (spanPx >= textPx + 6) return { pos: centre }; // fits, with a little clearance
  // Doesn't fit: park it just beyond the far arrow, on the dimension line.
  const outMm = (textPx / 2 + 8) / pxPerMm;
  const pos = add(q2, scale(dir, outMm));
  return { pos, leaderSegment: [q2, pos] };
}

/**
 * Prefix a driven dimension's label with the formula driving it, so
 * "width = 50.00 mm" rather than a bare "50.00 mm".
 *
 * A variable-driven dimension used to render identically to a hand-typed
 * one — the expression lived only in the editor, so nothing on the canvas
 * said the number came from a variable, let alone which. CAD tools differ on
 * whether to show the name or the value, but they agree a driven dimension
 * must not look like a plain number (SolidWorks marks equation-driven dims,
 * AutoCAD's parametric constraints show name = value by default).
 *
 * Angles are excluded to stay in step with dimEditor, which does not offer
 * expression editing for them: a label reading "x = 45" that opened an editor
 * showing only "45" would invite committing the formula away by accident.
 * A non-driving (reference) dimension shows no formula either — its expression
 * drives nothing, so claiming otherwise would be a lie.
 */
function withExpr(dim: Dimension, label: string): string {
  if (!dim.driving || !dim.expr || dim.type === "angle") return label;
  return `${dim.expr} = ${label}`;
}

export function dimensionLayout(
  dim: Dimension,
  geo: Geo,
  unit: Unit,
  pxPerMm?: number,
): DimLayout | null {
  const displayVal = dim.driving ? dim.value : (dimensionMeasure(dim, geo) ?? 0);

  if (dim.type === "radius" || dim.type === "diameter") {
    const g = circularGeom(geo, dim.entities[0]);
    if (!g) return null;
    const isArcEnt = readArc(geo, dim.entities[0]) !== null;
    const u = { x: Math.cos(dim.offset), y: Math.sin(dim.offset) };
    const edge = add(g.center, scale(u, g.radius));
    const end = add(g.center, scale(u, g.radius + LEADER_MM));
    if (dim.type === "radius") {
      return {
        // Arcs: short leader from arc surface only (circle: full center-to-label).
        segments: isArcEnt ? [[edge, end]] : [[g.center, end]],
        arrows: [{ tip: edge, dir: u }],
        textPos: end,
        label: withExpr(dim, `R${formatLengthWithUnit(displayVal, unit)}`),
      };
    }
    const e2 = sub(g.center, scale(u, g.radius));
    return {
      segments: isArcEnt ? [[edge, end]] : [[e2, end]],
      arrows: isArcEnt
        ? [{ tip: edge, dir: u }]
        : [
            { tip: edge, dir: u },
            { tip: e2, dir: scale(u, -1) },
          ],
      textPos: end,
      label: withExpr(dim, `⌀${formatLengthWithUnit(displayVal, unit)}`),
    };
  }

  if (dim.type === "circle-gap") {
    const g = gapGeom(geo, dim.entities[0], dim.entities[1]);
    if (!g) return null;
    const u = { x: Math.cos(dim.offset), y: Math.sin(dim.offset) };
    const pInner = add(g.cInner, scale(u, g.rInner));
    const pOuter = add(g.cOuter, scale(u, g.rOuter));
    const end = add(g.cOuter, scale(u, g.rOuter + LEADER_MM));
    return {
      // Span the gap between the two boundaries, then lead out to the label.
      segments: [
        [pInner, pOuter],
        [pOuter, end],
      ],
      arrows: [
        { tip: pInner, dir: u }, // points outward across the gap
        { tip: pOuter, dir: scale(u, -1) }, // points inward across the gap
      ],
      textPos: end,
      label: withExpr(dim, formatLengthWithUnit(displayVal, unit)),
    };
  }

  if (dim.type === "arclength") {
    const a = readArc(geo, dim.entities[0]);
    if (!a) return null;
    const R = a.radius + Math.max(6, Math.min(40, dim.offset));
    const span = (((a.endAngle - a.startAngle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const midAngle = a.startAngle + span / 2;
    const d1: Vec2 = { x: Math.cos(a.startAngle), y: Math.sin(a.startAngle) };
    const d2: Vec2 = { x: Math.cos(a.endAngle), y: Math.sin(a.endAngle) };
    // Tangential arrow directions (CCW tangent at each end, then negate for "inward").
    const arrow1Dir: Vec2 = { x: -d1.y, y: d1.x }; // CCW tangent at start
    const arrow2Dir: Vec2 = { x: d2.y, y: -d2.x }; // reverse CCW tangent at end
    return {
      segments: [
        [add(a.center, scale(d1, a.radius)), add(a.center, scale(d1, R))], // ext line start
        [add(a.center, scale(d2, a.radius)), add(a.center, scale(d2, R))], // ext line end
      ],
      arrows: [
        { tip: add(a.center, scale(d1, R)), dir: arrow1Dir },
        { tip: add(a.center, scale(d2, R)), dir: arrow2Dir },
      ],
      textPos: add(a.center, scale({ x: Math.cos(midAngle), y: Math.sin(midAngle) }, R + 2)),
      label: withExpr(dim, `∩${formatLengthWithUnit(displayVal, unit)}`),
      arc: { center: a.center, radius: R, startDir: d1, endDir: d2, ccw: true },
    };
  }

  // angle
  if (dim.type === "angle") {
    const l1 = readLineGeom(geo, dim.entities[0]);
    const l2 = readLineGeom(geo, dim.entities[1]);
    if (!l1 || !l2) return null;
    const ag = linesAngleGeometry(l1, l2);
    if (!ag) return null;
    const { vertex, d1, d2 } = ag;
    const R = Math.max(2, dim.offset);
    const arcEnd1 = add(vertex, scale(d1, R));
    const arcEnd2 = add(vertex, scale(d2, R));
    const ccw = cross(d1, d2) > 0;
    const sum = add(d1, d2);
    const bisectDir = len(sum) > 1e-6 ? normalize(sum) : perp(d1);
    const gap = R * 0.12;
    const perpSign = ccw ? 1 : -1;
    const arrow1Dir: Vec2 = { x: -d1.y * perpSign, y: d1.x * perpSign };
    const arrow2Dir: Vec2 = { x: d2.y * perpSign, y: -d2.x * perpSign };
    return {
      segments: [
        [add(vertex, scale(d1, gap)), arcEnd1],
        [add(vertex, scale(d2, gap)), arcEnd2],
      ],
      arrows: [
        { tip: arcEnd1, dir: arrow1Dir },
        { tip: arcEnd2, dir: arrow2Dir },
      ],
      textPos: add(vertex, scale(bisectDir, R + 3)),
      label: formatAngle(displayVal),
      arc: { center: vertex, radius: R, startDir: d1, endDir: d2, ccw },
    };
  }

  // linear
  let p: Vec2 | null = null;
  let q: Vec2 | null = null;

  if (dim.type === "line-distance") {
    const l1 = readLineGeom(geo, dim.entities[0]);
    const l2 = readLineGeom(geo, dim.entities[1]);
    if (!l1 || !l2) return null;
    const ref = add(l1.a, scale(sub(l1.b, l1.a), dim.anchors?.[0] ?? 0.5));
    ({ p, q } = resolveLineDistanceCrossing(ref, l1, l2));
  } else {
    p = readPoint(geo, dim.points[0]);
    q = readPoint(geo, dim.points[1]);
  }

  if (!p || !q) return null;
  const type = dim.type as LinearDimType;

  if (type === "line-distance") {
    // A gap dimension IS its span: the shaft runs from one line to the
    // other, arrows landing ON the two lines it measures, with no extension
    // lines and no perpendicular standoff.
    //
    // It used to offset both ends by `n` before drawing — but for two
    // parallel lines `n` is the ACROSS-the-gap direction, i.e. the very
    // direction being measured. So a non-zero offset slid the whole shaft
    // ALONG the measurement: both arrows moved off the lines (leaving one
    // outside the space entirely), and because the extension lines were
    // then collinear with the shaft, they read as line sticking out past
    // the arrowheads rather than as witness lines. Offsetting is meaningful
    // for a point-to-point dim, which can sit clear of the geometry; a gap
    // dim has nowhere to go but between the two lines. Sliding it ALONG
    // the lines is `anchors` — see resolveLineDistanceCrossing.
    const span = len(sub(q, p));
    const u = span > 1e-9 ? scale(sub(q, p), 1 / span) : { x: 1, y: 0 };
    const gapLabel = withExpr(dim, formatLengthWithUnit(displayVal, unit));
    const textRes = linearTextPos(p, q, u, gapLabel, pxPerMm);
    const segments: [Vec2, Vec2][] = [[p, q]];
    if (textRes.leaderSegment) segments.push(textRes.leaderSegment);
    return {
      segments,
      // Arrows point outward, each into the line it touches.
      arrows: [
        { tip: p, dir: scale(u, -1) },
        { tip: q, dir: u },
      ],
      textPos: textRes.pos,
      label: gapLabel,
    };
  }

  let p2: Vec2;
  let q2: Vec2;
  if (type === "horizontal") {
    const y = (p.y + q.y) / 2 + dim.offset;
    p2 = { x: p.x, y };
    q2 = { x: q.x, y };
  } else if (type === "vertical") {
    const x = (p.x + q.x) / 2 + dim.offset;
    p2 = { x, y: p.y };
    q2 = { x, y: q.y };
  } else {
    const n = linearNormal("distance", p, q);
    p2 = add(p, scale(n, dim.offset));
    q2 = add(q, scale(n, dim.offset));
  }

  const along = len(sub(q2, p2));
  const dir = along > 1e-9 ? scale(sub(q2, p2), 1 / along) : { x: 1, y: 0 };
  const linLabel = withExpr(dim, formatLengthWithUnit(displayVal, unit));
  const textRes = linearTextPos(p2, q2, dir, linLabel, pxPerMm);
  const segments: [Vec2, Vec2][] = [
    [p, p2],
    [q, q2],
    [p2, q2],
  ];
  if (textRes.leaderSegment) segments.push(textRes.leaderSegment);
  return {
    segments,
    arrows: [
      { tip: p2, dir: scale(dir, -1) },
      { tip: q2, dir },
    ],
    textPos: textRes.pos,
    label: linLabel,
  };
}

/**
 * Identity of what a dimension MEASURES, ignoring how it is drawn. Two
 * dimensions sharing this key measure exactly the same thing, so only one of
 * them can drive it — a second is redundant, and a third asking for a
 * different value is a contradiction the solver cannot resolve.
 */
export function dimensionSubjectKey(dim: Dimension): string {
  const ents = [...dim.entities].sort().join(",");
  const pts = dim.points
    .map((p) => `${p.entityId}:${p.key}`)
    .sort()
    .join(",");
  return `${dim.type}|${ents}|${pts}`;
}

/**
 * An existing DRIVING dimension already measuring the same thing, if any.
 *
 * Placing a second one is how a sketch quietly becomes unsolvable: a real file
 * arrived carrying three identical driving dimensions between a construction
 * line and the stock's bottom edge, after which every further dimension on
 * that distance failed to solve — with nothing having warned that the
 * duplicates were being created.
 */
export function findDrivingDuplicate(
  dim: Dimension,
  existing: readonly Dimension[],
): Dimension | null {
  const k = dimensionSubjectKey(dim);
  return existing.find((d) => d.driving && d.id !== dim.id && dimensionSubjectKey(d) === k) ?? null;
}

/**
 * World-distance from `pt` to the dimension's lines/text (for picking).
 * `pxPerMm` must match what the renderer passed to dimensionLayout, or the
 * clickable label sits somewhere other than the drawn one.
 */
export function dimensionHitDistance(
  dim: Dimension,
  geo: Geo,
  pt: Vec2,
  unit: Unit,
  pxPerMm?: number,
): number {
  const layout = dimensionLayout(dim, geo, unit, pxPerMm);
  if (!layout) return Infinity;
  let d = dist(pt, layout.textPos);
  for (const [a, b] of layout.segments) d = Math.min(d, distToSegment(pt, a, b));
  return d;
}

/**
 * Nudge a freshly-placed horizontal/vertical dimension's offset clear of any
 * EXISTING one of the same type whose line would otherwise land on top of (or
 * a hair from) it. The common trigger is chain dimensioning — two dimensions
 * measured from the same datum point naturally land on the same or a very
 * close offset (offset is derived purely from where you clicked to place THIS
 * one, with no awareness of what else is already there), so the shorter one's
 * shaft sits buried inside the longer one's rather than stacked cleanly
 * outward. Only applied at the moment a dimension is placed — it does not
 * re-run later if geometry moves and two placed-clear dimensions drift into
 * each other; that's an ordinary "drag it" case like any other overlap.
 *
 * Scoped to horizontal/vertical: their shaft is a straight run at a constant
 * X (or Y) over a range along the other axis, so "would these collide" is a
 * simple perpendicular-distance-and-range-overlap check. "distance"/
 * "line-distance" shafts aren't axis-aligned in general, and radius/diameter/
 * angle/arclength/circle-gap radiate from a centre rather than running
 * parallel — none of those share this specific failure mode.
 */
export function avoidDimensionCollision(
  dim: Dimension,
  existing: readonly Dimension[],
  geo: Geo,
  unit: Unit,
): number {
  if (dim.type !== "horizontal" && dim.type !== "vertical") return dim.offset;
  const STEP = 12; // mm — clear of a typical dimension-line label height
  const TOL = 8; // mm — how close two shafts can sit before they read as one
  const sign = dim.offset >= 0 ? 1 : -1;
  const others = existing.filter((d) => d.type === dim.type && !d.hidden);
  if (others.length === 0) return dim.offset;

  const shaftOf = (d: Dimension): { perp: number; lo: number; hi: number } | null => {
    const layout = dimensionLayout(d, geo, unit);
    if (!layout) return null;
    const [a, b] = layout.segments[2]; // the shaft itself: [p2, q2]
    return dim.type === "vertical"
      ? { perp: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) }
      : { perp: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) };
  };

  let offset = dim.offset;
  for (let guard = 0; guard < 20; guard++) {
    const probe = shaftOf({ ...dim, offset });
    if (!probe) return offset;
    const collided = others.some((o) => {
      const os = shaftOf(o);
      return os && Math.abs(probe.perp - os.perp) < TOL && probe.lo <= os.hi && os.lo <= probe.hi;
    });
    if (!collided) return offset;
    offset += sign * STEP;
  }
  return offset;
}
