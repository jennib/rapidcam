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
import { Entity, EntityId, LineEntity, CircleEntity, ArcEntity, PolylineEntity } from "./entities";
import { angleInArc } from "../core/geom";
import { nextId } from "./ids";

export type ConstraintType =
  | "coincident"    // points[2]                     → the two points are equal
  | "horizontal"    // entities[1] (line)             → endpoints share Y
  | "vertical"      // entities[1] (line)             → endpoints share X
  | "parallel"      // entities[2] (lines)
  | "perpendicular" // entities[2] (lines)
  | "equal"         // entities[2] (lines→length, or circles/arcs→radius)
  | "concentric"    // entities[2] (circles/arcs)     → centres coincide
  | "pointOnLine"   // points[1] + entities[1] (line)
  | "tangent"       // entities[2] (line+circle, line+arc, arc+arc, etc.)
  | "pointOnArc"    // points[1] + entities[1] (arc)
  | "pointOnCircle" // points[1] + entities[1] (circle)
  | "symmetric"     // points[2] + entities[1] (line) → symmetric about the line
  | "collinear"     // entities[2] (lines)             → both on same infinite line
  | "midpoint"      // points[1] + entities[1] (line) → point at midpoint of line; or points[3] → points[0] at midpoint of points[1]–points[2]
  | "angle"         // entities[2] (lines) + params[0]=target radians → fixed angle
  | "fixedPoint"    // points[1+] + params[0]=x, params[1]=y → pin point to world pos
  | "fixed";        // entities[1+]                   → lock all its DOFs (no equation)

/** A reference to one specific point DOF inside an entity. */
export interface PointRef {
  entityId: EntityId;
  key: string;
}

/** A reference to one segment (vertex `index` → `index`+1) of a polyline. */
export interface SegmentRef {
  entityId: EntityId;
  index: number;
}
export const sameSegmentRef = (a: SegmentRef, b: SegmentRef): boolean =>
  a.entityId === b.entityId && a.index === b.index;

export interface Constraint {
  id: string;
  type: ConstraintType;
  points: PointRef[];
  entities: EntityId[];
  params?: number[]; // type-specific numeric parameters (e.g. target angle, target position)
}

export function makeConstraint(
  type: ConstraintType,
  opts: { points?: PointRef[]; entities?: EntityId[]; params?: number[] },
): Constraint {
  return { id: nextId("con"), type, points: opts.points ?? [], entities: opts.entities ?? [], params: opts.params };
}

export const pointRefKey = (r: PointRef): string => `${r.entityId}:${r.key}`;
export const samePointRef = (a: PointRef, b: PointRef): boolean =>
  a.entityId === b.entityId && a.key === b.key;

/**
 * A polyline segment can stand in for a line in any line-type constraint. It is
 * encoded inside the constraint's `entities` array as `${polylineId}#${index}`
 * (segment from vertex `index` to `index+1`). `lineRefEntityId` recovers the
 * underlying entity id (for pruning/DOF purposes).
 */
export const SEGMENT_SEP = "#";
export function segmentRef(polylineId: EntityId, index: number): EntityId {
  return `${polylineId}${SEGMENT_SEP}${index}`;
}
export function lineRefEntityId(ref: EntityId): EntityId {
  const i = ref.indexOf(SEGMENT_SEP);
  return i >= 0 ? ref.slice(0, i) : ref;
}

/** Every entity id a constraint touches (used to prune on delete). */
export function constraintEntityIds(c: Constraint): EntityId[] {
  return [...c.entities.map(lineRefEntityId), ...c.points.map((p) => p.entityId)];
}

// ---------------------------------------------------------------------------
// Geometry access (live view over the document's entities)

export type Geo = (id: EntityId) => Entity | undefined;

function asLine(geo: Geo, id: EntityId): LineEntity | null {
  const e = geo(id);
  return e instanceof LineEntity ? e : null;
}

/** The two endpoints of a line. */
export interface LineGeom { a: Vec2; b: Vec2; }

/**
 * Resolve a line reference to its live endpoints. Accepts a LineEntity id or a
 * polyline-segment ref (`polylineId#index`). Returns null for non-line refs
 * (circles, arcs, missing entities) so callers can fall through.
 */
function lineGeom(geo: Geo, ref: EntityId | undefined): LineGeom | null {
  if (!ref) return null; // entity-less constraint (e.g. point-pair horizontal/vertical) — let caller fall through
  const sep = ref.indexOf(SEGMENT_SEP);
  if (sep >= 0) {
    const poly = geo(ref.slice(0, sep));
    if (!(poly instanceof PolylineEntity)) return null;
    const i = parseInt(ref.slice(sep + 1), 10);
    const n = poly.points.length;
    if (!Number.isFinite(i) || i < 0 || i >= n) return null;
    const j = i + 1 < n ? i + 1 : (poly.closed ? 0 : -1);
    if (j < 0) return null;
    return { a: poly.points[i], b: poly.points[j] };
  }
  const l = asLine(geo, ref);
  return l ? { a: l.a, b: l.b } : null;
}
function asCircle(geo: Geo, id: EntityId): CircleEntity | null {
  const e = geo(id);
  return e instanceof CircleEntity ? e : null;
}
function asArc(geo: Geo, id: EntityId): ArcEntity | null {
  const e = geo(id);
  return e instanceof ArcEntity ? e : null;
}
function circularGeom(geo: Geo, id: EntityId): { center: Vec2; radius: number } | null {
  const c = asCircle(geo, id);
  if (c) return { center: c.center, radius: c.radius };
  const a = asArc(geo, id);
  if (a) return { center: a.center, radius: a.radius };
  return null;
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
      const l = lineGeom(geo, c.entities[0]);
      if (l) return [l.a.y - l.b.y];
      const [p, q] = readPair(geo, c.points);
      return p && q ? [p.y - q.y] : [];
    }
    case "vertical": {
      const l = lineGeom(geo, c.entities[0]);
      if (l) return [l.a.x - l.b.x];
      const [p, q] = readPair(geo, c.points);
      return p && q ? [p.x - q.x] : [];
    }
    case "parallel": {
      const l1 = lineGeom(geo, c.entities[0]);
      const l2 = lineGeom(geo, c.entities[1]);
      if (!l1 || !l2) return [];
      // sin(angle between) = cross of unit directions
      return [cross(unitDir(l1), unitDir(l2))];
    }
    case "perpendicular": {
      const l1 = lineGeom(geo, c.entities[0]);
      const l2 = lineGeom(geo, c.entities[1]);
      if (!l1 || !l2) return [];
      // cos(angle between) = dot of unit directions
      return [dot(unitDir(l1), unitDir(l2))];
    }
    case "equal": {
      const l1 = lineGeom(geo, c.entities[0]);
      const l2 = lineGeom(geo, c.entities[1]);
      if (l1 && l2) return [lineLen(l1) - lineLen(l2)];
      const r1 = (asCircle(geo, c.entities[0]) ?? asArc(geo, c.entities[0]))?.radius;
      const r2 = (asCircle(geo, c.entities[1]) ?? asArc(geo, c.entities[1]))?.radius;
      if (r1 !== undefined && r2 !== undefined) return [r1 - r2];
      return [];
    }
    case "concentric": {
      const cen1 = (asCircle(geo, c.entities[0]) ?? asArc(geo, c.entities[0]))?.center;
      const cen2 = (asCircle(geo, c.entities[1]) ?? asArc(geo, c.entities[1]))?.center;
      if (!cen1 || !cen2) return [];
      return [cen1.x - cen2.x, cen1.y - cen2.y];
    }
    case "pointOnLine": {
      const p = readPoint(geo, c.points[0]);
      const l = lineGeom(geo, c.entities[0]);
      if (!p || !l) return [];
      return [signedLineDistance(l, p)];
    }
    case "tangent": {
      const l = lineGeom(geo, c.entities[0]) ?? lineGeom(geo, c.entities[1]);
      if (l) {
        const circ = asCircle(geo, c.entities[1]) ?? asCircle(geo, c.entities[0]);
        if (circ) return [Math.abs(signedLineDistance(l, circ.center)) - circ.radius];
        const arc = asArc(geo, c.entities[1]) ?? asArc(geo, c.entities[0]);
        if (arc) return [Math.abs(signedLineDistance(l, arc.center)) - arc.radius];
        return [];
      }
      // Circular–circular tangency: covers arc+arc, arc+circle, circle+circle.
      // Returns a signed residual so the solver gradient is well-defined everywhere.
      const g1 = circularGeom(geo, c.entities[0]);
      const g2 = circularGeom(geo, c.entities[1]);
      if (g1 && g2) return [circularTangencyResidual(g1, g2)];
      return [];
    }
    case "pointOnArc": {
      const p = readPoint(geo, c.points[0]);
      const arc = asArc(geo, c.entities[0]);
      if (!p || !arc) return [];
      return [len(sub(p, arc.center)) - arc.radius];
    }
    case "symmetric": {
      // points[0] and points[1] are symmetric about the infinite line of entities[0].
      const p = readPoint(geo, c.points[0]);
      const q = readPoint(geo, c.points[1]);
      const l = lineGeom(geo, c.entities[0]);
      if (!p || !q || !l) return [];
      // The midpoint of p and q must lie on the line, and p-q must be perpendicular to the line.
      const m = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      const pq = sub(q, p);
      const ld = sub(l.b, l.a);
      const lLen = len(ld);
      if (lLen < 1e-9) return [];
      const lu = { x: ld.x / lLen, y: ld.y / lLen };
      return [
        signedLineDistance(l, m),  // midpoint on the line
        dot(pq, lu),               // p-q perpendicular to line
      ];
    }
    case "collinear": {
      const l1 = lineGeom(geo, c.entities[0]);
      const l2 = lineGeom(geo, c.entities[1]);
      if (!l1 || !l2) return [];
      // Both endpoints of l2 lie on the infinite line of l1.
      return [signedLineDistance(l1, l2.a), signedLineDistance(l1, l2.b)];
    }
    case "midpoint": {
      const p = readPoint(geo, c.points[0]);
      if (!p) return [];
      if (c.entities.length > 0) {
        const l = lineGeom(geo, c.entities[0]);
        if (!l) return [];
        const m = { x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 };
        return [p.x - m.x, p.y - m.y];
      }
      // Two-point variant: points[0] is the midpoint of points[1]–points[2].
      const a = readPoint(geo, c.points[1]);
      const b = readPoint(geo, c.points[2]);
      if (!a || !b) return [];
      return [p.x - (a.x + b.x) / 2, p.y - (a.y + b.y) / 2];
    }
    case "pointOnCircle": {
      const p = readPoint(geo, c.points[0]);
      const circ = asCircle(geo, c.entities[0]);
      if (!p || !circ) return [];
      return [len(sub(p, circ.center)) - circ.radius];
    }
    case "angle": {
      const l1 = lineGeom(geo, c.entities[0]);
      const l2 = lineGeom(geo, c.entities[1]);
      if (!l1 || !l2) return [];
      const alpha = c.params?.[0] ?? 0;
      const u1 = unitDir(l1), u2 = unitDir(l2);
      // sin(θ − α) = 0  where θ is the signed angle from l1 to l2
      return [cross(u1, u2) * Math.cos(alpha) - dot(u1, u2) * Math.sin(alpha)];
    }
    case "fixedPoint": {
      const p = readPoint(geo, c.points[0]);
      if (!p || !c.params) return [];
      return [p.x - c.params[0], p.y - c.params[1]];
    }
    case "fixed":
      return []; // enforced by removing DOFs, not by an equation
  }
}

/** Signed angle (radians, range −π..π) from l1's direction to l2's direction. */
export function measureAngleBetweenLines(l1: LineGeom, l2: LineGeom): number {
  const u1 = unitDir(l1), u2 = unitDir(l2);
  return Math.atan2(cross(u1, u2), dot(u1, u2));
}

/** Public resolver so callers (e.g. the constraint bar) can read a line ref's endpoints. */
export function resolveLineGeom(geo: Geo, ref: EntityId): LineGeom | null {
  return lineGeom(geo, ref);
}

function readPair(geo: Geo, pts: PointRef[]): [Vec2 | null, Vec2 | null] {
  return [pts[0] ? readPoint(geo, pts[0]) : null, pts[1] ? readPoint(geo, pts[1]) : null];
}
function unitDir(l: LineGeom): Vec2 {
  return normalize(sub(l.b, l.a));
}
function lineLen(l: LineGeom): number {
  return len(sub(l.b, l.a));
}
/** Signed perpendicular distance from point `p` to the infinite line through l.a,l.b. */
function signedLineDistance(l: LineGeom, p: Vec2): number {
  const d = sub(l.b, l.a);
  const L = len(d);
  if (L < 1e-9) return len(sub(p, l.a));
  return cross(d, sub(p, l.a)) / L;
}
/**
 * Signed tangency residual for two circular entities (arc or circle).
 * Picks external (d = r1+r2) or internal (d = |r1−r2|) based on which is closer
 * to the current geometry, returning a smooth signed value the solver can zero.
 */
function circularTangencyResidual(
  g1: { center: Vec2; radius: number },
  g2: { center: Vec2; radius: number },
): number {
  const d = len(sub(g1.center, g2.center));
  const ext = d - g1.radius - g2.radius;
  const int_ = d - Math.abs(g1.radius - g2.radius);
  return Math.abs(ext) <= Math.abs(int_) ? ext : int_;
}

/**
 * For a line↔arc tangent constraint, report whether the point where the line
 * actually touches the underlying circle falls OUTSIDE the arc's angular sweep.
 * The constraint is still mathematically valid (tangency is defined against the
 * full circle, as in most CAD kernels), but in that case the visible arc segment
 * won't physically touch the line — worth warning the user about. Returns false
 * for non-line/arc tangents (arc–arc, circle, etc.) where there's no single
 * unambiguous contact direction to check.
 */
export function tangentContactOutsideArcSweep(c: Constraint, geo: Geo): boolean {
  if (c.type !== "tangent") return false;
  const l = lineGeom(geo, c.entities[0]) ?? lineGeom(geo, c.entities[1]);
  const arc = asArc(geo, c.entities[0]) ?? asArc(geo, c.entities[1]);
  if (!l || !arc) return false;
  // Foot of perpendicular from the arc centre to the infinite line; the tangent
  // point lies on the ray from the centre through that foot.
  const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-12) return false;
  const t = ((arc.center.x - l.a.x) * dx + (arc.center.y - l.a.y) * dy) / L2;
  const footX = l.a.x + t * dx, footY = l.a.y + t * dy;
  const ang = Math.atan2(footY - arc.center.y, footX - arc.center.x);
  return !angleInArc(ang, arc.startAngle, arc.endAngle);
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
  pointOnArc: "⌒",
  pointOnCircle: "○",
  symmetric: "↔",
  collinear: "◀▶",
  midpoint: "M",
  angle: "∠",
  fixedPoint: "⊕",
  fixed: "⚓",
};

/** World-space anchors near which to draw the constraint's glyph badges. */
export function constraintAnchors(c: Constraint, geo: Geo): Vec2[] {
  const anchors: Vec2[] = [];
  
  switch (c.type) {
    case "coincident": {
      const pt = c.points[0] ? readPoint(geo, c.points[0]) : null;
      if (pt) anchors.push({ ...pt });
      break;
    }
    case "symmetric": {
      const p = readPoint(geo, c.points[0]);
      const q = readPoint(geo, c.points[1]);
      if (p && q) anchors.push({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
      break;
    }
    case "pointOnLine": {
      const p = readPoint(geo, c.points[0]);
      if (p) anchors.push({ ...p });
      const l = lineGeom(geo, c.entities[0]);
      if (l) anchors.push(mid(l.a, l.b));
      break;
    }
    case "pointOnArc": {
      const p = readPoint(geo, c.points[0]);
      if (p) anchors.push({ ...p });
      const arc = asArc(geo, c.entities[0]);
      if (arc) {
        let end = arc.endAngle;
        if (end < arc.startAngle) end += 2 * Math.PI;
        const midAngle = (arc.startAngle + end) / 2;
        anchors.push({
          x: arc.center.x + arc.radius * Math.cos(midAngle),
          y: arc.center.y + arc.radius * Math.sin(midAngle),
        });
      }
      break;
    }
    case "pointOnCircle": {
      const p = readPoint(geo, c.points[0]);
      if (p) anchors.push({ ...p });
      const circ = asCircle(geo, c.entities[0]);
      if (circ) {
        // Anchor at the point on the circle nearest to the constrained point
        if (p) {
          const dx = p.x - circ.center.x, dy = p.y - circ.center.y;
          const len = Math.hypot(dx, dy) || 1;
          anchors.push({ x: circ.center.x + dx / len * circ.radius, y: circ.center.y + dy / len * circ.radius });
        } else {
          anchors.push({ x: circ.center.x, y: circ.center.y + circ.radius });
        }
      }
      break;
    }
    case "midpoint":
    case "fixedPoint": {
      const p = readPoint(geo, c.points[0]);
      if (p) anchors.push({ ...p });
      break;
    }
    case "horizontal":
    case "vertical": {
      const l = lineGeom(geo, c.entities[0]);
      if (l) {
        anchors.push(mid(l.a, l.b));
      } else {
        const p1 = readPoint(geo, c.points[0]);
        const p2 = readPoint(geo, c.points[1]);
        if (p1) anchors.push({ ...p1 });
        if (p2) anchors.push({ ...p2 });
      }
      break;
    }
    case "parallel":
    case "equal":
    case "collinear":
    case "tangent":
    case "angle": {
      for (const eid of c.entities) {
        const lg = lineGeom(geo, eid);
        if (lg) { anchors.push(mid(lg.a, lg.b)); continue; }
        const e = geo(eid);
        if (e instanceof CircleEntity) anchors.push({ ...e.center });
        else if (e instanceof ArcEntity) anchors.push({ ...e.center });
      }
      break;
    }
    case "concentric": {
      for (const eid of c.entities) {
        const circ = asCircle(geo, eid) ?? asArc(geo, eid);
        if (circ) anchors.push({ ...circ.center });
      }
      break;
    }
    case "perpendicular": {
      const l1 = lineGeom(geo, c.entities[0]);
      const l2 = lineGeom(geo, c.entities[1]);
      if (l1 && l2) {
        // Find closest endpoint to the other line to approximate the corner
        const cornerOnL1 = Math.abs(signedLineDistance(l2, l1.a)) < Math.abs(signedLineDistance(l2, l1.b)) ? l1.a : l1.b;
        const cornerOnL2 = Math.abs(signedLineDistance(l1, l2.a)) < Math.abs(signedLineDistance(l1, l2.b)) ? l2.a : l2.b;
        
        // Push slightly away from the exact endpoint towards the midpoint so it's not right on top of a point constraint
        const m1 = mid(l1.a, l1.b);
        const m2 = mid(l2.a, l2.b);
        anchors.push({ x: cornerOnL1.x * 0.8 + m1.x * 0.2, y: cornerOnL1.y * 0.8 + m1.y * 0.2 });
        anchors.push({ x: cornerOnL2.x * 0.8 + m2.x * 0.2, y: cornerOnL2.y * 0.8 + m2.y * 0.2 });
      }
      break;
    }
    case "fixed": {
      for (const eid of c.entities) {
        const e = geo(eid);
        if (e) {
          const b = e.bounds();
          anchors.push({ x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 });
        }
      }
      break;
    }
  }
  
  return anchors;
}
