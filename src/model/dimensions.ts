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
  Vec2,
  sub,
  add,
  scale,
  mid,
  dist,
  len,
  normalize,
  perp,
  angle as vecAngle,
} from "../core/vec2";
import { distToSegment } from "../core/geom";
import { Unit, formatLengthWithUnit } from "../core/units";
import { EntityId, CircleEntity } from "./entities";
import { Geo, PointRef } from "./constraints";
import { nextId } from "./ids";

export type DimensionType = "distance" | "horizontal" | "vertical" | "radius" | "diameter" | "angle";
export type LinearDimType = "distance" | "horizontal" | "vertical";

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
}

export function makeDimension(
  type: DimensionType,
  opts: { points?: PointRef[]; entities?: EntityId[]; value: number; offset: number; driving?: boolean },
): Dimension {
  return {
    id: nextId("dim"),
    type,
    points: opts.points ?? [],
    entities: opts.entities ?? [],
    value: opts.value,
    driving: opts.driving ?? true,
    offset: opts.offset,
  };
}

export const LEADER_MM = 9; // world-space leader length for radius/diameter

// ---------------------------------------------------------------------------
// Geometry access

function readPoint(geo: Geo, ref: PointRef | undefined): Vec2 | null {
  if (!ref) return null;
  const e = geo(ref.entityId);
  if (!e) return null;
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
      const c = readCircle(geo, dim.entities[0]);
      return c ? c.radius : null;
    }
    case "diameter": {
      const c = readCircle(geo, dim.entities[0]);
      return c ? c.radius * 2 : null;
    }
    case "angle":
      return null; // not yet supported
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

/** Recompute `offset` from the cursor for the dimension's current type. */
export function dimensionOffsetFromCursor(dim: Dimension, geo: Geo, cursor: Vec2): number {
  if (dim.type === "radius" || dim.type === "diameter") {
    const c = readCircle(geo, dim.entities[0]);
    return c ? vecAngle(sub(cursor, c.center)) : dim.offset;
  }
  const p = readPoint(geo, dim.points[0]);
  const q = readPoint(geo, dim.points[1]);
  if (!p || !q) return dim.offset;
  const m = mid(p, q);
  if (dim.type === "horizontal") return cursor.y - m.y;
  if (dim.type === "vertical") return cursor.x - m.x;
  // aligned
  return dot2(sub(cursor, m), linearNormal("distance", p, q));
}

export function dimensionLayout(dim: Dimension, geo: Geo, unit: Unit): DimLayout | null {
  const displayVal = dim.driving ? dim.value : (dimensionMeasure(dim, geo) ?? 0);

  if (dim.type === "radius" || dim.type === "diameter") {
    const c = readCircle(geo, dim.entities[0]);
    if (!c) return null;
    const u = { x: Math.cos(dim.offset), y: Math.sin(dim.offset) };
    if (dim.type === "radius") {
      const edge = add(c.center, scale(u, c.radius));
      const end = add(c.center, scale(u, c.radius + LEADER_MM));
      return {
        segments: [[c.center, end]],
        arrows: [{ tip: edge, dir: u }],
        textPos: end,
        label: "R" + formatLengthWithUnit(displayVal, unit),
      };
    }
    const e1 = add(c.center, scale(u, c.radius));
    const e2 = sub(c.center, scale(u, c.radius));
    const end = add(c.center, scale(u, c.radius + LEADER_MM));
    return {
      segments: [[e2, end]],
      arrows: [
        { tip: e1, dir: u },
        { tip: e2, dir: scale(u, -1) },
      ],
      textPos: end,
      label: "⌀" + formatLengthWithUnit(displayVal, unit),
    };
  }

  // linear
  const p = readPoint(geo, dim.points[0]);
  const q = readPoint(geo, dim.points[1]);
  if (!p || !q) return null;
  const type = dim.type as LinearDimType;

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
  return {
    segments: [
      [p, p2],
      [q, q2],
      [p2, q2],
    ],
    arrows: [
      { tip: p2, dir: scale(dir, -1) },
      { tip: q2, dir },
    ],
    textPos: mid(p2, q2),
    label: formatLengthWithUnit(displayVal, unit),
  };
}

/** World-distance from `pt` to the dimension's lines/text (for picking). */
export function dimensionHitDistance(dim: Dimension, geo: Geo, pt: Vec2, unit: Unit): number {
  const layout = dimensionLayout(dim, geo, unit);
  if (!layout) return Infinity;
  let d = dist(pt, layout.textPos);
  for (const [a, b] of layout.segments) d = Math.min(d, distToSegment(pt, a, b));
  return d;
}

const dot2 = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
