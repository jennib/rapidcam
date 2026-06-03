/**
 * Parametric constraints.
 *
 * Each constraint contributes one or more EQUATIONS that the solver drives to
 * zero (the residual). Constraints reference geometry two ways:
 *   - `points`   : specific point DOFs inside an entity (e.g. a line endpoint)
 *   - `entities` : whole entities (lines / circles)
 * which combination a constraint uses depends on its type (see RESIDUALS below).
 *
 * Residuals for direction-based constraints are normalised (divided by lengths)
 * so every equation is roughly in millimetres / unit scale — this keeps the
 * numerical solver well-conditioned across mixed constraint types.
 */

import { Vec2, sub, dot, cross, len, normalize, mid } from "../core/vec2";
import { Entity, EntityId, LineEntity, CircleEntity } from "./entities";
import { nextId } from "./ids";

export type ConstraintType =
  | "coincident" // points[2]            → the two points are equal
  | "horizontal" // entities[1] (line)   → endpoints share Y
  | "vertical" //   entities[1] (line)   → endpoints share X
  | "parallel" //   entities[2] (lines)
  | "perpendicular" // entities[2] (lines)
  | "equal" //      entities[2] (lines→length, or circles→radius)
  | "concentric" //  entities[2] (circles) → centres coincide
  | "pointOnLine" //  points[1] + entities[1] (line)
  | "tangent" //     entities[2] (line + circle)
  | "fixed"; //      entities[1+]         → lock all its DOFs (no equation)

/** A reference to one specific point DOF inside an entity. */
export interface PointRef {
  entityId: EntityId;
  key: string;
}

export interface Constraint {
  id: string;
  type: ConstraintType;
  points: PointRef[];
  entities: EntityId[];
}

export function makeConstraint(
  type: ConstraintType,
  opts: { points?: PointRef[]; entities?: EntityId[] },
): Constraint {
  return { id: nextId("con"), type, points: opts.points ?? [], entities: opts.entities ?? [] };
}

export const pointRefKey = (r: PointRef): string => `${r.entityId}:${r.key}`;
export const samePointRef = (a: PointRef, b: PointRef): boolean =>
  a.entityId === b.entityId && a.key === b.key;

/** Every entity id a constraint touches (used to prune on delete). */
export function constraintEntityIds(c: Constraint): EntityId[] {
  return [...c.entities, ...c.points.map((p) => p.entityId)];
}

// ---------------------------------------------------------------------------
// Geometry access (live view over the document's entities)

export type Geo = (id: EntityId) => Entity | undefined;

function asLine(geo: Geo, id: EntityId): LineEntity | null {
  const e = geo(id);
  return e instanceof LineEntity ? e : null;
}
function asCircle(geo: Geo, id: EntityId): CircleEntity | null {
  const e = geo(id);
  return e instanceof CircleEntity ? e : null;
}
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

// ---------------------------------------------------------------------------
// Residuals

/** Equations for one constraint, each of which the solver drives to 0. */
export function constraintResiduals(c: Constraint, geo: Geo): number[] {
  switch (c.type) {
    case "coincident": {
      const a = readPoint(geo, c.points[0]);
      const b = readPoint(geo, c.points[1]);
      if (!a || !b) return [];
      return [a.x - b.x, a.y - b.y];
    }
    case "horizontal": {
      const l = asLine(geo, c.entities[0]);
      if (l) return [l.a.y - l.b.y];
      const [p, q] = readPair(geo, c.points);
      return p && q ? [p.y - q.y] : [];
    }
    case "vertical": {
      const l = asLine(geo, c.entities[0]);
      if (l) return [l.a.x - l.b.x];
      const [p, q] = readPair(geo, c.points);
      return p && q ? [p.x - q.x] : [];
    }
    case "parallel": {
      const l1 = asLine(geo, c.entities[0]);
      const l2 = asLine(geo, c.entities[1]);
      if (!l1 || !l2) return [];
      // sin(angle between) = cross of unit directions
      return [cross(unitDir(l1), unitDir(l2))];
    }
    case "perpendicular": {
      const l1 = asLine(geo, c.entities[0]);
      const l2 = asLine(geo, c.entities[1]);
      if (!l1 || !l2) return [];
      // cos(angle between) = dot of unit directions
      return [dot(unitDir(l1), unitDir(l2))];
    }
    case "equal": {
      const l1 = asLine(geo, c.entities[0]);
      const l2 = asLine(geo, c.entities[1]);
      if (l1 && l2) return [l1.length - l2.length];
      const c1 = asCircle(geo, c.entities[0]);
      const c2 = asCircle(geo, c.entities[1]);
      if (c1 && c2) return [c1.radius - c2.radius];
      return [];
    }
    case "concentric": {
      const c1 = asCircle(geo, c.entities[0]);
      const c2 = asCircle(geo, c.entities[1]);
      if (!c1 || !c2) return [];
      return [c1.center.x - c2.center.x, c1.center.y - c2.center.y];
    }
    case "pointOnLine": {
      const p = readPoint(geo, c.points[0]);
      const l = asLine(geo, c.entities[0]);
      if (!p || !l) return [];
      return [signedLineDistance(l, p)];
    }
    case "tangent": {
      const l = asLine(geo, c.entities[0]) ?? asLine(geo, c.entities[1]);
      const circ = asCircle(geo, c.entities[1]) ?? asCircle(geo, c.entities[0]);
      if (!l || !circ) return [];
      return [Math.abs(signedLineDistance(l, circ.center)) - circ.radius];
    }
    case "fixed":
      return []; // enforced by removing DOFs, not by an equation
  }
}

function readPair(geo: Geo, pts: PointRef[]): [Vec2 | null, Vec2 | null] {
  return [pts[0] ? readPoint(geo, pts[0]) : null, pts[1] ? readPoint(geo, pts[1]) : null];
}
function unitDir(l: LineEntity): Vec2 {
  return normalize(sub(l.b, l.a));
}
/** Signed perpendicular distance from point `p` to the infinite line through l.a,l.b. */
function signedLineDistance(l: LineEntity, p: Vec2): number {
  const d = sub(l.b, l.a);
  const L = len(d);
  if (L < 1e-9) return len(sub(p, l.a));
  return cross(d, sub(p, l.a)) / L;
}

// ---------------------------------------------------------------------------
// Rendering helpers

export const CONSTRAINT_GLYPH: Record<ConstraintType, string> = {
  coincident: "+",
  horizontal: "H",
  vertical: "V",
  parallel: "∥",
  perpendicular: "⟂",
  equal: "=",
  concentric: "◎",
  pointOnLine: "—",
  tangent: "T",
  fixed: "⚓",
};

/** A world-space anchor near which to draw the constraint's glyph badge. */
export function constraintAnchor(c: Constraint, geo: Geo): Vec2 | null {
  switch (c.type) {
    case "coincident":
    case "pointOnLine":
      return c.points[0] ? readPoint(geo, c.points[0]) : null;
    case "horizontal":
    case "vertical": {
      const l = asLine(geo, c.entities[0]);
      return l ? mid(l.a, l.b) : null;
    }
    case "parallel":
    case "perpendicular":
    case "equal": {
      const l = asLine(geo, c.entities[0]);
      if (l) return mid(l.a, l.b);
      const circ = asCircle(geo, c.entities[0]);
      return circ ? { ...circ.center } : null;
    }
    case "concentric": {
      const circ = asCircle(geo, c.entities[0]);
      return circ ? { ...circ.center } : null;
    }
    case "tangent": {
      const circ = asCircle(geo, c.entities[1]) ?? asCircle(geo, c.entities[0]);
      return circ ? { ...circ.center } : null;
    }
    case "fixed": {
      const e = geo(c.entities[0]);
      if (!e) return null;
      const b = e.bounds();
      return { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 };
    }
  }
}
