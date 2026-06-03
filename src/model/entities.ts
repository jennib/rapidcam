/**
 * Geometric entities.
 *
 * Entities are PURE GEOMETRY — they know nothing about the canvas or how they
 * are drawn. Rendering lives in the view layer (renderer.ts) and dispatches on
 * `type`. Keeping entities free of any drawing/DOM dependency means the same
 * model can later feed the CAM/toolpath layer directly.
 *
 * All coordinates are in document millimetres, in a Y-up world frame.
 */

import { Vec2, clone, add, mid, dist } from "../core/vec2";
import { distToSegment, distToCircle, clamp } from "../core/geom";
import { nextId } from "./ids";

export type EntityId = string;
export type EntityType = "line" | "circle" | "rectangle" | "polyline";

export interface Bounds {
  min: Vec2;
  max: Vec2;
}

export type SnapKind = "endpoint" | "midpoint" | "center" | "quadrant" | "vertex";

export interface SnapPoint {
  pos: Vec2;
  kind: SnapKind;
  entityId: EntityId;
}

/** A draggable/solvable point degree-of-freedom, addressed within an entity by `key`. */
export interface DofPoint {
  key: string;
  pos: Vec2;
}

/** A scalar degree-of-freedom (e.g. a circle radius). */
export interface DofScalar {
  key: string;
  value: number;
}

export abstract class Entity {
  readonly id: EntityId;
  abstract readonly type: EntityType;
  selected = false;
  isConstruction = false;

  constructor(id?: EntityId) {
    this.id = id ?? nextId("ent");
  }

  /** Axis-aligned bounding box in world mm. */
  abstract bounds(): Bounds;
  /** Shortest world-distance from `p` to this entity's outline (for hit-testing). */
  abstract distanceTo(p: Vec2): number;
  /** Object snap points exposed by this entity. */
  abstract snapPoints(): SnapPoint[];
  /** Move the whole entity by `d` (mm). */
  abstract translate(d: Vec2): void;
  /** Deep copy with a fresh id. */
  abstract duplicate(): Entity;

  // --- degrees of freedom (for picking, dragging, and the constraint solver) ---
  // Entities that don't participate in solving (e.g. rectangles) keep the
  // empty defaults and are simply treated as fixed geometry.

  /** Point DOFs the user can grab and the solver can vary. */
  dofPoints(): DofPoint[] {
    return [];
  }
  /** All points that the user can pick to select or constrain. By default same as dofPoints. */
  pickablePoints(): DofPoint[] {
    return this.dofPoints();
  }
  /** Returns which DOF components are affected/controlled by a point key. */
  dofsAffectedBy(key: string): { key: string; axis: "x" | "y" }[] {
    return [
      { key, axis: "x" },
      { key, axis: "y" },
    ];
  }
  /** Read a point DOF by key. */
  getPoint(key: string): Vec2 {
    throw new Error(`${this.type} has no point '${key}'`);
  }
  /** Write a point DOF by key. */
  setPoint(_key: string, _v: Vec2): void {}
  /** Scalar DOFs (e.g. radius). */
  dofScalars(): DofScalar[] {
    return [];
  }
  /** Write a scalar DOF by key. */
  setScalar(_key: string, _v: number): void {}
}

// ---------------------------------------------------------------------------

export class LineEntity extends Entity {
  readonly type = "line" as const;
  a: Vec2;
  b: Vec2;

  constructor(a: Vec2, b: Vec2, id?: EntityId) {
    super(id);
    this.a = clone(a);
    this.b = clone(b);
  }

  override bounds(): Bounds {
    return {
      min: { x: Math.min(this.a.x, this.b.x), y: Math.min(this.a.y, this.b.y) },
      max: { x: Math.max(this.a.x, this.b.x), y: Math.max(this.a.y, this.b.y) },
    };
  }
  override distanceTo(p: Vec2): number {
    return distToSegment(p, this.a, this.b);
  }
  override snapPoints(): SnapPoint[] {
    return [
      { pos: clone(this.a), kind: "endpoint", entityId: this.id },
      { pos: clone(this.b), kind: "endpoint", entityId: this.id },
      { pos: mid(this.a, this.b), kind: "midpoint", entityId: this.id },
    ];
  }
  override translate(d: Vec2): void {
    this.a = add(this.a, d);
    this.b = add(this.b, d);
  }
  override duplicate(): LineEntity {
    const e = new LineEntity(this.a, this.b);
    e.isConstruction = this.isConstruction;
    return e;
  }
  get length(): number {
    return dist(this.a, this.b);
  }
  override dofPoints(): DofPoint[] {
    return [
      { key: "a", pos: clone(this.a) },
      { key: "b", pos: clone(this.b) },
    ];
  }
  override getPoint(key: string): Vec2 {
    if (key === "a") return clone(this.a);
    if (key === "b") return clone(this.b);
    return super.getPoint(key);
  }
  override setPoint(key: string, v: Vec2): void {
    if (key === "a") this.a = clone(v);
    else if (key === "b") this.b = clone(v);
  }
}

// ---------------------------------------------------------------------------

export class CircleEntity extends Entity {
  readonly type = "circle" as const;
  center: Vec2;
  radius: number;

  constructor(center: Vec2, radius: number, id?: EntityId) {
    super(id);
    this.center = clone(center);
    this.radius = Math.abs(radius);
  }

  override bounds(): Bounds {
    return {
      min: { x: this.center.x - this.radius, y: this.center.y - this.radius },
      max: { x: this.center.x + this.radius, y: this.center.y + this.radius },
    };
  }
  override distanceTo(p: Vec2): number {
    return distToCircle(p, this.center, this.radius);
  }
  override snapPoints(): SnapPoint[] {
    const c = this.center;
    const r = this.radius;
    return [
      { pos: clone(c), kind: "center", entityId: this.id },
      { pos: { x: c.x + r, y: c.y }, kind: "quadrant", entityId: this.id },
      { pos: { x: c.x - r, y: c.y }, kind: "quadrant", entityId: this.id },
      { pos: { x: c.x, y: c.y + r }, kind: "quadrant", entityId: this.id },
      { pos: { x: c.x, y: c.y - r }, kind: "quadrant", entityId: this.id },
    ];
  }
  override translate(d: Vec2): void {
    this.center = add(this.center, d);
  }
  override duplicate(): CircleEntity {
    const e = new CircleEntity(this.center, this.radius);
    e.isConstruction = this.isConstruction;
    return e;
  }
  override dofPoints(): DofPoint[] {
    return [{ key: "c", pos: clone(this.center) }];
  }
  override getPoint(key: string): Vec2 {
    if (key === "c") return clone(this.center);
    return super.getPoint(key);
  }
  override setPoint(key: string, v: Vec2): void {
    if (key === "c") this.center = clone(v);
  }
  override dofScalars(): DofScalar[] {
    return [{ key: "r", value: this.radius }];
  }
  override setScalar(key: string, v: number): void {
    if (key === "r") this.radius = Math.abs(v);
  }
}

// ---------------------------------------------------------------------------

/** Axis-aligned rectangle defined by two opposite corners. */
export class RectEntity extends Entity {
  readonly type = "rectangle" as const;
  p0: Vec2;
  p1: Vec2;

  constructor(p0: Vec2, p1: Vec2, id?: EntityId) {
    super(id);
    this.p0 = { x: Math.min(p0.x, p1.x), y: Math.min(p0.y, p1.y) };
    this.p1 = { x: Math.max(p0.x, p1.x), y: Math.max(p0.y, p1.y) };
  }

  get minPt(): Vec2 {
    return { x: Math.min(this.p0.x, this.p1.x), y: Math.min(this.p0.y, this.p1.y) };
  }
  get maxPt(): Vec2 {
    return { x: Math.max(this.p0.x, this.p1.x), y: Math.max(this.p0.y, this.p1.y) };
  }
  get width(): number {
    return Math.abs(this.p1.x - this.p0.x);
  }
  get height(): number {
    return Math.abs(this.p1.y - this.p0.y);
  }
  /** The four corners, CCW from min. */
  corners(): [Vec2, Vec2, Vec2, Vec2] {
    const a = this.minPt;
    const b = this.maxPt;
    return [
      { x: a.x, y: a.y },
      { x: b.x, y: a.y },
      { x: b.x, y: b.y },
      { x: a.x, y: b.y },
    ];
  }

  override bounds(): Bounds {
    return { min: this.minPt, max: this.maxPt };
  }
  override distanceTo(p: Vec2): number {
    const c = this.corners();
    let d = Infinity;
    for (let i = 0; i < 4; i++) {
      d = Math.min(d, distToSegment(p, c[i], c[(i + 1) % 4]));
    }
    return d;
  }
  override snapPoints(): SnapPoint[] {
    const c = this.corners();
    const pts: SnapPoint[] = c.map((pos) => ({ pos, kind: "endpoint" as const, entityId: this.id }));
    for (let i = 0; i < 4; i++) {
      pts.push({ pos: mid(c[i], c[(i + 1) % 4]), kind: "midpoint", entityId: this.id });
    }
    pts.push({ pos: mid(this.minPt, this.maxPt), kind: "center", entityId: this.id });
    return pts;
  }
  override translate(d: Vec2): void {
    this.p0 = add(this.p0, d);
    this.p1 = add(this.p1, d);
  }
  override duplicate(): RectEntity {
    const e = new RectEntity(this.p0, this.p1);
    e.isConstruction = this.isConstruction;
    return e;
  }
  override dofPoints(): DofPoint[] {
    return [
      { key: "bl", pos: clone(this.p0) },
      { key: "tr", pos: clone(this.p1) },
    ];
  }
  override getPoint(key: string): Vec2 {
    if (key === "bl") return clone(this.p0);
    if (key === "tr") return clone(this.p1);
    if (key === "br") return { x: this.p1.x, y: this.p0.y };
    if (key === "tl") return { x: this.p0.x, y: this.p1.y };
    return super.getPoint(key);
  }
  override pickablePoints(): DofPoint[] {
    return [
      { key: "bl", pos: clone(this.p0) },
      { key: "br", pos: this.getPoint("br") },
      { key: "tr", pos: clone(this.p1) },
      { key: "tl", pos: this.getPoint("tl") },
    ];
  }
  override dofsAffectedBy(key: string): { key: string; axis: "x" | "y" }[] {
    if (key === "bl") {
      return [{ key: "bl", axis: "x" }, { key: "bl", axis: "y" }];
    }
    if (key === "tr") {
      return [{ key: "tr", axis: "x" }, { key: "tr", axis: "y" }];
    }
    if (key === "br") {
      return [{ key: "tr", axis: "x" }, { key: "bl", axis: "y" }];
    }
    if (key === "tl") {
      return [{ key: "bl", axis: "x" }, { key: "tr", axis: "y" }];
    }
    return [];
  }
  override setPoint(key: string, v: Vec2): void {
    if (key === "bl") this.p0 = clone(v);
    else if (key === "tr") this.p1 = clone(v);
    else if (key === "br") {
      this.p1.x = v.x;
      this.p0.y = v.y;
    } else if (key === "tl") {
      this.p0.x = v.x;
      this.p1.y = v.y;
    }
  }
}

// ---------------------------------------------------------------------------

export class PolylineEntity extends Entity {
  readonly type = "polyline" as const;
  points: Vec2[];
  closed: boolean;

  constructor(points: Vec2[], closed = false, id?: EntityId) {
    super(id);
    this.points = points.map(clone);
    this.closed = closed;
  }

  /** Number of drawn segments (accounts for the closing segment). */
  segmentCount(): number {
    const n = this.points.length;
    if (n < 2) return 0;
    return this.closed ? n : n - 1;
  }
  segment(i: number): [Vec2, Vec2] {
    const n = this.points.length;
    return [this.points[i], this.points[(i + 1) % n]];
  }

  override bounds(): Bounds {
    const min = { x: Infinity, y: Infinity };
    const max = { x: -Infinity, y: -Infinity };
    for (const p of this.points) {
      min.x = Math.min(min.x, p.x);
      min.y = Math.min(min.y, p.y);
      max.x = Math.max(max.x, p.x);
      max.y = Math.max(max.y, p.y);
    }
    return { min, max };
  }
  override distanceTo(p: Vec2): number {
    let d = Infinity;
    const segs = this.segmentCount();
    for (let i = 0; i < segs; i++) {
      const [s0, s1] = this.segment(i);
      d = Math.min(d, distToSegment(p, s0, s1));
    }
    return d;
  }
  override snapPoints(): SnapPoint[] {
    const pts: SnapPoint[] = this.points.map((pos) => ({
      pos: clone(pos),
      kind: "vertex" as const,
      entityId: this.id,
    }));
    const segs = this.segmentCount();
    for (let i = 0; i < segs; i++) {
      const [s0, s1] = this.segment(i);
      pts.push({ pos: mid(s0, s1), kind: "midpoint", entityId: this.id });
    }
    return pts;
  }
  override translate(d: Vec2): void {
    this.points = this.points.map((p) => add(p, d));
  }
  override duplicate(): PolylineEntity {
    const e = new PolylineEntity(this.points, this.closed);
    e.isConstruction = this.isConstruction;
    return e;
  }
  override dofPoints(): DofPoint[] {
    return this.points.map((p, i) => ({ key: `v${i}`, pos: clone(p) }));
  }
  override getPoint(key: string): Vec2 {
    const i = Number(key.slice(1));
    const p = this.points[i];
    if (!p) return super.getPoint(key);
    return clone(p);
  }
  override setPoint(key: string, v: Vec2): void {
    const i = Number(key.slice(1));
    if (this.points[i]) this.points[i] = clone(v);
  }
}

/** Expand a bounds by `m` mm on all sides (handy for hit-test margins). */
export function inflate(b: Bounds, m: number): Bounds {
  return { min: { x: b.min.x - m, y: b.min.y - m }, max: { x: b.max.x + m, y: b.max.y + m } };
}

/** True if point `p` lies within bounds `b`. */
export function boundsContains(b: Bounds, p: Vec2): boolean {
  return p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y;
}

export { clamp };
