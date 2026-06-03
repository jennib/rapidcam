/** The CAD document: canvas definition, geometry, constraints, dimensions. */

import { Unit } from "../core/units";
import { Vec2, dist } from "../core/vec2";
import { Entity, EntityId, SnapPoint, Bounds, LineEntity, CircleEntity, RectEntity, PolylineEntity } from "./entities";
import { Constraint, PointRef, samePointRef, constraintEntityIds, Geo } from "./constraints";
import { Dimension, dimensionHitDistance } from "./dimensions";

type EntitySnapshot =
  | { type: "line"; id: string; a: Vec2; b: Vec2; selected: boolean; isConstruction: boolean }
  | { type: "circle"; id: string; center: Vec2; radius: number; selected: boolean; isConstruction: boolean }
  | { type: "rectangle"; id: string; p0: Vec2; p1: Vec2; selected: boolean; isConstruction: boolean }
  | { type: "polyline"; id: string; points: Vec2[]; closed: boolean; selected: boolean; isConstruction: boolean };

export interface DocSnapshot {
  entities: EntitySnapshot[];
  constraints: Constraint[];
  dimensions: Dimension[];
  isConstructionMode: boolean;
  selectedPoints: PointRef[];
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

  entities: Entity[] = [];
  constraints: Constraint[] = [];
  dimensions: Dimension[] = [];
  isConstructionMode = false;

  /** Individually selected point DOFs (in addition to whole-entity selection). */
  selectedPoints: PointRef[] = [];

  private listeners = new Set<ChangeListener>();

  constructor(canvas: CanvasSize, displayUnit: Unit = "mm") {
    this.canvas = canvas;
    this.displayUnit = displayUnit;
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
    this.entities.push(e);
    this.emitChange();
    return e;
  }
  /** Add an entity and make it the sole selection (used right after drawing it). */
  addSelected(e: Entity): Entity {
    for (const ent of this.entities) ent.selected = false;
    this.selectedPoints = [];
    this.entities.push(e);
    e.selected = true;
    this.emitChange();
    return e;
  }
  remove(e: Entity | EntityId): void {
    const id = typeof e === "string" ? e : e.id;
    const i = this.entities.findIndex((x) => x.id === id);
    if (i >= 0) {
      this.entities.splice(i, 1);
      this.pruneReferences();
      this.emitChange();
    }
  }
  removeSelected(): void {
    const before = this.entities.length;
    this.entities = this.entities.filter((e) => !e.selected);
    if (this.entities.length !== before) {
      this.pruneReferences();
      this.emitChange();
    }
  }
  clear(): void {
    this.entities = [];
    this.constraints = [];
    this.dimensions = [];
    this.selectedPoints = [];
    this.emitChange();
  }

  /** Drop constraints/dimensions/point-selections that reference removed entities. */
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
    if (this.constraints.length !== before) this.emitChange();
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
    if (this.dimensions.length !== before) this.emitChange();
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
    let changed = this.selectedPoints.length > 0;
    this.selectedPoints = [];
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
  }

  /** Nearest pickable point DOF within `tol` mm of `p`, or null. */
  pickPoint(p: Vec2, tol: number): { ref: PointRef; pos: Vec2 } | null {
    let best: { ref: PointRef; pos: Vec2 } | null = null;
    let bestD = tol;
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];
      for (const dp of e.dofPoints()) {
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
      if (this.entities[i].distanceTo(p) <= tol) return this.entities[i];
    }
    return null;
  }

  /** All object-snap points across every entity (optionally excluding some). */
  snapPoints(exclude?: Set<EntityId>): SnapPoint[] {
    const out: SnapPoint[] = [];
    for (const e of this.entities) {
      if (exclude?.has(e.id)) continue;
      out.push(...e.snapPoints());
    }
    return out;
  }

  /** Combined bounds of all geometry, or null when empty. */
  bounds(): Bounds | null {
    if (this.entities.length === 0) return null;
    const min: Vec2 = { x: Infinity, y: Infinity };
    const max: Vec2 = { x: -Infinity, y: -Infinity };
    for (const e of this.entities) {
      const b = e.bounds();
      min.x = Math.min(min.x, b.min.x);
      min.y = Math.min(min.y, b.min.y);
      max.x = Math.max(max.x, b.max.x);
      max.y = Math.max(max.y, b.max.y);
    }
    return { min, max };
  }

  // --- undo/redo snapshots --------------------------------------------------
  snapshot(): DocSnapshot {
    return {
      entities: this.entities.map((e): EntitySnapshot => {
        if (e instanceof LineEntity)
          return { type: "line", id: e.id, a: { ...e.a }, b: { ...e.b }, selected: e.selected, isConstruction: e.isConstruction };
        if (e instanceof CircleEntity)
          return { type: "circle", id: e.id, center: { ...e.center }, radius: e.radius, selected: e.selected, isConstruction: e.isConstruction };
        if (e instanceof RectEntity)
          return { type: "rectangle", id: e.id, p0: { ...e.p0 }, p1: { ...e.p1 }, selected: e.selected, isConstruction: e.isConstruction };
        const pe = e as PolylineEntity;
        return { type: "polyline", id: pe.id, points: pe.points.map((p) => ({ ...p })), closed: pe.closed, selected: pe.selected, isConstruction: pe.isConstruction };
      }),
      constraints: this.constraints.map((c) => ({
        id: c.id, type: c.type,
        points: c.points.map((p) => ({ ...p })),
        entities: [...c.entities],
      })),
      dimensions: this.dimensions.map((d) => ({
        ...d,
        points: d.points.map((p) => ({ ...p })),
        entities: [...d.entities],
      })),
      isConstructionMode: this.isConstructionMode,
      selectedPoints: this.selectedPoints.map((p) => ({ ...p })),
    };
  }

  restore(s: DocSnapshot): void {
    this.entities = s.entities.map((es): Entity => {
      switch (es.type) {
        case "line": {
          const e = new LineEntity({ ...es.a }, { ...es.b }, es.id);
          e.selected = es.selected; e.isConstruction = es.isConstruction; return e;
        }
        case "circle": {
          const e = new CircleEntity({ ...es.center }, es.radius, es.id);
          e.selected = es.selected; e.isConstruction = es.isConstruction; return e;
        }
        case "rectangle": {
          const e = new RectEntity({ ...es.p0 }, { ...es.p1 }, es.id);
          e.selected = es.selected; e.isConstruction = es.isConstruction; return e;
        }
        case "polyline": {
          const e = new PolylineEntity(es.points.map((p) => ({ ...p })), es.closed, es.id);
          e.selected = es.selected; e.isConstruction = es.isConstruction; return e;
        }
      }
    });
    this.constraints = s.constraints.map((c) => ({
      id: c.id, type: c.type,
      points: c.points.map((p) => ({ ...p })),
      entities: [...c.entities],
    }));
    this.dimensions = s.dimensions.map((d) => ({
      ...d,
      points: d.points.map((p) => ({ ...p })),
      entities: [...d.entities],
    }));
    this.isConstructionMode = s.isConstructionMode;
    this.selectedPoints = s.selectedPoints.map((p) => ({ ...p }));
    this.emitChange();
  }
}
