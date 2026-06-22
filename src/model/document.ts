/** The CAD document: canvas definition, geometry, constraints, dimensions. */

import { Unit } from "../core/units";
import { Vec2, dist } from "../core/vec2";

// --- origin types ------------------------------------------------------------

export type OriginX = "left" | "center" | "right";
export type OriginY = "front" | "center" | "back";
export type OriginZ = "top" | "bed";

export interface OriginDef {
  x: OriginX;
  y: OriginY;
  z: OriginZ;
}

/**
 * Optional position the spindle rapids to (at safe Z) at the end of a G-code
 * program, before M30. Coordinates are in work units (the same frame as the
 * G-code output), so `{ x: 0, y: 0 }` parks at the WCS origin. `null` = stay
 * where the last toolpath ended (only Z lifts to safe).
 */
export interface EndPosition {
  x: number;
  y: number;
}

/**
 * Resolve the named origin into concrete offsets used by G-code generation.
 * ox / oy: subtract from canvas coords to get G-code coords.
 * zOffset: add to all Z values (0 for top-of-stock, stockThickness for bed).
 */
export function resolveOrigin(doc: CADDocument): { ox: number; oy: number; zOffset: number } {
  const ox =
    doc.origin.x === "left"   ? 0 :
    doc.origin.x === "right"  ? doc.canvas.width :
    doc.canvas.width / 2;

  const oy =
    doc.origin.y === "front"  ? 0 :
    doc.origin.y === "back"   ? doc.canvas.height :
    doc.canvas.height / 2;

  const zOffset = doc.origin.z === "top" ? 0 : doc.stockThickness;

  return { ox, oy, zOffset };
}
import { Entity, EntityId, SnapPoint, Bounds, LineEntity, CircleEntity, RectEntity, PolylineEntity, ArcEntity, BezierEntity, PointEntity, TextEntity } from "./entities";
import type { CAMOperation, ToolDef } from "../cam/types";

export const ORIGIN_ENTITY_ID = "__origin__";
import { Constraint, PointRef, SegmentRef, sameSegmentRef, samePointRef, constraintEntityIds, Geo } from "./constraints";
import { Dimension, dimensionHitDistance } from "./dimensions";
import { Variable } from "./variables";
import { PatternDef, clonePatternDef } from "./patterns";
import { updateCounter } from "./ids";

export interface GroupDef {
  id: string;
  name: string;
  entityIds: EntityId[];
}

export interface LayerDef {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  locked: boolean;
}

type EntitySnapshot =
  | { type: "line"; id: string; a: Vec2; b: Vec2; selected: boolean; isConstruction: boolean; layerId?: string }
  | { type: "circle"; id: string; center: Vec2; radius: number; selected: boolean; isConstruction: boolean; layerId?: string }
  | { type: "rectangle"; id: string; p0: Vec2; p1: Vec2; selected: boolean; isConstruction: boolean; layerId?: string }
  | { type: "polyline"; id: string; points: Vec2[]; closed: boolean; selected: boolean; isConstruction: boolean; layerId?: string }
  | { type: "arc"; id: string; center: Vec2; radius: number; startAngle: number; endAngle: number; selected: boolean; isConstruction: boolean; layerId?: string }
  | { type: "bezier"; id: string; p0: Vec2; p1: Vec2; p2: Vec2; p3: Vec2; selected: boolean; isConstruction: boolean; layerId?: string }
  | { type: "text"; id: string; text: string; fontId: string; sizeMM: number; position: Vec2; angle: number; selected: boolean; isConstruction: boolean; layerId?: string };

export interface DocSnapshot {
  entities: EntitySnapshot[];
  constraints: Constraint[];
  dimensions: Dimension[];
  variables?: Variable[];
  operations?: CAMOperation[];
  tools?: ToolDef[];
  patterns?: PatternDef[];
  isConstructionMode: boolean;
  selectedPoints: PointRef[];
  selectedConstraintId: string | null;
  selectedDimensionId: string | null;
  // document-level settings — present in all in-memory snapshots; may be
  // absent in snapshots deserialized from old .rcam files (handled in restore)
  canvas?: CanvasSize;
  stockThickness?: number;
  hasToolChanger?: boolean;
  origin?: OriginDef;
  postProcessor?: string;
  endPosition?: EndPosition | null;
  groups?: GroupDef[];
  layers?: LayerDef[];
  activeLayerId?: string;
}

export interface CanvasSize {
  /** Work-area width in mm. */
  width: number;
  /** Work-area height in mm. */
  height: number;
}

type ChangeListener = () => void;

export class CADDocument {
  canvas: CanvasSize;
  /** Unit the UI presents values in. Geometry is always stored in mm. */
  displayUnit: Unit;
  /** Thickness of the stock material in mm — used as a reference for through-cuts. */
  stockThickness = 10;
  /** Whether the machine has an automatic tool changer (emits T/M6 commands in G-code). */
  hasToolChanger = false;
  /**
   * Work-coordinate-system origin expressed as named positions.
   * Default = front-left-top (the most common CNC router convention).
   */
  origin: OriginDef = { x: "left", y: "front", z: "top" };
  /** Post-processor to use when generating G-code. */
  postProcessor = "linuxcnc";
  /**
   * Optional end-of-program park position (work coords, mm). When set, the
   * G-code rapids here at safe Z before M30; `null` leaves the tool where the
   * last toolpath ended. Defaults to off.
   */
  endPosition: EndPosition | null = null;

  entities: Entity[] = [];
  groups: GroupDef[] = [];
  patterns: PatternDef[] = [];
  layers: LayerDef[] = [{ id: "layer-0", name: "Default", color: "#cdd2da", visible: true, locked: false }];
  activeLayerId: string = "layer-0";
  constraints: Constraint[] = [];
  dimensions: Dimension[] = [];
  variables: Variable[] = [];
  isConstructionMode = false;

  /** Individually selected point DOFs (in addition to whole-entity selection). */
  selectedPoints: PointRef[] = [];
  /** Selected polyline segments (treated as lines for line-type constraints). */
  selectedSegments: SegmentRef[] = [];
  /** Selected constraint ID, or null. */
  selectedConstraintId: string | null = null;
  /** Selected dimension ID, or null. */
  selectedDimensionId: string | null = null;

  operations: CAMOperation[] = [];

  /**
   * Tool definitions embedded in this document. Operations reference these by
   * `toolId`; a single entry can drive many ops (see {@link resolveOpTool}).
   * Populated when a tool is loaded from the library into an operation.
   */
  tools: ToolDef[] = [];

  /** Entity IDs to highlight in the toolpath colour while a toolpath dialog is open. Null = no dialog open. */
  toolpathHighlightIds: Set<string> | null = null;
  /** Colour to draw highlighted toolpath entities in. Null = use the default toolpath highlight colour. */
  toolpathHighlightColor: string | null = null;

  /**
   * When set, left-clicks on the canvas are routed here (world coords) instead
   * of the active tool. Return true to consume the click. Used by the toolpath
   * dialog's region-pick mode.
   */
  regionPickHandler: ((world: Vec2) => boolean) | null = null;
  /** Called with the cursor's world position while region-pick mode is active. */
  regionHoverHandler: ((world: Vec2) => void) | null = null;
  /** Selected regions to shade — each entry is a ring list (ring 0 = outer, rest = holes). */
  regionPickFills: Vec2[][][] | null = null;
  /** Region under the cursor in region-pick mode (same ring format). */
  regionPickHoverFill: Vec2[][] | null = null;

  private listeners = new Set<ChangeListener>();

  constructor(canvas: CanvasSize, displayUnit: Unit = "mm") {
    this.canvas = canvas;
    this.displayUnit = displayUnit;
    this.entities.push(new PointEntity({ x: 0, y: 0 }, ORIGIN_ENTITY_ID));
  }

  // --- change notification -------------------------------------------------
  onChange(cb: ChangeListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emitChange(): void {
    for (const cb of this.listeners) cb();
  }

  // --- entity management ---------------------------------------------------
  add(e: Entity): Entity {
    if (e.layerId === "layer-0" && this.activeLayerId !== "layer-0") {
      e.layerId = this.activeLayerId;
    }
    this.entities.push(e);
    this.emitChange();
    return e;
  }
  /** Add an entity and make it the sole selection (used right after drawing it). */
  addSelected(e: Entity): Entity {
    for (const ent of this.entities) ent.selected = false;
    this.selectedPoints = [];
    this.selectedSegments = [];
    if (e.layerId === "layer-0" && this.activeLayerId !== "layer-0") {
      e.layerId = this.activeLayerId;
    }
    this.entities.push(e);
    e.selected = true;
    this.emitChange();
    return e;
  }
  remove(e: Entity | EntityId): void {
    const id = typeof e === "string" ? e : e.id;
    if (id === ORIGIN_ENTITY_ID) return;
    const i = this.entities.findIndex((x) => x.id === id);
    if (i >= 0) {
      this.entities.splice(i, 1);
      this.pruneReferences();
      this.emitChange();
    }
  }
  removeSelected(): void {
    const before = this.entities.length;
    this.entities = this.entities.filter((e) => !e.selected || e.id === ORIGIN_ENTITY_ID);
    if (this.entities.length !== before) {
      this.pruneReferences();
      this.emitChange();
    }
  }
  clear(): void {
    this.entities = [new PointEntity({ x: 0, y: 0 }, ORIGIN_ENTITY_ID)];
    this.constraints = [];
    this.dimensions = [];
    this.patterns = [];
    this.selectedPoints = [];
    this.selectedSegments = [];
    this.selectedConstraintId = null;
    this.selectedDimensionId = null;
    this.emitChange();
  }

  /** Drop constraints/dimensions/point-selections/patterns that reference removed entities. */
  private pruneReferences(): void {
    const ids = new Set(this.entities.map((e) => e.id));
    this.constraints = this.constraints.filter((c) =>
      constraintEntityIds(c).every((id) => ids.has(id)),
    );
    this.dimensions = this.dimensions.filter(
      (d) =>
        d.entities.every((id) => ids.has(id)) && d.points.every((p) => ids.has(p.entityId)),
    );
    this.selectedPoints = this.selectedPoints.filter((p) => ids.has(p.entityId));
    this.selectedSegments = this.selectedSegments.filter((s) => ids.has(s.entityId));
    if (this.selectedConstraintId && !this.constraints.find((c) => c.id === this.selectedConstraintId))
      this.selectedConstraintId = null;
    if (this.selectedDimensionId && !this.dimensions.find((d) => d.id === this.selectedDimensionId))
      this.selectedDimensionId = null;
    // Remove patterns whose source entities were deleted. Trim instance IDs that
    // were manually deleted so the definition stays consistent. Mutate the
    // surviving PatternDef objects in place (rather than replacing them) so a
    // reference held across a removal — e.g. during pattern regeneration — stays
    // live.
    this.patterns = this.patterns.filter((p) => p.sourceIds.every((id) => ids.has(id)));
    for (const p of this.patterns) {
      p.instanceIds = p.instanceIds
        .map((inst) => inst.filter((id) => ids.has(id)))
        .filter((inst) => inst.length > 0);
    }
    // Drop dangling entity refs from CAM operations so a removed entity — e.g. a
    // pattern instance when a count shrinks — leaves the toolpath consistent.
    for (const op of this.operations) {
      op.entityIds = op.entityIds.filter((id) => ids.has(id));
      if (op.islandIds) op.islandIds = op.islandIds.filter((id) => ids.has(id));
    }
  }

  // --- patterns ------------------------------------------------------------
  addPattern(p: PatternDef): PatternDef {
    this.patterns.push(p);
    this.emitChange();
    return p;
  }
  removePattern(id: string): void {
    this.patterns = this.patterns.filter((p) => p.id !== id);
    this.emitChange();
  }
  updatePattern(id: string, patch: Partial<Pick<PatternDef, "instanceIds" | "params" | "sourceSnapshot">>): void {
    const p = this.patterns.find((x) => x.id === id);
    if (p) Object.assign(p, patch);
    this.emitChange();
  }
  /**
   * Swap an existing instance entity's geometry for `replacement` while keeping
   * its id (and selection), without pruning references. Pattern regeneration
   * uses this so constraints, dimensions, and CAM ops pointing at a surviving
   * copy keep resolving across a regen — only genuinely removed instances are
   * pruned (via batchRemove). Does not emit; the caller batches the change.
   */
  replaceInstanceEntity(id: EntityId, replacement: Entity): void {
    // id is readonly at the type level; this is the one sanctioned place we
    // reuse an id so references to a regenerated instance survive.
    (replacement as { id: EntityId }).id = id;
    const idx = this.entities.findIndex((e) => e.id === id);
    if (idx === -1) {
      this.entities.push(replacement);
      return;
    }
    replacement.selected = this.entities[idx].selected;
    this.entities[idx] = replacement;
  }
  /** Return the pattern that contains this entity (as source or instance), or null. */
  patternOf(entityId: EntityId): PatternDef | null {
    for (const p of this.patterns) {
      if (p.sourceIds.includes(entityId)) return p;
      if (p.instanceIds.some((inst) => inst.includes(entityId))) return p;
    }
    return null;
  }
  /**
   * Remove multiple entities in one pass, call pruneReferences once, then emit.
   * Used by the pattern dialog when replacing old instances with new ones.
   */
  batchRemove(ids: Iterable<EntityId>): void {
    const toRemove = new Set(ids);
    toRemove.delete(ORIGIN_ENTITY_ID);
    const before = this.entities.length;
    this.entities = this.entities.filter((e) => !toRemove.has(e.id));
    if (this.entities.length !== before) {
      this.pruneReferences();
      this.emitChange();
    }
  }

  // --- constraints ---------------------------------------------------------
  addConstraint(c: Constraint): Constraint {
    this.constraints.push(c);
    this.emitChange();
    return c;
  }
  removeConstraint(id: string): void {
    const before = this.constraints.length;
    this.constraints = this.constraints.filter((c) => c.id !== id);
    if (this.constraints.length !== before) {
      if (this.selectedConstraintId === id) this.selectedConstraintId = null;
      this.emitChange();
    }
  }

  // --- dimensions ----------------------------------------------------------
  addDimension(d: Dimension): Dimension {
    this.dimensions.push(d);
    this.emitChange();
    return d;
  }
  removeDimension(id: string): void {
    const before = this.dimensions.length;
    this.dimensions = this.dimensions.filter((d) => d.id !== id);
    if (this.dimensions.length !== before) {
      if (this.selectedDimensionId === id) this.selectedDimensionId = null;
      this.emitChange();
    }
  }

  // --- variables -----------------------------------------------------------
  addVariable(v: Variable): Variable {
    this.variables.push(v);
    this.emitChange();
    return v;
  }
  removeVariable(id: string): void {
    const before = this.variables.length;
    this.variables = this.variables.filter((v) => v.id !== id);
    if (this.variables.length !== before) this.emitChange();
  }
  updateVariable(id: string, patch: Partial<Pick<Variable, "name" | "expr" | "value">>): void {
    const v = this.variables.find((x) => x.id === id);
    if (!v) return;
    Object.assign(v, patch);
    this.emitChange();
  }
  /**
   * Rewrite expression references to a renamed variable, in dimension formulas
   * and in pattern count/spacing expressions. Call with the OLD name *before*
   * (or just after) updateVariable; variable names are validated identifiers, so
   * the word-boundary regex is safe. No-op when the name is unchanged.
   */
  renameVariableRefs(oldName: string, newName: string): void {
    if (oldName === newName) return;
    const re = new RegExp(`\\b${oldName}\\b`, "g");
    for (const d of this.dimensions) if (d.expr) d.expr = d.expr.replace(re, newName);
    for (const pat of this.patterns) {
      const p = pat.params as unknown as Record<string, string | number | undefined>;
      for (const key of ["countXExpr", "countYExpr", "spacingXExpr", "spacingYExpr", "countExpr"] as const) {
        const e = p[key];
        if (typeof e === "string") p[key] = e.replace(re, newName);
      }
    }
  }
  private geo(): Geo {
    const m = new Map(this.entities.map((e) => [e.id, e]));
    return (id) => m.get(id);
  }
  /** Topmost dimension whose lines/text are within `tol` mm of `p`, or null. */
  dimensionAt(p: Vec2, tol: number): Dimension | null {
    const geo = this.geo();
    for (let i = this.dimensions.length - 1; i >= 0; i--) {
      if (dimensionHitDistance(this.dimensions[i], geo, p, this.displayUnit) <= tol) {
        return this.dimensions[i];
      }
    }
    return null;
  }


  // --- selection -----------------------------------------------------------
  get selected(): Entity[] {
    return this.entities.filter((e) => e.selected);
  }
  clearSelection(): void {
    let changed = this.selectedPoints.length > 0 || this.selectedSegments.length > 0 || this.selectedConstraintId !== null || this.selectedDimensionId !== null;
    this.selectedPoints = [];
    this.selectedSegments = [];
    this.selectedConstraintId = null;
    this.selectedDimensionId = null;
    for (const e of this.entities) {
      if (e.selected) {
        e.selected = false;
        changed = true;
      }
    }
    if (changed) this.emitChange();
  }

  isPointSelected(ref: PointRef): boolean {
    return this.selectedPoints.some((p) => samePointRef(p, ref));
  }
  togglePoint(ref: PointRef): void {
    const i = this.selectedPoints.findIndex((p) => samePointRef(p, ref));
    if (i >= 0) this.selectedPoints.splice(i, 1);
    else this.selectedPoints.push(ref);
    this.emitChange();
  }
  selectPoint(ref: PointRef): void {
    this.selectedPoints = [ref];
    this.emitChange();
  }
  isSegmentSelected(ref: SegmentRef): boolean {
    return this.selectedSegments.some((s) => sameSegmentRef(s, ref));
  }
  toggleSegment(ref: SegmentRef): void {
    const i = this.selectedSegments.findIndex((s) => sameSegmentRef(s, ref));
    if (i >= 0) this.selectedSegments.splice(i, 1);
    else this.selectedSegments.push(ref);
    this.emitChange();
  }

  selectConstraint(id: string | null): void {
    this.clearSelection();
    this.selectedConstraintId = id;
    this.emitChange();
  }

  selectDimension(id: string | null): void {
    this.clearSelection();
    this.selectedDimensionId = id;
    this.emitChange();
  }

  /** Nearest pickable point DOF within `tol` mm of `p`, or null. */
  pickPoint(p: Vec2, tol: number): { ref: PointRef; pos: Vec2 } | null {
    let best: { ref: PointRef; pos: Vec2 } | null = null;
    let bestD = tol;
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];
      const layer = this.layers.find(l => l.id === e.layerId) || this.layers[0];
      if (!layer.visible || layer.locked) continue;

      for (const dp of e.pickablePoints()) {
        const d = dist(dp.pos, p);
        if (d <= bestD) {
          bestD = d;
          best = { ref: { entityId: e.id, key: dp.key }, pos: dp.pos };
        }
      }
    }
    return best;
  }

  // --- queries -------------------------------------------------------------
  /** Topmost entity whose outline is within `tol` mm of `p`, or null. */
  hitTest(p: Vec2, tol: number): Entity | null {
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];
      const layer = this.layers.find(l => l.id === e.layerId) || this.layers[0];
      if (!layer.visible || layer.locked) continue;
      
      if (e.distanceTo(p) <= tol) return e;
    }
    return null;
  }

  /** All object-snap points across every entity (optionally excluding some). */
  snapPoints(exclude?: Set<EntityId>): SnapPoint[] {
    const out: SnapPoint[] = [];
    for (const e of this.entities) {
      if (exclude?.has(e.id)) continue;
      const layer = this.layers.find(l => l.id === e.layerId) || this.layers[0];
      if (!layer.visible) continue; // snapping still works on locked layers, but not invisible ones
      out.push(...e.snapPoints());
    }
    return out;
  }

  /** Combined bounds of all geometry, or null when empty. */
  bounds(): Bounds | null {
    const drawable = this.entities.filter(e => e.id !== ORIGIN_ENTITY_ID);
    if (drawable.length === 0) return null;
    const min: Vec2 = { x: Infinity, y: Infinity };
    const max: Vec2 = { x: -Infinity, y: -Infinity };
    for (const e of drawable) {
      const b = e.bounds();
      min.x = Math.min(min.x, b.min.x);
      min.y = Math.min(min.y, b.min.y);
      max.x = Math.max(max.x, b.max.x);
      max.y = Math.max(max.y, b.max.y);
    }
    return { min, max };
  }

  groupOf(entityId: EntityId): GroupDef | null {
    return this.groups.find(g => g.entityIds.includes(entityId)) ?? null;
  }

  // --- undo/redo snapshots --------------------------------------------------
  snapshot(): DocSnapshot {
    return {
      entities: this.entities.filter(e => e.id !== ORIGIN_ENTITY_ID).map((e): EntitySnapshot => {
        if (e instanceof LineEntity)
          return { type: "line", id: e.id, a: { ...e.a }, b: { ...e.b }, selected: e.selected, isConstruction: e.isConstruction, layerId: e.layerId };
        if (e instanceof CircleEntity)
          return { type: "circle", id: e.id, center: { ...e.center }, radius: e.radius, selected: e.selected, isConstruction: e.isConstruction, layerId: e.layerId };
        if (e instanceof RectEntity)
          return { type: "rectangle", id: e.id, p0: { ...e.p0 }, p1: { ...e.p1 }, selected: e.selected, isConstruction: e.isConstruction, layerId: e.layerId };
        if (e instanceof ArcEntity)
          return { type: "arc", id: e.id, center: { ...e.center }, radius: e.radius, startAngle: e.startAngle, endAngle: e.endAngle, selected: e.selected, isConstruction: e.isConstruction, layerId: e.layerId };
        if (e instanceof BezierEntity)
          return { type: "bezier", id: e.id, p0: { ...e.p0 }, p1: { ...e.p1 }, p2: { ...e.p2 }, p3: { ...e.p3 }, selected: e.selected, isConstruction: e.isConstruction, layerId: e.layerId };
        if (e instanceof TextEntity)
          return { type: "text", id: e.id, text: e.text, fontId: e.fontId, sizeMM: e.sizeMM, position: { ...e.position }, angle: e.angle, selected: e.selected, isConstruction: e.isConstruction, layerId: e.layerId };
        const pe = e as PolylineEntity;
        return { type: "polyline", id: pe.id, points: pe.points.map((p) => ({ ...p })), closed: pe.closed, selected: pe.selected, isConstruction: pe.isConstruction, layerId: pe.layerId };
      }),
      constraints: this.constraints.map((c) => ({
        id: c.id, type: c.type,
        points: c.points.map((p) => ({ ...p })),
        entities: [...c.entities],
        params: c.params ? [...c.params] : undefined,
      })),
      dimensions: this.dimensions.map((d) => ({
        ...d,
        points: d.points.map((p) => ({ ...p })),
        entities: [...d.entities],
      })),
      variables: this.variables.map((v) => ({ ...v })),
      isConstructionMode: this.isConstructionMode,
      selectedPoints: this.selectedPoints.map((p) => ({ ...p })),
      selectedConstraintId: this.selectedConstraintId,
      selectedDimensionId: this.selectedDimensionId,
      canvas: { ...this.canvas },
      stockThickness: this.stockThickness,
      hasToolChanger: this.hasToolChanger,
      origin: { ...this.origin },
      postProcessor: this.postProcessor,
      endPosition: this.endPosition ? { ...this.endPosition } : null,
      groups: this.groups.map(g => ({ id: g.id, name: g.name, entityIds: [...g.entityIds] })),
      patterns: this.patterns.map(clonePatternDef),
      layers: this.layers.map(l => ({ ...l })),
      activeLayerId: this.activeLayerId,
      operations: this.operations.map(op => ({ ...op, entityIds: [...op.entityIds] })),
      tools: this.tools.map(t => ({ ...t })),
    };
  }

  restore(s: DocSnapshot): void {
    this.layers = s.layers ? s.layers.map(l => ({ ...l })) : [{ id: "layer-0", name: "Default", color: "#cdd2da", visible: true, locked: false }];
    this.activeLayerId = s.activeLayerId ?? "layer-0";

    this.entities = s.entities.map((es): Entity => {
      let e: Entity;
      switch (es.type) {
        case "line": {
          e = new LineEntity({ ...es.a }, { ...es.b }, es.id);
          break;
        }
        case "circle": {
          e = new CircleEntity({ ...es.center }, es.radius, es.id);
          break;
        }
        case "rectangle": {
          e = new RectEntity({ ...es.p0 }, { ...es.p1 }, es.id);
          break;
        }
        case "polyline": {
          e = new PolylineEntity(es.points.map((p) => ({ ...p })), es.closed, es.id);
          break;
        }
        case "arc": {
          e = new ArcEntity({ ...es.center }, es.radius, es.startAngle, es.endAngle, es.id);
          break;
        }
        case "bezier": {
          e = new BezierEntity({ ...es.p0 }, { ...es.p1 }, { ...es.p2 }, { ...es.p3 }, es.id);
          break;
        }
        case "text": {
          e = new TextEntity(es.text, es.fontId, es.sizeMM, { ...es.position }, es.angle, es.id);
          break;
        }
      }
      if (e) {
        updateCounter(e.id);
        e.selected = es.selected ?? false;
        e.isConstruction = es.isConstruction ?? false;
        e.layerId = es.layerId ?? "layer-0";
      }
      return e!;
    });

    for (const g of s.groups ?? []) {
      updateCounter(g.id);
    }

    this.constraints = (s.constraints || []).map((cs) => {
      // points/entities default to [] so hand- or LLM-authored files can omit the
      // array that a given constraint type doesn't use (e.g. "horizontal" needs
      // only entities). serializeDoc always writes both, so round-trips are unaffected.
      const c = { id: cs.id, type: cs.type, points: (cs.points ?? []).map((p) => ({ ...p })), entities: [...(cs.entities ?? [])], params: cs.params ? [...cs.params] : undefined } as Constraint;
      updateCounter(c.id);
      return c;
    });

    this.dimensions = (s.dimensions || []).map((ds) => {
      const d = { ...ds, points: (ds.points ?? []).map((p) => ({ ...p })), entities: [...(ds.entities ?? [])] } as Dimension;
      updateCounter(d.id);
      return d;
    });
    this.variables = (s.variables || []).map((v) => ({ ...v }));

    this.isConstructionMode = s.isConstructionMode;
    this.selectedPoints = s.selectedPoints.map((p) => ({ ...p }));
    this.selectedConstraintId = s.selectedConstraintId ?? null;
    this.selectedDimensionId = s.selectedDimensionId ?? null;
    if (s.canvas)       this.canvas         = { ...s.canvas };
    if (s.stockThickness !== undefined) this.stockThickness = s.stockThickness;
    if (s.hasToolChanger !== undefined) this.hasToolChanger = s.hasToolChanger;
    if (s.origin)       this.origin         = { ...s.origin };
    if (s.postProcessor) this.postProcessor = s.postProcessor;
    this.endPosition = s.endPosition ? { x: s.endPosition.x, y: s.endPosition.y } : null;
    this.groups = s.groups ? s.groups.map(g => ({ id: g.id, name: g.name ?? "", entityIds: [...g.entityIds] })) : [];
    this.patterns = s.patterns ? s.patterns.map(clonePatternDef) : [];
    for (const p of this.patterns) updateCounter(p.id);
    this.operations = s.operations ? s.operations.map(op => ({
      ...op,
      toolType: op.toolType ?? "end-mill",
      stepover: op.stepover ?? 0.4,
      entityIds: [...op.entityIds],
    })) : [];
    this.tools = s.tools ? s.tools.map(t => ({ ...t })) : [];
    // Always ensure the WCS origin entity is present after loading.
    if (!this.entities.find(e => e.id === ORIGIN_ENTITY_ID))
      this.entities.unshift(new PointEntity({ x: 0, y: 0 }, ORIGIN_ENTITY_ID));
    this.emitChange();
  }
}
