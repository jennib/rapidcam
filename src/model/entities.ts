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

export type SnapKind =
  | "endpoint"
  | "midpoint"
  | "center"
  | "quadrant"
  | "vertex"
  | "intersection"
  | "pointOnLine"
  | "nearest";

/**
 * Which two corners bound each edge of a 4-corner entity. Rectangles and the
 * stock rect name their corners bl/br/tr/tl; images name theirs c0..c3.
 *
 * Both the `mid_*` keys the pickers hand out and the plain compass names the
 * constraint bar builds are accepted, because the two grew up separately and
 * files already exist carrying each.
 */
const RECT_EDGE_CORNERS: Record<string, [string, string]> = {
  mid_b: ["bl", "br"],
  mid_r: ["br", "tr"],
  mid_t: ["tr", "tl"],
  mid_l: ["tl", "bl"],
  bottom: ["bl", "br"],
  right: ["br", "tr"],
  top: ["tr", "tl"],
  left: ["tl", "bl"],
  b: ["bl", "br"],
  r: ["br", "tr"],
  t: ["tr", "tl"],
  l: ["tl", "bl"],
};
const IMAGE_EDGE_CORNERS: Record<string, [string, string]> = {
  mid_b: ["c0", "c1"],
  mid_r: ["c1", "c2"],
  mid_t: ["c2", "c3"],
  mid_l: ["c3", "c0"],
  bottom: ["c0", "c1"],
  right: ["c1", "c2"],
  top: ["c2", "c3"],
  left: ["c3", "c0"],
};

/**
 * The two endpoints of one named edge of a rectangle, image, or the stock rect.
 *
 * A multi-edge entity cannot be identified by a bare entity id — that gap is
 * why a dimension anchored to a stock edge silently degraded to a
 * midpoint-to-midpoint point dimension, and why a `pointOnLine` constraint
 * snapped onto a rectangle edge resolved to nothing and constrained nothing.
 * Callers pair the id with the edge key using the `<id>#<key>` segment-ref
 * convention (see lineRefEntityId, which already strips it for solver
 * partitioning and delete-pruning).
 *
 * Returns null for an unrecognized key rather than guessing an edge: picking
 * a plausible default here would silently measure or constrain against the
 * wrong side of the part.
 */
export function edgeEndsOf(
  ent: { type: string; getPoint(key: string): Vec2 } | undefined,
  edgeKey: string,
): { a: Vec2; b: Vec2 } | null {
  if (!ent) return null;
  const pair = (ent.type === "image" ? IMAGE_EDGE_CORNERS : RECT_EDGE_CORNERS)[edgeKey];
  if (!pair) return null;
  try {
    const a = ent.getPoint(pair[0]);
    const b = ent.getPoint(pair[1]);
    // getPoint throws for an unknown key on most entities, but a wrong-kind
    // entity that answers with junk must not become a phantom edge either.
    if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(b.x)) return null;
    return { a, b };
  } catch {
    return null; // no such corner: wrong entity kind, or rotary stock (no flat rect)
  }
}

export interface SnapPoint {
  pos: Vec2;
  kind: SnapKind;
  entityId: EntityId;
  /** DOF point key on the entity, present when the snap maps to a constrainable point. */
  key?: string;
  /**
   * Which edge of a multi-edge entity a "pointOnLine" snap landed on (see
   * edgeEndsOf). Kept separate from `key`, which means "pin to this exact
   * point" — an edge snap must slide ALONG the edge, not weld to its midpoint.
   */
  edgeKey?: string;
  /**
   * For an `intersection` snap: the two entities whose crossing this is. Without
   * them the snap knows WHERE the crossing is but not WHAT crossed, so a tool
   * can place a point there and cannot hold it there.
   */
  crossIds?: [EntityId, EntityId];
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
  name?: string;
  visible = true;
  locked = false;
  /**
   * Workholding only: how far THIS clamp stands above the stock top (mm).
   * Meaningful just for a closed shape on a layer flagged `fixture`; ignored
   * everywhere else. Absent = inherit the layer's `fixtureHeight`, which is
   * where the height used to live exclusively — a single number for every
   * clamp on the layer, so two clamps of different heights were unrepresentable.
   * Resolution order is entity → layer → +Infinity (see cam/fixtures.ts).
   */
  fixtureHeight?: number;

  constructor(id?: EntityId) {
    this.id = id ?? nextId("ent");
  }

  /**
   * Copy the geometry-independent fields onto a fresh entity, for `duplicate()`.
   *
   * Exists because all eight subclasses used to hand-copy the same two fields,
   * which is how a ninth field reaches seven shapes and silently misses the
   * eighth (the same reason `EntitySnapshotCommon` was factored out).
   *
   * `name`, `visible` and `locked` are deliberately NOT copied — that is the
   * long-standing behaviour of every `duplicate()`, preserved here rather than
   * quietly changed. It is arguably wrong for `visible`/`locked` (a copy of a
   * hidden entity comes back visible), but that is its own decision.
   */
  protected copyCommonTo(e: Entity): void {
    e.isConstruction = this.isConstruction;
    e.layerId = this.layerId;
    if (this.fixtureHeight !== undefined) e.fixtureHeight = this.fixtureHeight;
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
      { pos: mid(this.a, this.b), kind: "midpoint", entityId: this.id, key: "mid" },
    ];
  }
  override translate(d: Vec2): void {
    this.a = add(this.a, d);
    this.b = add(this.b, d);
  }
  override duplicate(): LineEntity {
    const e = new LineEntity(this.a, this.b);
    this.copyCommonTo(e);
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
    this.copyCommonTo(e);
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

/**
 * Unit direction from `from` toward `to` along one axis-aligned edge. Returns a
 * zero vector for a degenerate edge rather than NaN.
 */
function unitStep(from: Vec2, to: Vec2): Vec2 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  return len < CORNER_R_EPS ? { x: 0, y: 0 } : { x: dx / len, y: dy / len };
}

/** Signed angular sweep of an outline arc, following its traversal direction. */
function arcSweep(p: { startAngle: number; endAngle: number; ccw: boolean }): number {
  const d = (((p.endAngle - p.startAngle) % TAU) + TAU) % TAU; // [0, TAU)
  return p.ccw ? d : d - TAU;
}

/**
 * Segments needed to flatten an arc within `toleranceMM` of chord deviation.
 * The sagitta of a step θ is r(1 − cos(θ/2)), so the largest step inside the
 * tolerance is 2·acos(1 − tol/r).
 */
function arcSteps(radius: number, absSpan: number, toleranceMM: number): number {
  if (!(toleranceMM > 0) || toleranceMM >= radius) return 2;
  const maxStep = 2 * Math.acos(1 - toleranceMM / radius);
  return Math.min(256, Math.max(2, Math.ceil(absSpan / maxStep)));
}

/**
 * How a rectangle's shaped corners are cut. One type per rectangle, which is
 * how Vectric presents it (`Corner Type: Round | Inverted | Chamfer`) — the
 * radius is per corner, the *shape* is a property of the whole rectangle.
 *
 * - `round` — a convex fillet, tangent to both edges. The ordinary rounded corner.
 * - `inverted` — a concave cove: a quarter circle bitten OUT of the corner,
 *   centred on the corner itself, so it meets both edges square rather than
 *   tangentially. (A tangent concave arc is not constructible at a convex
 *   corner: its tangent points fall on the far side of the corner point.)
 *   This is a SHAPE, unrelated to a dogbone — a dogbone is a machining relief
 *   applied at toolpath time (`cam/dogbone.ts`), so a part can seat in a
 *   square-cornered pocket cut by a round tool.
 * - `chamfer` — a straight bevel across both edges.
 *
 * All three consume the same distance along each edge, so one radius field
 * means the same thing whichever is selected — again as Vectric does.
 */
export type CornerType = "round" | "inverted" | "chamfer";

/** Every {@link CornerType}, in the order the properties panel offers them. */
export const CORNER_TYPES: readonly CornerType[] = ["round", "inverted", "chamfer"];

/** Human labels for {@link CornerType} — UI and tool messages share one table. */
export const CORNER_TYPE_LABELS: Record<CornerType, string> = {
  round: "Round",
  inverted: "Inverted",
  chamfer: "Chamfer",
};

/**
 * One piece of a rectangle's boundary: a straight run, or a corner's arc.
 *
 * `startAngle`/`endAngle` are the arc's endpoints in TRAVERSAL order, and `ccw`
 * says which way round it is walked between them — a rounded corner runs CCW,
 * an inverted one CW, on a ring that is itself CCW. Consumers that must
 * reproduce the arc exactly (DXF bulges, SVG arc flags, Explode) need that
 * direction; consumers that only want points use {@link RectEntity.outlinePoints}.
 */
export type OutlinePart =
  | { kind: "line"; a: Vec2; b: Vec2 }
  | {
      kind: "arc";
      center: Vec2;
      radius: number;
      startAngle: number;
      endAngle: number;
      ccw: boolean;
    };

/** Below this a corner radius is treated as absent (square). */
const CORNER_R_EPS = 1e-9;

/**
 * The wedge at one corner: unit directions to both neighbours, how far away
 * they are, and the angle between them.
 *
 * `angle` is the UNSIGNED angle between the legs, in (0, π) — the wedge you are
 * cutting into, which is what every treatment below is defined against. At a
 * reflex vertex that is the wedge on the outside of the shape, and the
 * construction still works, because a treatment is tangent to the two legs and
 * knows nothing about which side the material is on.
 */
export interface CornerWedge {
  P: Vec2;
  d1: Vec2;
  len1: number;
  d2: Vec2;
  len2: number;
  angle: number;
}

/**
 * The wedge at `P` between its neighbours, or null when there is no corner to
 * treat: a leg of no length, legs that are collinear (a straight run), or legs
 * folded back on each other.
 */
export function cornerWedge(P: Vec2, prev: Vec2, next: Vec2): CornerWedge | null {
  const len1 = Math.hypot(prev.x - P.x, prev.y - P.y);
  const len2 = Math.hypot(next.x - P.x, next.y - P.y);
  if (len1 < CORNER_R_EPS || len2 < CORNER_R_EPS) return null;
  const d1 = { x: (prev.x - P.x) / len1, y: (prev.y - P.y) / len1 };
  const d2 = { x: (next.x - P.x) / len2, y: (next.y - P.y) / len2 };
  const angle = Math.acos(Math.max(-1, Math.min(1, d1.x * d2.x + d1.y * d2.y)));
  if (angle < 1e-4 || Math.abs(angle - Math.PI) < 1e-4) return null;
  return { P, d1, len1, d2, len2, angle };
}

/**
 * How far along each leg a treatment of size `value` eats.
 *
 * This is where round and chamfer stop being the same number, and it is the one
 * real difference between a polyline's corners and a rectangle's. A rectangle's
 * corner is 90°, where `tan(45°) = 1` makes a fillet's radius and its setback
 * the same figure — which is why one field could serve all three types there.
 * At any other angle they part company, so each type keeps the parameter its
 * own tool has always used and which CAD names it by:
 *
 * - `round` — `value` is the RADIUS (Fusion's and AutoCAD's fillet parameter),
 *   and the arc meets each leg `r / tan(θ/2)` back from the corner.
 * - `chamfer` — `value` is the SETBACK along each leg (AutoCAD's CHAMFER
 *   distance), so it is its own answer.
 * - `inverted` — `value` is the cove's radius, and because the cove is centred
 *   ON the corner its tangent points are exactly `r` back. Forced, not chosen.
 *
 * Consumption is linear in `value` for all three, which is what lets a corner
 * that will not fit be scaled down by a single factor.
 */
export function cornerSetback(w: CornerWedge, value: number, type: CornerType): number {
  if (!(value > CORNER_R_EPS)) return 0;
  return type === "round" ? value / Math.tan(w.angle / 2) : value;
}

/**
 * One corner's geometry: where the boundary leaves the incoming leg (`in`),
 * where it rejoins the outgoing one (`out`), and the cut between them.
 *
 * `null` when the treatment does not fit between the two legs. The arc is
 * always the SHORT way from `in` to `out` about its centre, with `ccw` reporting
 * which way that turned out to be — that single rule gives a convex fillet its
 * CCW sweep, a cove its CW one, and the right answer at a reflex vertex, where a
 * fixed flag per type would be wrong.
 */
export function cornerCut(
  w: CornerWedge,
  value: number,
  type: CornerType,
): { in: Vec2; out: Vec2; cut: OutlinePart } | null {
  const t = cornerSetback(w, value, type);
  if (!(t > CORNER_R_EPS) || t >= w.len1 || t >= w.len2) return null;
  const { P, d1, d2 } = w;
  const T1 = { x: P.x + t * d1.x, y: P.y + t * d1.y };
  const T2 = { x: P.x + t * d2.x, y: P.y + t * d2.y };
  if (type === "chamfer") return { in: T1, out: T2, cut: { kind: "line", a: T1, b: T2 } };

  let centre = P;
  if (type === "round") {
    // On the bisector, far enough out that the arc is tangent to both legs.
    const bx = d1.x + d2.x;
    const by = d1.y + d2.y;
    const bl = Math.hypot(bx, by);
    if (bl < CORNER_R_EPS) return null;
    const away = value / Math.sin(w.angle / 2);
    centre = { x: P.x + (bx / bl) * away, y: P.y + (by / bl) * away };
  }
  const a1 = Math.atan2(T1.y - centre.y, T1.x - centre.x);
  const a2 = Math.atan2(T2.y - centre.y, T2.x - centre.x);
  let span = (((a2 - a1) % TAU) + TAU) % TAU;
  if (span > Math.PI) span -= TAU;
  return {
    in: T1,
    out: T2,
    cut: {
      kind: "arc",
      center: centre,
      radius: value,
      startAngle: a1,
      endAngle: a2,
      ccw: span >= 0,
    },
  };
}

/** Axis-aligned rectangle defined by two opposite corners. */
export class RectEntity extends Entity {
  readonly type = "rectangle" as const;
  p0: Vec2;
  p1: Vec2;
  /**
   * Corner radius per corner, in `corners()` order — bl, br, tr, tl. `0` is a
   * square corner, and `[0,0,0,0]` (the default) is the plain rectangle every
   * older file holds.
   *
   * This is what makes a filleted rectangle stay a RECTANGLE. Rounding a corner
   * used to replace the entity with a polyline, which is why "you can't edit a
   * fillet" and why constraints on it needed rescuing (#53). A radius here is
   * an editable property: change it, zero it, or switch its
   * {@link cornerType} — the entity, its id and every constraint naming its
   * corners are untouched.
   *
   * Stored as asked for, not as drawn: a radius too big for the current size is
   * clamped when the boundary is built ({@link effectiveCornerRadii}), so
   * shrinking a rectangle and growing it back restores the corner rather than
   * quietly destroying it.
   */
  cornerRadii: [number, number, number, number] = [0, 0, 0, 0];
  /** How the non-zero corners are cut. See {@link CornerType}. */
  cornerType: CornerType = "round";

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

  /**
   * The radii as they can actually be drawn: each clamped so two corners sharing
   * an edge cannot overrun it.
   *
   * The clamp lives here rather than on assignment so a radius survives a
   * temporary shrink — drag a 60mm-wide rectangle down to 8mm with 5mm corners
   * and back, and the corners come back too. Clamping on the way in would have
   * destroyed them at 8mm, silently and permanently.
   *
   * Each corner is scaled by the tighter of its two edges' fit factors, so a big
   * radius on one corner only pulls in the corners that share an edge with it —
   * a single global factor would shrink the far side of the shape for no reason.
   */
  effectiveCornerRadii(): [number, number, number, number] {
    const r = this.cornerRadii.map((v) => (Number.isFinite(v) && v > CORNER_R_EPS ? v : 0));
    // Edge i runs from corner i to corner i+1: bottom, right, top, left.
    const edge = [this.width, this.height, this.width, this.height];
    const fit = [0, 1, 2, 3].map((i) => {
      const pair = r[i] + r[(i + 1) % 4];
      return pair > edge[i] ? edge[i] / pair : 1;
    });
    // Corner i is bounded by edge i (toward the next corner) and edge i-1.
    return r.map((v, i) => v * Math.min(fit[i], fit[(i + 3) % 4])) as [
      number,
      number,
      number,
      number,
    ];
  }

  /** True when at least one corner is actually shaped (a drawable radius). */
  hasShapedCorners(): boolean {
    return this.effectiveCornerRadii().some((r) => r > CORNER_R_EPS);
  }

  /**
   * Whether radius `r` fits at corner `index` beside its neighbours' radii.
   *
   * A rectangle corner is the one case where a value can be geometrically fine
   * on its own and still not fit: two corners share an edge, so 30mm and 40mm
   * corners cannot both sit on a 60mm side. The tools ask this before committing
   * so an impossible radius is refused out loud instead of being silently
   * clamped down by {@link effectiveCornerRadii}.
   */
  fitsCornerRadius(index: number, r: number): boolean {
    if (!(r > CORNER_R_EPS)) return true; // square always fits
    const edge = [this.width, this.height, this.width, this.height];
    const other = this.cornerRadii;
    const next = r + Math.max(0, other[(index + 1) % 4]);
    const prev = r + Math.max(0, other[(index + 3) % 4]);
    return next <= edge[index] + CORNER_R_EPS && prev <= edge[(index + 3) % 4] + CORNER_R_EPS;
  }

  /** The largest radius every corner could carry at once, at the current size. */
  maxUniformCornerRadius(): number {
    return Math.min(this.width, this.height) / 2;
  }

  /**
   * Reorder the corner treatments: `order[i]` names the corner whose radius
   * lands at corner `i`.
   *
   * The permutations below are the ONLY place a transform has to know the
   * bl/br/tr/tl ordering `corners()` defines. A transform that moves a rectangle
   * without moving its corner treatments to match puts the round on the wrong
   * corner — silently, and all the way through to the G-code.
   */
  private permuteCornerRadii(order: readonly [number, number, number, number]): void {
    const r = this.cornerRadii;
    this.cornerRadii = [r[order[0]], r[order[1]], r[order[2]], r[order[3]]];
  }
  /** Mirror the corner treatments about a vertical axis: bl↔br, tl↔tr. */
  mirrorCornersX(): void {
    this.permuteCornerRadii([1, 0, 3, 2]);
  }
  /** Mirror the corner treatments about a horizontal axis: bl↔tl, br↔tr. */
  mirrorCornersY(): void {
    this.permuteCornerRadii([3, 2, 1, 0]);
  }
  /**
   * Turn the corner treatments through `quarterTurns` × 90° CCW — bl→br→tr→tl,
   * matching where the rectangle's own corners land.
   */
  rotateCorners(quarterTurns: number): void {
    const k = (((Math.round(quarterTurns) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
    if (k === 0) return;
    // Corner i afterwards holds what corner i-k held: one CCW quarter-turn
    // carries bl's treatment onto br.
    this.permuteCornerRadii([(4 - k) % 4, (5 - k) % 4, (6 - k) % 4, (7 - k) % 4] as [
      number,
      number,
      number,
      number,
    ]);
  }

  /**
   * The boundary as an ordered ring of straight runs and corner arcs, CCW from
   * the bottom-left.
   *
   * This is where a rectangle becomes a boundary — {@link outlinePoints} is this
   * flattened. Use it when the arcs must be reproduced exactly rather than
   * approximated: DXF bulges, SVG arc commands, Explode.
   */
  outlineParts(): OutlinePart[] {
    const c = this.corners();
    const r = this.effectiveCornerRadii();
    // Where each corner's own geometry starts and ends. Both are the corner
    // point itself while it is square, which is what makes an unshaped
    // rectangle come out as exactly the four straight edges it always was.
    const ends: { in: Vec2; out: Vec2 }[] = [];
    const cut: (OutlinePart | null)[] = [];

    for (let i = 0; i < 4; i++) {
      const P = c[i];
      if (r[i] <= CORNER_R_EPS) {
        ends.push({ in: P, out: P });
        cut.push(null);
        continue;
      }
      // Unit directions toward the previous and next corner. Exact ±1/0 here:
      // the rectangle is axis-aligned, and a non-zero radius guarantees both
      // edges have length (a zero-width rectangle clamps every radius to 0).
      const dPrev = unitStep(P, c[(i + 3) % 4]);
      const dNext = unitStep(P, c[(i + 1) % 4]);
      const T1 = { x: P.x + r[i] * dPrev.x, y: P.y + r[i] * dPrev.y };
      const T2 = { x: P.x + r[i] * dNext.x, y: P.y + r[i] * dNext.y };
      ends.push({ in: T1, out: T2 });

      if (this.cornerType === "chamfer") {
        cut.push({ kind: "line", a: T1, b: T2 });
        continue;
      }
      // Round: centre pushed inward along both edges, so the arc is tangent to
      // each. Inverted: centred ON the corner, so the arc bulges away from it —
      // the concave cove — and meets both edges square.
      const centre =
        this.cornerType === "round"
          ? { x: P.x + r[i] * (dPrev.x + dNext.x), y: P.y + r[i] * (dPrev.y + dNext.y) }
          : P;
      cut.push({
        kind: "arc",
        center: centre,
        radius: r[i],
        startAngle: Math.atan2(T1.y - centre.y, T1.x - centre.x),
        endAngle: Math.atan2(T2.y - centre.y, T2.x - centre.x),
        // A convex corner rounds CCW on a CCW ring; the cove goes the other way.
        ccw: this.cornerType === "round",
      });
    }

    const parts: OutlinePart[] = [];
    for (let i = 0; i < 4; i++) {
      const cp = cut[i];
      if (cp) parts.push(cp);
      const a = ends[i].out;
      const b = ends[(i + 1) % 4].in;
      // Two corners can eat a whole edge between them; there is then no run.
      if (Math.abs(a.x - b.x) > CORNER_R_EPS || Math.abs(a.y - b.y) > CORNER_R_EPS)
        parts.push({ kind: "line", a, b });
    }
    return parts;
  }

  /**
   * The boundary as one closed ring of points, CCW from the bottom-left.
   *
   * THE SEAM for parametric corners: the one place a rectangle becomes a
   * boundary, so a corner radius reaches every toolpath, export and pixel at
   * once. Before it existed, fifteen CAM call sites each rebuilt a rectangle out
   * of `corners()` as four straight segments — adding a radius would have left
   * all fifteen cutting square corners while the canvas drew round ones, the
   * drawing and the program disagreeing, which is the worst failure this app has
   * available to it.
   *
   * Use this wherever a rectangle is treated as an OUTLINE (CAM, offsetting,
   * export, rendering). Keep using {@link corners} where the four *named*
   * corners or edges are the subject — picking, corner snaps, the DOF points
   * constraints address, and the `mid_b`/`mid_r`/`mid_t`/`mid_l` edges that
   * snapping, trim/extend and intersection name. Those stay four corners and
   * four edges however they are shaped, and that naming IS the constraint
   * vocabulary: a tessellated ring has no `mid_b` to offer, so moving those
   * call sites onto this would break the references it exists to protect.
   *
   * `toleranceMM` is the maximum chord deviation when flattening the arcs; the
   * 0.05mm default is the usual CAM arc tolerance, and the renderer passes half
   * a screen pixel.
   */
  outlinePoints(toleranceMM = 0.05): Vec2[] {
    const parts = this.outlineParts();
    const pts: Vec2[] = [];
    for (const p of parts) {
      // Each part contributes its start; the next part's start closes it, and
      // the ring closes onto pts[0]. So an unshaped rectangle yields exactly
      // its four corners, unchanged, which is what let every consumer migrate.
      if (p.kind === "line") {
        pts.push({ ...p.a });
        continue;
      }
      const span = arcSweep(p);
      const steps = arcSteps(p.radius, Math.abs(span), toleranceMM);
      for (let k = 0; k < steps; k++) {
        const a = p.startAngle + (span * k) / steps;
        pts.push({ x: p.center.x + p.radius * Math.cos(a), y: p.center.y + p.radius * Math.sin(a) });
      }
    }
    return pts;
  }

  override bounds(): Bounds {
    // Unaffected by corner radii: every corner treatment cuts INTO the corner,
    // so the extremes are still the two defining points.
    return { min: this.minPt, max: this.maxPt };
  }
  override distanceTo(p: Vec2): number {
    if (!this.hasShapedCorners()) {
      const c = this.corners();
      let d = Infinity;
      for (let i = 0; i < 4; i++) {
        d = Math.min(d, distToSegment(p, c[i], c[(i + 1) % 4]));
      }
      return d;
    }
    // Exact against the arcs, not the flattened ring: picking a shaped corner
    // should not depend on how finely it happens to be tessellated.
    let d = Infinity;
    for (const part of this.outlineParts()) {
      d = Math.min(
        d,
        part.kind === "line"
          ? distToSegment(p, part.a, part.b)
          : part.ccw
            ? distToArc(p, part.center, part.radius, part.startAngle, part.endAngle)
            : distToArc(p, part.center, part.radius, part.endAngle, part.startAngle),
      );
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
    const midKeys = ["mid_b", "mid_r", "mid_t", "mid_l"] as const;
    for (let i = 0; i < 4; i++) {
      pts.push({
        pos: mid(c[i], c[(i + 1) % 4]),
        kind: "midpoint",
        entityId: this.id,
        key: midKeys[i],
      });
    }
    pts.push({ pos: mid(this.minPt, this.maxPt), kind: "center", entityId: this.id, key: "center" });
    return pts;
  }
  override translate(d: Vec2): void {
    this.p0 = add(this.p0, d);
    this.p1 = add(this.p1, d);
  }
  override duplicate(): RectEntity {
    const e = new RectEntity(this.p0, this.p1);
    e.cornerRadii = [...this.cornerRadii];
    e.cornerType = this.cornerType;
    this.copyCommonTo(e);
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
  /**
   * The whole-shape corner radius, as one scalar DOF — what makes a corner
   * radius drivable by a formula (`Radius = thickness * 2`), the same channel a
   * circle's radius uses.
   *
   * `cr` is deliberately NOT a solver freedom: unlike a circle's `r`, which
   * tangent/equal/radius constraints act on, no constraint type reads a corner
   * radius, so a free variable here is one the solver could only hold still.
   * The solver therefore fixes it unless a binding drives it (see
   * `fixUndrivenScalars`), which keeps an ordinary rectangle costing exactly
   * what it always did.
   *
   * One scalar for four corners, matching the properties panel's whole-shape
   * control: a formula on the radius means "every corner follows this". When the
   * four differ it reports the largest — there is no single answer, and a bound
   * radius is about to make them equal anyway.
   */
  override dofScalars(): DofScalar[] {
    return [{ key: "cr", value: Math.max(...this.cornerRadii.map((r) => (r > 0 ? r : 0))) }];
  }
  override setScalar(key: string, v: number): void {
    if (key !== "cr") return;
    const r = Number.isFinite(v) && v > 0 ? v : 0;
    this.cornerRadii = [r, r, r, r];
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
  /**
   * Corner size per vertex, keyed by VERTEX ID — mm, and what the vertex's
   * {@link cornerType} makes of it (radius for round/inverted, setback for
   * chamfer; see {@link cornerSetback}).
   *
   * This is what makes a filleted polyline stay a POLYLINE. A fillet used to
   * splice ~90 vertices in where one used to be, so the corner could never be
   * adjusted again — the polyline half of the "can't edit a fillet" report that
   * {@link RectEntity.cornerRadii} fixed for rectangles.
   *
   * Keyed rather than a fourth array parallel to `points`/`vertexIds`, which is
   * the shape a rectangle uses. A rectangle has exactly four corners that can
   * never move; a polyline's vertex set changes under every edit, which is the
   * entire reason `vertexIds` exists. Keying off that id makes a whole class of
   * bug unrepresentable: a radius cannot end up on the wrong vertex after a
   * splice, a reversal or an insert, because it is not addressed by position.
   * (That bug was real — flipping a polyline reversed `points` and not
   * `vertexIds`; see the note on {@link reverse}.)
   *
   * Stored as asked for, not as drawn: a value too big for the legs it sits
   * between is scaled down when the boundary is built, so pulling a vertex in
   * and back out restores the corner instead of destroying it.
   */
  cornerRadii: Map<string, number> = new Map();
  /** How the shaped corners are cut. One type per polyline, as for a rectangle. */
  cornerType: CornerType = "round";

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
    // Ids are reset, so nothing a corner was keyed to still exists.
    this.cornerRadii.clear();
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
    for (const gone of this.vertexIds.splice(start, deleteCount, ...newIds))
      this.cornerRadii.delete(gone);
  }

  /**
   * Reverse the traversal direction, keeping everything indexed BY vertex in
   * lock-step with `points` — ids included.
   *
   * A bare `points.reverse()` is a silent constraint corruption: vertex
   * point-keys (`v<id>`) resolve through `vertexIds` BY INDEX, so reversing one
   * array and not the other leaves every constraint and dimension on the shape
   * pointing at a different physical vertex. A mirror has to reverse winding to
   * stay CCW, so this is the only way to do it.
   *
   * Segment keys (`mid_<id>`, and the `<id>#<vertexId>` a segment-as-line
   * constraint uses) name a segment by the vertex it LEAVES, so each one moves
   * to the other end of its own segment. That is inherent to reversing
   * direction, not something an ordering could avoid: which endpoint comes first
   * is exactly what changed.
   */
  reverse(): void {
    this.points.reverse();
    this.vertexIds.reverse();
    // `cornerRadii` needs nothing: it is keyed by vertex id, so each corner is
    // already attached to the vertex that moved. That is the point of keying it
    // that way rather than adding a third array to keep in step here.
  }

  /**
   * The boundary as an ordered list of points, in vertex order.
   *
   * THE SEAM, the polyline twin of {@link RectEntity.outlinePoints}: the one
   * place a polyline becomes a boundary. Today it is the vertices themselves,
   * so this is inert — but it is the single method a per-vertex corner radius
   * has to change to reach every toolpath, export and pixel at once, instead of
   * thirty call sites each rebuilding the shape out of the vertex list.
   *
   * WHICH USES BELONG HERE. `points` is read two ways and only the call site
   * says which, so the rule is what the code is ASKING FOR, not what it does
   * with it:
   *
   *  - **The boundary** — what gets cut, drawn, offset, filled or exported.
   *    Those come here. A shaped corner has to appear in all of them together;
   *    one that reads the vertex list instead cuts a square corner while the
   *    canvas draws a round one, which is the worst failure this app has.
   *  - **The vertices** — the DOF the solver moves, the ids constraints and
   *    dimensions name (`v<id>`, `mid_<id>`), and the things that edit them:
   *    transforms writing positions back, `intersect` handing out segments
   *    tagged with `vertexIds`, trim/extend's named targets, Join's chaining,
   *    vertex pickers. Those stay on `points`, exactly as the four NAMED
   *    corners of a rectangle stayed on `corners()`. That naming IS the
   *    constraint vocabulary, and a tessellated ring has none of it.
   *
   * The tell is whether the answer would have to change if a corner were
   * rounded. "Where do I cut?" — yes. "Which vertex is v3?" — no.
   *
   * `toleranceMM` is the maximum chord deviation once there are arcs to
   * flatten; it matches the rectangle's signature so both ends of the seam can
   * be called the same way.
   */
  outlinePoints(toleranceMM = 0.05): Vec2[] {
    const parts = this.outlineParts();
    if (parts === null) return this.points.map(clone);
    const pts: Vec2[] = [];
    for (const p of parts) {
      if (p.kind === "line") {
        pts.push({ ...p.a });
        continue;
      }
      const span = arcSweep(p);
      const steps = arcSteps(p.radius, Math.abs(span), toleranceMM);
      for (let k = 0; k < steps; k++) {
        const a = p.startAngle + (span * k) / steps;
        pts.push({ x: p.center.x + p.radius * Math.cos(a), y: p.center.y + p.radius * Math.sin(a) });
      }
    }
    // An OPEN polyline's boundary is a chain, so its far end is a real endpoint
    // rather than the start of a closing run — nothing else will contribute it.
    if (!this.closed) pts.push({ ...this.points[this.points.length - 1] });
    return pts;
  }

  /**
   * Which vertices can carry a corner at all.
   *
   * An open polyline's two ends are not corners — there is nothing on the far
   * side to be tangent to — which is the same rule the Fillet and Chamfer tools
   * already apply when picking.
   */
  private isShapeableVertex(i: number): boolean {
    return this.closed || (i > 0 && i < this.points.length - 1);
  }

  /** The corner value asked for at vertex index `i`, before any clamping. */
  cornerValueAt(i: number): number {
    if (!this.isShapeableVertex(i)) return 0;
    const v = this.cornerRadii.get(this.vertexIds[i]);
    return Number.isFinite(v) && (v as number) > CORNER_R_EPS ? (v as number) : 0;
  }

  /**
   * The corner values as they can actually be drawn: each scaled so two corners
   * sharing an edge cannot overrun it.
   *
   * Indexed by vertex position, parallel to `points`. Same rule as
   * {@link RectEntity.effectiveCornerRadii} — clamp when the boundary is built,
   * per shared edge rather than by one global factor — but the length a corner
   * eats now depends on its angle and type, so it goes through
   * {@link cornerSetback} rather than being the value itself.
   */
  /**
   * The drawable corner value at each SHAPED vertex, by index — the clamp,
   * computed sparsely.
   *
   * Sparse because this sits under `distanceTo`, which hit-testing calls for
   * every entity on every pointer move. A dense version cost six passes over the
   * vertex list and two arrays the length of it, so a 20,000-point imported
   * trace with one filleted corner paid for 20,000 corners it did not have.
   * Here everything but a single cheap scan is proportional to the corners that
   * actually exist.
   */
  private clampedCorners(): Map<number, number> {
    const out = new Map<number, number>();
    if (this.cornerRadii.size === 0) return out; // O(1), before touching a vertex
    const n = this.points.length;

    const want = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      const v = this.cornerValueAt(i);
      if (v > CORNER_R_EPS) want.set(i, v);
    }
    if (want.size === 0) return out;

    // A wedge costs a hypot and an acos, so only the shaped vertices get one.
    const eat = new Map<number, number>();
    for (const [i, v] of want) {
      const w = this.wedgeAt(i);
      if (w) eat.set(i, cornerSetback(w, v, this.cornerType));
    }

    // Edge i runs from vertex i to vertex i+1, and both its ends eat into it.
    // Only an edge with a corner on one end can bind, so the scan visits those
    // edges rather than all of them.
    const segs = this.segmentCount();
    const fit = new Map<number, number>();
    const bind = (i: number, f: number) => fit.set(i, Math.min(fit.get(i) ?? 1, f));
    const edge = (a: number, b: number) => {
      if (a >= segs) return; // open polyline: no closing edge
      const pair = (eat.get(a) ?? 0) + (eat.get(b) ?? 0);
      if (pair <= CORNER_R_EPS) return;
      const len = Math.hypot(
        this.points[b].x - this.points[a].x,
        this.points[b].y - this.points[a].y,
      );
      if (pair > len) {
        bind(a, len / pair);
        bind(b, len / pair);
      }
    };
    for (const i of eat.keys()) {
      const prev = (i + n - 1) % n;
      edge(i, (i + 1) % n);
      // The edge behind this vertex, unless the vertex behind it is shaped too —
      // it was that one's forward edge, and measuring it twice is the difference
      // between one pass and two on a shape filleted throughout.
      if (!eat.has(prev)) edge(prev, i);
    }

    for (const [i, v] of want) out.set(i, v * (fit.get(i) ?? 1));
    return out;
  }

  /**
   * The corner values as they can actually be drawn, indexed by vertex position
   * and parallel to `points`.
   *
   * Same rule as {@link RectEntity.effectiveCornerRadii} — clamp when the
   * boundary is built, per shared edge rather than by one global factor — but
   * the length a corner eats now depends on its angle and type, so it goes
   * through {@link cornerSetback} rather than being the value itself.
   */
  effectiveCornerValues(): number[] {
    const clamped = this.clampedCorners();
    const out = new Array<number>(this.points.length).fill(0);
    for (const [i, v] of clamped) out[i] = v;
    return out;
  }

  /** The wedge at vertex `i`, or null where no corner can be cut. */
  private wedgeAt(i: number): CornerWedge | null {
    if (!this.isShapeableVertex(i)) return null;
    const n = this.points.length;
    return cornerWedge(this.points[i], this.points[(i + n - 1) % n], this.points[(i + 1) % n]);
  }

  /** True when at least one vertex is actually shaped (a drawable corner). */
  hasShapedCorners(): boolean {
    return this.effectiveCornerValues().some((v) => v > CORNER_R_EPS);
  }

  /**
   * Whether this polyline has any vertex that could carry a corner — a closed
   * one always does, an open one needs a vertex that is not an end.
   *
   * Deliberately O(1) and trig-free. It answers the only question the properties
   * panel asks on every refresh ("offer the corner controls at all?"), and a
   * refresh happens on every `emitChange` — so on every frame of a drag. Asking
   * {@link maxUniformCornerValue} instead cost a hypot and an acos per vertex,
   * 3.6ms a frame on a 20,000-point polyline that had no corners on it.
   */
  canShapeCorners(): boolean {
    return this.points.length >= 3;
  }

  /**
   * The largest value every shapeable vertex could carry at once, at the current
   * shape. The polyline twin of {@link RectEntity.maxUniformCornerRadius}.
   *
   * Each edge is shared by two corners whose setbacks scale linearly with the
   * value, so the whole-shape ceiling is the tightest edge's. O(n) with trig per
   * vertex — call it when a value is COMMITTED, not to decide what to draw.
   */
  maxUniformCornerValue(): number {
    const n = this.points.length;
    const k = this.points.map((_, i) => {
      const w = this.wedgeAt(i);
      return w ? cornerSetback(w, 1, this.cornerType) : 0;
    });
    let best = Infinity;
    for (let i = 0; i < this.segmentCount(); i++) {
      const j = (i + 1) % n;
      const share = k[i] + k[j];
      if (share <= CORNER_R_EPS) continue;
      const len = Math.hypot(
        this.points[j].x - this.points[i].x,
        this.points[j].y - this.points[i].y,
      );
      best = Math.min(best, len / share);
    }
    return Number.isFinite(best) ? best : 0;
  }

  /**
   * Whether `value` can be applied at vertex `i` beside its neighbours' corners.
   *
   * Two corners share an edge, so a value that is fine against its own legs can
   * still fail to leave room for the next one. Asked before committing, so an
   * impossible corner is refused out loud instead of silently clamped down.
   */
  fitsCornerValue(i: number, value: number): boolean {
    if (!(value > CORNER_R_EPS)) return true; // square always fits
    return value <= this.maxCornerValueAt(i) + CORNER_R_EPS;
  }

  /**
   * The largest value vertex `i` can take beside its neighbours' corners, at the
   * current shape — 0 when it cannot be shaped at all.
   *
   * The single definition of "how big can this corner be": {@link
   * fitsCornerValue} asks it, and the properties panel clamps to it so the panel
   * can never report a corner the shape does not have.
   */
  maxCornerValueAt(i: number): number {
    if (!this.isShapeableVertex(i)) return 0;
    const w = this.wedgeAt(i);
    if (!w) return 0;
    const n = this.points.length;
    // Setback is linear in the value, so the room left on a leg converts back
    // into a value by dividing by the per-unit setback.
    const perUnit = cornerSetback(w, 1, this.cornerType);
    if (!(perUnit > 0)) return 0;
    const neighbour = (j: number): number => {
      const wj = this.wedgeAt(j);
      const v = this.cornerValueAt(j);
      return wj && v > 0 ? cornerSetback(wj, v, this.cornerType) : 0;
    };
    const room = Math.min(
      w.len1 - neighbour((i + n - 1) % n),
      w.len2 - neighbour((i + 1) % n),
    );
    return Math.max(0, room / perUnit);
  }

  /**
   * The boundary as straight runs and corner arcs, in vertex order — or `null`
   * when no corner is shaped, so the common case allocates nothing and every
   * consumer keeps seeing exactly the vertex list it always did.
   */
  /**
   * The shaped vertices' geometry, by vertex index — or null when none is.
   *
   * Sparse on purpose. Everything downstream needs the same two facts (where the
   * boundary leaves and rejoins each shaped vertex, and what bridges them), and
   * this is the only place that works them out. It costs a wedge — a hypot and
   * an acos — per SHAPED vertex, not per vertex, which is what keeps a
   * 20,000-point trace with one filleted corner cheap to hit-test.
   */
  private cornerEnds(): Map<number, { in: Vec2; out: Vec2; cut: OutlinePart }> | null {
    const out = new Map<number, { in: Vec2; out: Vec2; cut: OutlinePart }>();
    for (const [i, v] of this.clampedCorners()) {
      const w = this.wedgeAt(i);
      const c = w ? cornerCut(w, v, this.cornerType) : null;
      if (c) out.set(i, c);
    }
    return out.size > 0 ? out : null;
  }

  outlineParts(): OutlinePart[] | null {
    const ends = this.cornerEnds();
    if (!ends) return null;

    const n = this.points.length;
    const segs = this.segmentCount();
    const parts: OutlinePart[] = [];
    for (let i = 0; i < n; i++) {
      const c = ends.get(i);
      if (c) parts.push(c.cut);
      if (i >= segs) break; // open polyline: no closing run off the last vertex
      // An unshaped vertex leaves and rejoins at itself, which is what makes an
      // unshaped stretch come out as exactly the segments it always was.
      const a = c?.out ?? this.points[i];
      const b = ends.get((i + 1) % n)?.in ?? this.points[(i + 1) % n];
      // Two corners can eat a whole edge between them; there is then no run.
      if (Math.hypot(a.x - b.x, a.y - b.y) > CORNER_R_EPS) parts.push({ kind: "line", a, b });
    }
    return parts;
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
    // Hit-testing calls this for every entity on every pointer move, so it walks
    // the boundary rather than materialising it — building an OutlinePart per
    // segment here meant 20,000 short-lived objects per mouse move on a large
    // imported trace. Exact against the arcs either way: picking a shaped corner
    // must not depend on how finely it happens to tessellate.
    const ends = this.cornerEnds();
    const n = this.points.length;
    const segs = this.segmentCount();
    let d = Infinity;
    for (let i = 0; i < segs; i++) {
      const a = ends?.get(i)?.out ?? this.points[i];
      const b = ends?.get((i + 1) % n)?.in ?? this.points[(i + 1) % n];
      d = Math.min(d, distToSegment(p, a, b));
    }
    if (ends) {
      for (const { cut } of ends.values()) {
        d = Math.min(
          d,
          cut.kind === "line"
            ? distToSegment(p, cut.a, cut.b)
            : cut.ccw
              ? distToArc(p, cut.center, cut.radius, cut.startAngle, cut.endAngle)
              : distToArc(p, cut.center, cut.radius, cut.endAngle, cut.startAngle),
        );
      }
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
      pts.push({
        pos: mid(s0, s1),
        kind: "midpoint",
        entityId: this.id,
        key: `mid_${this.vertexIds[i]}`,
      });
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
    this.copyCommonTo(e);
    // Vertex ids are carried over, so the corners land back on the same
    // vertices they were keyed to.
    e.cornerRadii = new Map(this.cornerRadii);
    e.cornerType = this.cornerType;
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
  /**
   * The whole-shape corner size as one scalar DOF, so `Radius = thickness * 2`
   * drives it through an ordinary ScalarBinding — the same channel a rectangle's
   * `cr` and a circle's `r` use.
   *
   * Not a solver freedom: no constraint type reads a corner size, so the solver
   * fixes it unless a binding drives it (`fixUndrivenScalars`), and an ordinary
   * polyline costs exactly what it always did. Reports the largest when the
   * corners differ — there is no single answer, and a bound value is about to
   * make them equal anyway.
   */
  override dofScalars(): DofScalar[] {
    const vals = this.points.map((_, i) => this.cornerValueAt(i));
    return [{ key: "cr", value: vals.length ? Math.max(...vals) : 0 }];
  }
  override setScalar(key: string, v: number): void {
    if (key !== "cr") return;
    this.setAllCornerValues(Number.isFinite(v) && v > 0 ? v : 0);
  }

  /** Put `value` on every vertex that can carry a corner (0 clears them all). */
  setAllCornerValues(value: number): void {
    this.cornerRadii.clear();
    if (!(value > CORNER_R_EPS)) return;
    for (let i = 0; i < this.points.length; i++) {
      if (this.isShapeableVertex(i)) this.cornerRadii.set(this.vertexIds[i], value);
    }
  }

  /** Set (or clear, with 0) the corner at vertex index `i`. */
  setCornerValue(i: number, value: number): void {
    const id = this.vertexIds[i];
    if (id === undefined) return;
    if (value > CORNER_R_EPS && this.isShapeableVertex(i)) this.cornerRadii.set(id, value);
    else this.cornerRadii.delete(id);
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
    this.copyCommonTo(e);
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
    this.copyCommonTo(e);
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
    this.copyCommonTo(e);
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

  /**
   * Size and orientation as scalar DOFs, so a formula can drive them the way it
   * already drives a circle's radius or an image's width — `sizeMM` from a
   * variable is the whole point of a parametric label ("part number at
   * `plateW/10`"). Declaring them here is what makes a ScalarBinding on
   * `(id, "size" | "angle")` legal; the solver rejects an unknown scalar key.
   *
   * Text stays RIGID by default all the same: solver.ts pins both unless a
   * binding drives them, exactly as it does for an image. Leaving them free
   * would let a constraint stretch or spin a label to satisfy itself, and would
   * add two degrees of freedom per text object to every sketch's DOF readout.
   */
  override dofScalars(): DofScalar[] {
    return [
      { key: "size", value: this.sizeMM },
      { key: "angle", value: this.angle },
    ];
  }
  override setScalar(key: string, v: number): void {
    // Guard the size: glyph outlines are generated at this scale, and a zero or
    // negative one yields no contours at all (an empty toolpath, silently).
    if (key === "size") this.sizeMM = Math.max(1e-6, v);
    else if (key === "angle") this.angle = v;
  }
}

// ---------------------------------------------------------------------------

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
  /**
   * Whether the image's proportions are locked. Governs BOTH edit surfaces, so
   * the flag can't mean one thing in the panel and another in the solver:
   * typing in width/height writes a proportional value/formula to the other side,
   * and a constraint-driven resize scales uniformly ({@link constraintResize}).
   */
  aspectLocked = true;
  /**
   * Whether geometric constraints and dimensions may **resize** the image.
   *
   * Off by default, which makes an image a rigid body: its corners are nonlinear
   * in w/h/angle, so an image left free reflows ambiguously under a single point
   * constraint, and "pin this corner to that hole" should just move it. Turning
   * it on is the calibrate case — dimension a known distance on a scanned drawing
   * and the whole image scales to suit. With {@link aspectLocked} the two size
   * scalars become ONE degree of freedom (see {@link setScalar}), so the ratio is
   * exact by construction rather than converged.
   */
  constraintResize = false;
  /**
   * Whether geometric constraints and dimensions may **rotate** the image — e.g.
   * levelling a tilted scan by making one of its edges horizontal.
   *
   * Kept independent of {@link constraintResize} because each freedom lets the
   * solver satisfy the *other's* constraint the wrong way: a free angle meets a
   * size dimension by tilting (a 10mm gap is also a 32mm edge seen at 72°), and a
   * free size meets a levelling constraint by shrinking the image away (`w·sinθ`
   * has a root at `w = 0` as much as at `θ = 0`). Grant only the freedom the
   * intent needs and neither escape route is open.
   */
  constraintRotate = false;

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
    this.copyCommonTo(e);
    e.aspectLocked = this.aspectLocked;
    e.constraintResize = this.constraintResize;
    e.constraintRotate = this.constraintRotate;
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
      // A constraint-driven resize with the aspect locked makes the two size
      // scalars ONE degree of freedom: h rides on w at the current ratio. Because
      // h/w is unchanged by this write, the ratio is an exact invariant of every
      // solver step — the aspect is preserved by construction rather than by a
      // ratio constraint the solver would have to converge (and could trade off
      // against). The solver holds h fixed in that case (see fixImageScalars), so
      // nothing writes it back out from under this.
      const uniform = this.constraintResize && this.aspectLocked;
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
