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

import { getTextInkBox } from "../core/fontManager";
import {
  angleInArc,
  bezierBounds,
  clamp,
  distToArc,
  distToCircle,
  distToSegment,
  flattenBezier,
  TAU,
} from "../core/geom";
import { add, clone, dist, mid, sub, type Vec2 } from "../core/vec2";
import { nextId } from "./ids";

export type EntityId = string;
export type EntityType =
  | "line"
  | "circle"
  | "rectangle"
  | "polyline"
  | "arc"
  | "bezier"
  | "point"
  | "text"
  | "image";

export interface Bounds {
  min: Vec2;
  max: Vec2;
}

export type SnapKind = "endpoint" | "midpoint" | "center" | "quadrant" | "vertex" | "intersection";

export interface SnapPoint {
  pos: Vec2;
  kind: SnapKind;
  entityId: EntityId;
  /** DOF point key on the entity, present when the snap maps to a constrainable point. */
  key?: string;
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
  layerId = "layer-0";

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
  /** Returns which scalar DOF keys are controlled by dragging the given point key.
   *  Used by the solver to un-anchor those scalars during drags of derived points. */
  scalarsAffectedBy(_key: string): string[] {
    return [];
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
      { pos: clone(this.a), kind: "endpoint", entityId: this.id, key: "a" },
      { pos: clone(this.b), kind: "endpoint", entityId: this.id, key: "b" },
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
    e.layerId = this.layerId;
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
  override dofsAffectedBy(key: string): { key: string; axis: "x" | "y" }[] {
    if (key === "mid")
      return [
        { key: "a", axis: "x" },
        { key: "a", axis: "y" },
        { key: "b", axis: "x" },
        { key: "b", axis: "y" },
      ];
    return [
      { key, axis: "x" },
      { key, axis: "y" },
    ];
  }
  override pickablePoints(): DofPoint[] {
    return [
      { key: "a", pos: clone(this.a) },
      { key: "b", pos: clone(this.b) },
      { key: "mid", pos: mid(this.a, this.b) },
    ];
  }
  override getPoint(key: string): Vec2 {
    if (key === "a") return clone(this.a);
    if (key === "b") return clone(this.b);
    if (key === "mid") return mid(this.a, this.b);
    return super.getPoint(key);
  }
  override setPoint(key: string, v: Vec2): void {
    if (key === "a") this.a = clone(v);
    else if (key === "b") this.b = clone(v);
    else if (key === "mid") {
      const d = sub(v, mid(this.a, this.b));
      this.translate(d);
    }
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
      { pos: clone(c), kind: "center", entityId: this.id, key: "c" },
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
    e.layerId = this.layerId;
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
    const cornerKeys = ["bl", "br", "tr", "tl"] as const;
    const pts: SnapPoint[] = c.map((pos, i) => ({
      pos,
      kind: "endpoint" as const,
      entityId: this.id,
      key: cornerKeys[i],
    }));
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
    e.layerId = this.layerId;
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
    if (key === "mid_b") return mid(this.p0, this.getPoint("br"));
    if (key === "mid_r") return mid(this.getPoint("br"), this.p1);
    if (key === "mid_t") return mid(this.p1, this.getPoint("tl"));
    if (key === "mid_l") return mid(this.getPoint("tl"), this.p0);
    if (key === "center") return mid(this.p0, this.p1);
    return super.getPoint(key);
  }
  override pickablePoints(): DofPoint[] {
    return [
      { key: "bl", pos: clone(this.p0) },
      { key: "br", pos: this.getPoint("br") },
      { key: "tr", pos: clone(this.p1) },
      { key: "tl", pos: this.getPoint("tl") },
      { key: "mid_b", pos: this.getPoint("mid_b") },
      { key: "mid_r", pos: this.getPoint("mid_r") },
      { key: "mid_t", pos: this.getPoint("mid_t") },
      { key: "mid_l", pos: this.getPoint("mid_l") },
      { key: "center", pos: this.getPoint("center") },
    ];
  }
  override dofsAffectedBy(_key: string): { key: string; axis: "x" | "y" }[] {
    return [
      { key: "bl", axis: "x" },
      { key: "bl", axis: "y" },
      { key: "tr", axis: "x" },
      { key: "tr", axis: "y" },
    ];
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
    } else {
      const orig = this.getPoint(key);
      const d = sub(v, orig);
      this.translate(d);
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * Construction parameters for a closed polyline that was generated as a regular
 * polygon. Kept as optional metadata so the properties bar can keep the shape
 * editable by side count / across-flats Ø — dropped once a vertex is hand-edited,
 * because the polyline is then no longer guaranteed regular. `radius` is the
 * circumradius (centre → vertex); `rotation` is the angle (rad) of vertex 0.
 */
export interface PolygonParams {
  sides: number;
  center: Vec2;
  radius: number;
  rotation: number;
}

export class PolylineEntity extends Entity {
  readonly type = "polyline" as const;
  points: Vec2[];
  closed: boolean;
  /**
   * A stable id per vertex, parallel to `points`. Vertex/segment point-keys
   * (`v<id>` and `mid_<id>`) are built from these, NOT from the array index, so
   * a constraint or dimension keeps pointing at the same physical vertex when an
   * edit (chamfer, fillet) inserts or removes vertices ahead of it. Defaults to
   * the index-as-string (`"0"`,`"1"`,…) so legacy files — whose keys are `v0`,
   * `v1`,… — resolve unchanged; new vertices get fresh, never-reused ids.
   */
  vertexIds: string[];
  /** Monotonic source of fresh vertex ids; always past every existing numeric id. */
  private nextVid: number;
  /** Present only while this closed polyline is still a pristine regular polygon. */
  polygon?: PolygonParams;

  constructor(points: Vec2[], closed = false, id?: EntityId, vertexIds?: string[]) {
    super(id);
    this.points = points.map(clone);
    this.closed = closed;
    this.vertexIds =
      vertexIds && vertexIds.length === this.points.length
        ? [...vertexIds]
        : this.points.map((_, i) => String(i));
    this.nextVid = this.vertexIds.reduce((m, v) => {
      const n = Number(v);
      return Number.isFinite(n) && n + 1 > m ? n + 1 : m;
    }, 0);
  }

  /** Mint a vertex id guaranteed not to collide with any current or past one. */
  private mintVertexId(): string {
    return String(this.nextVid++);
  }

  /**
   * Replace the whole vertex set (e.g. regenerating a regular polygon from its
   * params) and reset vertex ids to the defaults. No vertex identity survives a
   * wholesale replace — but for a pristine polygon whose ids are already the
   * defaults this is a no-op on identity, so a same-count edit keeps its keys.
   */
  replaceAllPoints(points: Vec2[]): void {
    this.points = points.map(clone);
    this.vertexIds = this.points.map((_, i) => String(i));
    this.nextVid = this.points.length;
  }

  /**
   * Splice the vertex list, keeping `points` and `vertexIds` in lock-step:
   * removed vertices drop their ids; inserted vertices get fresh ids. Use this
   * (not a raw `points.splice`) whenever an edit changes which vertices exist, so
   * surviving vertices keep their ids — and the constraints/dimensions on them.
   */
  spliceVertices(start: number, deleteCount: number, ...newPoints: Vec2[]): void {
    const newIds = newPoints.map(() => this.mintVertexId());
    this.points.splice(start, deleteCount, ...newPoints.map(clone));
    this.vertexIds.splice(start, deleteCount, ...newIds);
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
  /**
   * Endpoints of the segment whose START vertex carries id `startId`, or null if
   * no such vertex exists or it's the last vertex of an open polyline. Lets a
   * segment-as-line constraint reference an edge by stable id rather than index.
   */
  segmentByStartVertexId(startId: string): [Vec2, Vec2] | null {
    const i = this.vertexIds.indexOf(startId);
    if (i < 0) return null;
    const n = this.points.length;
    const j = i + 1 < n ? i + 1 : this.closed ? 0 : -1;
    if (j < 0) return null;
    return [this.points[i], this.points[j]];
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
    const pts: SnapPoint[] = this.points.map((pos, i) => ({
      pos: clone(pos),
      kind: "vertex" as const,
      entityId: this.id,
      key: `v${this.vertexIds[i]}`,
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
    // Translation preserves regularity — shift the polygon centre so the params
    // stay consistent with the moved vertices.
    if (this.polygon) this.polygon.center = add(this.polygon.center, d);
  }
  override duplicate(): PolylineEntity {
    const e = new PolylineEntity(this.points, this.closed, undefined, this.vertexIds);
    e.isConstruction = this.isConstruction;
    e.layerId = this.layerId;
    if (this.polygon) e.polygon = { ...this.polygon, center: { ...this.polygon.center } };
    return e;
  }
  /** Array index of the vertex carrying id `id`, or -1. */
  private vertexIndex(id: string): number {
    return this.vertexIds.indexOf(id);
  }
  override dofPoints(): DofPoint[] {
    return this.points.map((p, i) => ({ key: `v${this.vertexIds[i]}`, pos: clone(p) }));
  }
  override pickablePoints(): DofPoint[] {
    const pts = this.dofPoints();
    const segs = this.segmentCount();
    // A segment is identified by the id of its START vertex, so it survives edits
    // ahead of it the same way a vertex does.
    for (let i = 0; i < segs; i++) {
      const [s0, s1] = this.segment(i);
      pts.push({ key: `mid_${this.vertexIds[i]}`, pos: mid(s0, s1) });
    }
    return pts;
  }
  override dofsAffectedBy(key: string): { key: string; axis: "x" | "y" }[] {
    if (key.startsWith("mid_")) {
      const i = this.vertexIndex(key.slice(4));
      if (i < 0)
        return [
          { key, axis: "x" },
          { key, axis: "y" },
        ];
      const next = (i + 1) % this.points.length;
      return [
        { key: `v${this.vertexIds[i]}`, axis: "x" },
        { key: `v${this.vertexIds[i]}`, axis: "y" },
        { key: `v${this.vertexIds[next]}`, axis: "x" },
        { key: `v${this.vertexIds[next]}`, axis: "y" },
      ];
    }
    return [
      { key, axis: "x" },
      { key, axis: "y" },
    ];
  }
  override getPoint(key: string): Vec2 {
    if (key.startsWith("mid_")) {
      const i = this.vertexIndex(key.slice(4));
      if (i < 0) return super.getPoint(key);
      const [s0, s1] = this.segment(i);
      return mid(s0, s1);
    }
    const i = this.vertexIndex(key.slice(1));
    const p = this.points[i];
    if (!p) return super.getPoint(key);
    return clone(p);
  }
  override setPoint(key: string, v: Vec2): void {
    if (key.startsWith("mid_")) {
      const i = this.vertexIndex(key.slice(4));
      if (i < 0) return;
      const [s0, s1] = this.segment(i);
      const d = sub(v, mid(s0, s1));
      this.points[i] = add(this.points[i], d);
      this.points[(i + 1) % this.points.length] = add(this.points[(i + 1) % this.points.length], d);
      return;
    }
    const i = this.vertexIndex(key.slice(1));
    if (this.points[i]) this.points[i] = clone(v);
  }
}

// ---------------------------------------------------------------------------

/** Circular arc: CCW from startAngle to endAngle (world Y-up, radians). */
export class ArcEntity extends Entity {
  readonly type = "arc" as const;
  center: Vec2;
  radius: number;
  startAngle: number;
  endAngle: number;

  constructor(center: Vec2, radius: number, startAngle: number, endAngle: number, id?: EntityId) {
    super(id);
    this.center = clone(center);
    this.radius = Math.abs(radius);
    this.startAngle = startAngle;
    this.endAngle = endAngle;
  }

  get startPoint(): Vec2 {
    return {
      x: this.center.x + this.radius * Math.cos(this.startAngle),
      y: this.center.y + this.radius * Math.sin(this.startAngle),
    };
  }
  get endPoint(): Vec2 {
    return {
      x: this.center.x + this.radius * Math.cos(this.endAngle),
      y: this.center.y + this.radius * Math.sin(this.endAngle),
    };
  }

  override bounds(): Bounds {
    const pts: Vec2[] = [this.startPoint, this.endPoint];
    // Include axis-crossing extremes that fall inside the arc span.
    for (let k = 0; k < 4; k++) {
      const a = k * (Math.PI / 2);
      if (angleInArc(a, this.startAngle, this.endAngle)) {
        pts.push({
          x: this.center.x + this.radius * Math.cos(a),
          y: this.center.y + this.radius * Math.sin(a),
        });
      }
    }
    const min = { x: Math.min(...pts.map((p) => p.x)), y: Math.min(...pts.map((p) => p.y)) };
    const max = { x: Math.max(...pts.map((p) => p.x)), y: Math.max(...pts.map((p) => p.y)) };
    return { min, max };
  }

  override distanceTo(p: Vec2): number {
    return distToArc(p, this.center, this.radius, this.startAngle, this.endAngle);
  }

  override snapPoints(): SnapPoint[] {
    const pts: SnapPoint[] = [
      { pos: clone(this.center), kind: "center", entityId: this.id, key: "c" },
      { pos: this.startPoint, kind: "endpoint", entityId: this.id, key: "start" },
      { pos: this.endPoint, kind: "endpoint", entityId: this.id, key: "end" },
    ];
    // Midpoint of the arc (angle midway between start and end).
    const span = (((this.endAngle - this.startAngle) % TAU) + TAU) % TAU;
    const midAngle = this.startAngle + span / 2;
    pts.push({
      pos: {
        x: this.center.x + this.radius * Math.cos(midAngle),
        y: this.center.y + this.radius * Math.sin(midAngle),
      },
      kind: "midpoint",
      entityId: this.id,
    });
    // Quadrant snaps for any cardinal angle that falls within the arc span.
    for (let k = 0; k < 4; k++) {
      const a = k * (Math.PI / 2);
      if (angleInArc(a, this.startAngle, this.endAngle)) {
        pts.push({
          pos: {
            x: this.center.x + this.radius * Math.cos(a),
            y: this.center.y + this.radius * Math.sin(a),
          },
          kind: "quadrant",
          entityId: this.id,
        });
      }
    }
    return pts;
  }

  override translate(d: Vec2): void {
    this.center = add(this.center, d);
  }

  override duplicate(): ArcEntity {
    const e = new ArcEntity(this.center, this.radius, this.startAngle, this.endAngle);
    e.isConstruction = this.isConstruction;
    e.layerId = this.layerId;
    return e;
  }

  // Center is the only true DOF point; start/end are derived but pickable.
  override dofPoints(): DofPoint[] {
    return [{ key: "c", pos: clone(this.center) }];
  }

  override pickablePoints(): DofPoint[] {
    return [
      { key: "c", pos: clone(this.center) },
      { key: "start", pos: this.startPoint },
      { key: "end", pos: this.endPoint },
    ];
  }

  override getPoint(key: string): Vec2 {
    if (key === "c") return clone(this.center);
    if (key === "start") return this.startPoint;
    if (key === "end") return this.endPoint;
    return super.getPoint(key);
  }

  override setPoint(key: string, v: Vec2): void {
    if (key === "c") {
      this.center = clone(v);
      return;
    }
    if (key === "start") {
      this.startAngle = Math.atan2(v.y - this.center.y, v.x - this.center.x);
      return;
    }
    if (key === "end") {
      this.endAngle = Math.atan2(v.y - this.center.y, v.x - this.center.x);
      return;
    }
  }

  override dofScalars(): DofScalar[] {
    return [
      { key: "r", value: this.radius },
      { key: "sa", value: this.startAngle },
      { key: "ea", value: this.endAngle },
    ];
  }

  override setScalar(key: string, v: number): void {
    if (key === "r") this.radius = Math.max(0.001, v);
    else if (key === "sa") this.startAngle = v;
    else if (key === "ea") this.endAngle = v;
  }

  // When dragging start/end, free the corresponding angle scalar from anchoring.
  override scalarsAffectedBy(key: string): string[] {
    if (key === "start") return ["sa"];
    if (key === "end") return ["ea"];
    return [];
  }
}

// ---------------------------------------------------------------------------

/**
 * Cubic Bezier curve: start p0, control handle near start p1,
 * control handle near end p2, end p3.
 *
 * Endpoint DOFs (p0, p3) participate fully in the constraint system.
 * Handle DOFs (p1, p2) are drag-only — they are anchored during solves so
 * the curve shape is preserved, but they are never constraint targets.
 */
export class BezierEntity extends Entity {
  readonly type = "bezier" as const;
  p0: Vec2;
  p1: Vec2;
  p2: Vec2;
  p3: Vec2;

  constructor(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, id?: EntityId) {
    super(id);
    this.p0 = clone(p0);
    this.p1 = clone(p1);
    this.p2 = clone(p2);
    this.p3 = clone(p3);
  }

  override bounds(): Bounds {
    return bezierBounds(this.p0, this.p1, this.p2, this.p3);
  }

  override distanceTo(p: Vec2): number {
    const pts = flattenBezier(this.p0, this.p1, this.p2, this.p3, 0.1);
    let d = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      d = Math.min(d, distToSegment(p, pts[i], pts[i + 1]));
    }
    return d;
  }

  override snapPoints(): SnapPoint[] {
    return [
      { pos: clone(this.p0), kind: "endpoint", entityId: this.id, key: "p0" },
      { pos: clone(this.p3), kind: "endpoint", entityId: this.id, key: "p3" },
    ];
  }

  override translate(d: Vec2): void {
    this.p0 = add(this.p0, d);
    this.p1 = add(this.p1, d);
    this.p2 = add(this.p2, d);
    this.p3 = add(this.p3, d);
  }

  override duplicate(): BezierEntity {
    const e = new BezierEntity(this.p0, this.p1, this.p2, this.p3);
    e.isConstruction = this.isConstruction;
    e.layerId = this.layerId;
    return e;
  }

  override dofPoints(): DofPoint[] {
    return [
      { key: "p0", pos: clone(this.p0) },
      { key: "p1", pos: clone(this.p1) },
      { key: "p2", pos: clone(this.p2) },
      { key: "p3", pos: clone(this.p3) },
    ];
  }

  override pickablePoints(): DofPoint[] {
    return this.dofPoints();
  }

  override getPoint(key: string): Vec2 {
    if (key === "p0") return clone(this.p0);
    if (key === "p1") return clone(this.p1);
    if (key === "p2") return clone(this.p2);
    if (key === "p3") return clone(this.p3);
    return super.getPoint(key);
  }

  override setPoint(key: string, v: Vec2): void {
    if (key === "p0") {
      this.p0 = clone(v);
    } else if (key === "p1") {
      this.p1 = clone(v);
    } else if (key === "p2") {
      this.p2 = clone(v);
    } else if (key === "p3") {
      this.p3 = clone(v);
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * Text entity — stores editable text with font metadata.
 * Remains editable until CAM export, where it is expanded to glyph contours.
 * `position` is the baseline-left anchor in world mm (Y-up).
 * `angle` is CCW rotation in radians (world Y-up convention).
 */
export class TextEntity extends Entity {
  readonly type = "text" as const;
  text: string;
  fontId: string;
  sizeMM: number;
  position: Vec2;
  angle: number;
  /**
   * Transient world-space reflection applied when this text is expanded to
   * contours (see textToContours). Used by double-sided machining to mirror
   * bottom-face text so it engraves backwards and reads correctly from the
   * reverse. Never serialized — set only on the throwaway clone the flip
   * generator builds (see cam/flip.ts). `null` = normal, unmirrored text.
   */
  mirror: { axis: "h" | "v"; c: number } | null = null;

  constructor(
    text: string,
    fontId: string,
    sizeMM: number,
    position: Vec2,
    angle = 0,
    id?: EntityId,
  ) {
    super(id);
    this.text = text;
    this.fontId = fontId;
    this.sizeMM = sizeMM;
    this.position = clone(position);
    this.angle = angle;
  }

  /**
   * Ink box in the local text frame (baseline-left origin, x along the reading
   * direction, y up). Real glyph extents when the font is loaded — so hit-tests
   * and the selection box match the rendered outlines — else the historical
   * 0.6-em-per-character estimate.
   */
  localBox(): Bounds {
    const ink = getTextInkBox(this.fontId, this.text, this.sizeMM);
    if (ink) return ink;
    return {
      min: { x: 0, y: 0 },
      max: { x: this.sizeMM * 0.6 * Math.max(this.text.length, 1), y: this.sizeMM * 1.2 },
    };
  }

  override bounds(): Bounds {
    const b = this.localBox();
    const c = Math.cos(this.angle),
      s = Math.sin(this.angle);
    const corners = [
      { x: b.min.x, y: b.min.y },
      { x: b.max.x, y: b.min.y },
      { x: b.max.x, y: b.max.y },
      { x: b.min.x, y: b.max.y },
    ].map((p) => ({
      x: this.position.x + p.x * c - p.y * s,
      y: this.position.y + p.x * s + p.y * c,
    }));
    return {
      min: { x: Math.min(...corners.map((p) => p.x)), y: Math.min(...corners.map((p) => p.y)) },
      max: { x: Math.max(...corners.map((p) => p.x)), y: Math.max(...corners.map((p) => p.y)) },
    };
  }

  override distanceTo(p: Vec2): number {
    const dx = p.x - this.position.x;
    const dy = p.y - this.position.y;
    const c = Math.cos(-this.angle),
      s = Math.sin(-this.angle);
    const lx = dx * c - dy * s;
    const ly = dx * s + dy * c;
    const b = this.localBox();
    const ddx = lx < b.min.x ? b.min.x - lx : lx > b.max.x ? lx - b.max.x : 0;
    const ddy = ly < b.min.y ? b.min.y - ly : ly > b.max.y ? ly - b.max.y : 0;
    return Math.sqrt(ddx * ddx + ddy * ddy);
  }

  // The text BOX is the (rotated) ink box. Its corners `bl/br/tr/tl`, edge
  // midpoints `mid_b/mid_r/mid_t/mid_l` and `center` are DERIVED points — you can
  // hang dimensions on them (measure the block, or drive its placement off nearby
  // geometry) and constrain them, exactly like a rectangle's. They are NOT dof
  // points: the size lives in the text/font, not the solver, so every box point is
  // reached by perturbing `pos` — writing one translates the whole text (rigid),
  // and the solver reflows `pos` to keep it satisfied. See dofsAffectedBy/setPoint.
  private static readonly BOX_KEYS = [
    "bl",
    "br",
    "tr",
    "tl",
    "mid_b",
    "mid_r",
    "mid_t",
    "mid_l",
    "center",
  ] as const;

  /** A box point in the text's local (unrotated) frame, or null for an unknown key. */
  private localBoxPoint(key: string): Vec2 | null {
    const b = this.localBox();
    const cx = (b.min.x + b.max.x) / 2;
    const cy = (b.min.y + b.max.y) / 2;
    switch (key) {
      case "bl":
        return { x: b.min.x, y: b.min.y };
      case "br":
        return { x: b.max.x, y: b.min.y };
      case "tr":
        return { x: b.max.x, y: b.max.y };
      case "tl":
        return { x: b.min.x, y: b.max.y };
      case "mid_b":
        return { x: cx, y: b.min.y };
      case "mid_r":
        return { x: b.max.x, y: cy };
      case "mid_t":
        return { x: cx, y: b.max.y };
      case "mid_l":
        return { x: b.min.x, y: cy };
      case "center":
        return { x: cx, y: cy };
      default:
        return null;
    }
  }

  /** Map a point in the local (unrotated) frame to world space. */
  private toWorld(l: Vec2): Vec2 {
    const c = Math.cos(this.angle),
      s = Math.sin(this.angle);
    return { x: this.position.x + l.x * c - l.y * s, y: this.position.y + l.x * s + l.y * c };
  }

  /** World-space centre of the ink box (kept for readers that want it directly). */
  centerWorld(): Vec2 {
    return this.toWorld(this.localBoxPoint("center")!);
  }

  override snapPoints(): SnapPoint[] {
    const pts: SnapPoint[] = [
      { pos: clone(this.position), kind: "endpoint", entityId: this.id, key: "pos" },
    ];
    for (const key of TextEntity.BOX_KEYS) {
      const kind: SnapKind =
        key === "center" ? "center" : key.startsWith("mid_") ? "midpoint" : "endpoint";
      pts.push({ pos: this.toWorld(this.localBoxPoint(key)!), kind, entityId: this.id, key });
    }
    return pts;
  }

  override translate(d: Vec2): void {
    this.position = add(this.position, d);
  }

  override duplicate(): TextEntity {
    const e = new TextEntity(this.text, this.fontId, this.sizeMM, this.position, this.angle);
    e.isConstruction = this.isConstruction;
    e.layerId = this.layerId;
    return e;
  }

  override dofPoints(): DofPoint[] {
    return [{ key: "pos", pos: clone(this.position) }];
  }
  override pickablePoints(): DofPoint[] {
    return [
      { key: "pos", pos: clone(this.position) },
      ...TextEntity.BOX_KEYS.map((key) => ({ key, pos: this.toWorld(this.localBoxPoint(key)!) })),
    ];
  }
  override dofsAffectedBy(key: string): { key: string; axis: "x" | "y" }[] {
    // Every derived box point moves only by translating `pos`.
    if (this.localBoxPoint(key))
      return [
        { key: "pos", axis: "x" },
        { key: "pos", axis: "y" },
      ];
    return [
      { key, axis: "x" },
      { key, axis: "y" },
    ];
  }

  override getPoint(key: string): Vec2 {
    if (key === "pos") return clone(this.position);
    const l = this.localBoxPoint(key);
    if (l) return this.toWorld(l);
    return super.getPoint(key);
  }

  override setPoint(key: string, v: Vec2): void {
    // Only the anchor is a real DOF; writing a box point translates the whole text
    // so that point lands on v (keeps the string/size/rotation).
    if (key === "pos") {
      this.position = clone(v);
      return;
    }
    const l = this.localBoxPoint(key);
    if (l) this.position = add(this.position, sub(v, this.toWorld(l)));
  }
}

// ---------------------------------------------------------------------------

/**
 * How geometric constraints and dimensions may reflow a placed image.
 *
 * - `"rigid"` (default): size and rotation are held, so a constraint on a corner
 *   *translates* the image. An image's corners are nonlinear in w/h/angle, so an
 *   image left free reflows ambiguously under a single point constraint — rigid
 *   is what makes "pin this corner to that hole" mean the obvious thing.
 * - `"scale"`: the image may change size *uniformly* — w and h are one degree of
 *   freedom (see {@link RasterImageEntity.setScalar}), so the aspect ratio is
 *   exact by construction — while its rotation is still held. This is the
 *   calibrate case: dimension a known distance on a scanned drawing and the whole
 *   image scales to suit. Rotation stays out of it deliberately: a free angle can
 *   satisfy a size dimension by tilting instead (a 10mm gap is also a 32mm edge
 *   seen at 72°), which is never what "this feature is 10mm" meant.
 * - `"rotate"`: rotation only, size held — levelling a tilted scan against a
 *   drawn edge. The mirror of `"scale"`, and for the same reason: a free size can
 *   satisfy a rotation constraint by shrinking the image to nothing (`w·sinθ = 0`
 *   has a root at `w = 0` just as much as at `θ = 0`).
 * - `"scale-rotate"`: uniform size *and* rotation — a similarity fit, for the
 *   exactly-determined case of pinning two corners. Leaving it under-constrained
 *   leaves both of the above escape routes open, so prefer the narrower fit that
 *   matches the intent.
 * - `"stretch"`: w, h and angle are all free — the image can be pulled to fit
 *   non-uniformly (aspect not preserved).
 */
export const IMAGE_CONSTRAINT_FITS = [
  "rigid",
  "scale",
  "rotate",
  "scale-rotate",
  "stretch",
] as const;
export type ImageConstraintFit = (typeof IMAGE_CONSTRAINT_FITS)[number];

/**
 * A placed raster image, for greyscale laser engraving. Holds only a reference
 * (`imageId`) into the image registry — the pixels live there and are embedded in
 * the .rcam file like fonts. The image occupies a `widthMM × heightMM` rectangle
 * anchored at `position` (its bottom-left corner) and rotated `angle` radians CCW.
 */
export class RasterImageEntity extends Entity {
  readonly type = "image" as const;
  imageId: string;
  position: Vec2;
  widthMM: number;
  heightMM: number;
  angle: number;
  /** Mirror the image content left↔right (about its vertical centreline). */
  flipX: boolean;
  /** Mirror the image content top↔bottom (about its horizontal centreline). */
  flipY: boolean;
  /** Whether the aspect ratio is locked when modifying width/height (an edit-time
   *  convenience — a formula in one side writes a proportional one to the other). */
  aspectLocked = true;
  /** How constraints/dimensions may reflow the image. See {@link ImageConstraintFit}. */
  constraintFit: ImageConstraintFit = "rigid";

  constructor(
    imageId: string,
    position: Vec2,
    widthMM: number,
    heightMM: number,
    angle = 0,
    flipX = false,
    flipY = false,
    id?: EntityId,
  ) {
    super(id);
    this.imageId = imageId;
    this.position = clone(position);
    this.widthMM = widthMM;
    this.heightMM = heightMM;
    this.angle = angle;
    this.flipX = flipX;
    this.flipY = flipY;
  }

  /** Map a point in the image's local (unrotated) frame to world space. */
  private toWorld(l: Vec2): Vec2 {
    const c = Math.cos(this.angle),
      s = Math.sin(this.angle);
    return { x: this.position.x + l.x * c - l.y * s, y: this.position.y + l.x * s + l.y * c };
  }

  /** The image's constrainable local points, keyed. c0 = bottom-left anchor,
   *  c1..c3 CCW; `center` is the middle. Used for getPoint/snap/pick + constraints. */
  private static readonly LOCAL_KEYS = ["c0", "c1", "c2", "c3", "center"] as const;
  private localPoint(key: string): Vec2 | null {
    switch (key) {
      case "c0":
        return { x: 0, y: 0 };
      case "c1":
        return { x: this.widthMM, y: 0 };
      case "c2":
        return { x: this.widthMM, y: this.heightMM };
      case "c3":
        return { x: 0, y: this.heightMM };
      case "center":
        return { x: this.widthMM / 2, y: this.heightMM / 2 };
      default:
        return null;
    }
  }

  /** The four corners in world space (CCW from the bottom-left anchor). */
  corners(): Vec2[] {
    return ["c0", "c1", "c2", "c3"].map((k) => this.toWorld(this.localPoint(k)!));
  }

  override bounds(): Bounds {
    const cs = this.corners();
    return {
      min: { x: Math.min(...cs.map((p) => p.x)), y: Math.min(...cs.map((p) => p.y)) },
      max: { x: Math.max(...cs.map((p) => p.x)), y: Math.max(...cs.map((p) => p.y)) },
    };
  }

  /** Zero anywhere on the image (so a click anywhere selects it), else the
   *  distance to the rectangle — measured in the image's own (unrotated) frame. */
  override distanceTo(p: Vec2): number {
    const dx = p.x - this.position.x,
      dy = p.y - this.position.y;
    const c = Math.cos(this.angle),
      s = Math.sin(this.angle);
    const lx = c * dx + s * dy; // R(-angle) · (p - position)
    const ly = -s * dx + c * dy;
    const ddx = lx < 0 ? -lx : lx > this.widthMM ? lx - this.widthMM : 0;
    const ddy = ly < 0 ? -ly : ly > this.heightMM ? ly - this.heightMM : 0;
    return Math.hypot(ddx, ddy);
  }

  override snapPoints(): SnapPoint[] {
    return RasterImageEntity.LOCAL_KEYS.map((key) => ({
      pos: this.toWorld(this.localPoint(key)!),
      kind: key === "center" ? ("center" as const) : ("vertex" as const),
      entityId: this.id,
      key,
    }));
  }

  override translate(d: Vec2): void {
    this.position = add(this.position, d);
  }

  override duplicate(): RasterImageEntity {
    const e = new RasterImageEntity(
      this.imageId,
      this.position,
      this.widthMM,
      this.heightMM,
      this.angle,
      this.flipX,
      this.flipY,
    );
    e.isConstruction = this.isConstruction;
    e.layerId = this.layerId;
    e.aspectLocked = this.aspectLocked;
    e.constraintFit = this.constraintFit;
    return e;
  }

  override dofPoints(): DofPoint[] {
    return [{ key: "pos", pos: clone(this.position) }];
  }
  // Corners + centre are DERIVED points (from pos/w/h/angle) — constrainable and
  // pickable like an arc's endpoints. They are NOT dof points; the solver reaches
  // them by perturbing pos/w/h/angle (finite-difference Jacobian), so a constraint
  // on a corner reflows the image with no bespoke solver code.
  override pickablePoints(): DofPoint[] {
    return RasterImageEntity.LOCAL_KEYS.map((key) => ({
      key,
      pos: this.toWorld(this.localPoint(key)!),
    }));
  }
  override getPoint(key: string): Vec2 {
    if (key === "pos") return clone(this.position);
    const l = this.localPoint(key);
    if (l) return this.toWorld(l);
    return super.getPoint(key);
  }
  override setPoint(key: string, v: Vec2): void {
    // Only the anchor is a real DOF; a corner/centre write repositions the whole
    // image so that derived point lands on v (keeps size/rotation).
    if (key === "pos") {
      this.position = clone(v);
      return;
    }
    const l = this.localPoint(key);
    if (l) this.position = add(this.position, sub(v, this.toWorld(l)));
  }
  // Dragging any corner/centre translates the image (moves the pos DOF); resize and
  // rotate stay in the Properties panel / Transform. Constraint solves don't use
  // this (it only frees DOFs for a drag pin).
  override dofsAffectedBy(key: string): { key: string; axis: "x" | "y" }[] {
    if (key === "pos" || this.localPoint(key))
      return [
        { key: "pos", axis: "x" },
        { key: "pos", axis: "y" },
      ];
    return [];
  }
  // Size/rotation are scalar DOFs so formulas drive them through the solver like
  // any other entity (parametric bindings), instead of a bespoke direct-drive path.
  override dofScalars(): DofScalar[] {
    return [
      { key: "w", value: this.widthMM },
      { key: "h", value: this.heightMM },
      { key: "angle", value: this.angle },
    ];
  }
  override setScalar(key: string, v: number): void {
    if (key === "w") {
      // In the uniform-scale fits the two size scalars are ONE degree of freedom:
      // h rides on w at the current ratio. Because h/w is unchanged by this write,
      // the ratio is an exact invariant of every solver step — the aspect is
      // preserved by construction rather than by a ratio constraint the solver
      // would have to converge (and could trade off against). The solver holds h
      // fixed in these modes (see fixImageScalars), so nothing writes it back out
      // from under this.
      const uniform = this.constraintFit === "scale" || this.constraintFit === "scale-rotate";
      const ratio = this.widthMM > 0 ? this.heightMM / this.widthMM : 0;
      this.widthMM = Math.max(0.001, v);
      if (uniform && ratio > 0) this.heightMM = Math.max(0.001, this.widthMM * ratio);
    } else if (key === "h") this.heightMM = Math.max(0.001, v);
    else if (key === "angle") this.angle = v;
  }
}

// ---------------------------------------------------------------------------

/** Expand a bounds by `m` mm on all sides (handy for hit-test margins). */
export function inflate(b: Bounds, m: number): Bounds {
  return { min: { x: b.min.x - m, y: b.min.y - m }, max: { x: b.max.x + m, y: b.max.y + m } };
}

/** True if point `p` lies within bounds `b`. */
export function boundsContains(b: Bounds, p: Vec2): boolean {
  return p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y;
}

export { clamp };

// ---------------------------------------------------------------------------

/** Single constrained point — used for the WCS origin and similar reference geometry. */
export class PointEntity extends Entity {
  readonly type = "point" as const;
  pos: Vec2;

  constructor(pos: Vec2, id?: EntityId) {
    super(id);
    this.pos = clone(pos);
  }

  bounds(): Bounds {
    return {
      min: { x: this.pos.x - 0.5, y: this.pos.y - 0.5 },
      max: { x: this.pos.x + 0.5, y: this.pos.y + 0.5 },
    };
  }
  distanceTo(p: Vec2): number {
    return dist(p, this.pos);
  }
  snapPoints(): SnapPoint[] {
    return [{ pos: { ...this.pos }, kind: "endpoint", entityId: this.id, key: "p" }];
  }
  translate(d: Vec2): void {
    this.pos = add(this.pos, d);
  }
  duplicate(): Entity {
    return new PointEntity({ ...this.pos });
  }

  override dofPoints(): DofPoint[] {
    return [{ key: "p", pos: { ...this.pos } }];
  }
  override getPoint(key: string): Vec2 {
    if (key === "p") return { ...this.pos };
    throw new Error(`PointEntity has no point '${key}'`);
  }
  override setPoint(key: string, v: Vec2): void {
    if (key === "p") this.pos = { ...v };
  }
}
