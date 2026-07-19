/**
 * Sketch — the builder vocabulary that first-party (and, later, user-authored)
 * generators draw against. It is a THIN, clean projection over the frozen entity
 * model (see model/entities.ts): coordinates are `{x,y}` document-mm, **angles
 * are degrees** (converted to the model's internal radians here, in one place),
 * and there are no `MM` field suffixes. Every factory returns a uniform
 * {@link Handle} exposing normalized points (`center`/`start`/`end`/`corners`/
 * `vertices`) so generators compose — e.g. `s.line(a.end, b.start)`.
 *
 * A Sketch is PURE: it holds no reference to the CADDocument and touches no
 * fonts, DOM, or image registry, so it is trivially unit-testable and safe to
 * run inside a Web Worker later. Committing what it produced onto a document is
 * a separate step (see generators/index.ts `runGenerator`).
 *
 * v1 scope is the eight self-contained entities plus `textToPath` (an injected
 * flattener). Live `text()`/`image()` — which need the embedded-font and
 * image registries — are intentionally deferred; see the module docstring in
 * generators/index.ts.
 */

import {
  ArcEntity,
  BezierEntity,
  CircleEntity,
  type Entity,
  LineEntity,
  PointEntity,
  PolylineEntity,
  RectEntity,
  TextEntity,
} from "../model/entities";
import { makeVariable, type Variable } from "../model/variables";
import type { Vec2 } from "../core/vec2";

export type Pt = { x: number; y: number };

const rad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * A generator's declared parameter — surfaced so a host can render an editing
 * panel and, on re-run with edited values, regenerate the feature. `value` is
 * the value actually used for this run (an override if the host supplied one,
 * else `def`).
 */
export interface ParamSpec {
  name: string;
  value: number;
  def: number;
  min?: number;
  max?: number;
  label?: string;
  /** Value must be an integer (e.g. a tooth or finger count). */
  int?: boolean;
  /** UI step hint for a numeric input; purely presentational, not enforced here. */
  step?: number;
}

/**
 * Uniform handle over an emitted entity. Points are derived from the live entity
 * on access, so a handle stays correct if the entity is mutated. Where a concept
 * doesn't apply (e.g. `corners()` on a line) it degrades to the bounding box.
 */
export interface Handle {
  readonly id: string;
  readonly entity: Entity;
  readonly center: Pt;
  readonly start: Pt;
  readonly end: Pt;
  corners(): Pt[];
  vertices(): Pt[];
}

function boundsCorners(e: Entity): Pt[] {
  const b = e.bounds();
  return [
    { x: b.min.x, y: b.min.y },
    { x: b.max.x, y: b.min.y },
    { x: b.max.x, y: b.max.y },
    { x: b.min.x, y: b.max.y },
  ];
}

function boundsCenter(e: Entity): Pt {
  const b = e.bounds();
  return { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 };
}

/** Build the normalized handle for an entity, mapping the per-type field names. */
function makeHandle(e: Entity): Handle {
  return {
    // Live getter, not a snapshot: regeneration may move a surviving entity's
    // id onto this entity (replaceInstanceEntity), and the handle must follow.
    get id(): string {
      return e.id;
    },
    entity: e,
    get center(): Pt {
      if (e instanceof CircleEntity || e instanceof ArcEntity) return { ...e.center };
      if (e instanceof RectEntity || e instanceof TextEntity) return e.getPoint("center");
      if (e instanceof LineEntity) return e.getPoint("mid");
      if (e instanceof PointEntity) return e.getPoint("p");
      return boundsCenter(e);
    },
    get start(): Pt {
      if (e instanceof LineEntity) return { ...e.a };
      if (e instanceof ArcEntity) return e.startPoint;
      if (e instanceof BezierEntity) return { ...e.p0 };
      if (e instanceof PolylineEntity && e.points.length) return { ...e.points[0] };
      return this.center;
    },
    get end(): Pt {
      if (e instanceof LineEntity) return { ...e.b };
      if (e instanceof ArcEntity) return e.endPoint;
      if (e instanceof BezierEntity) return { ...e.p3 };
      if (e instanceof PolylineEntity && e.points.length)
        return { ...e.points[e.points.length - 1] };
      return this.center;
    },
    corners(): Pt[] {
      if (e instanceof RectEntity) return e.corners();
      return boundsCorners(e);
    },
    vertices(): Pt[] {
      if (e instanceof PolylineEntity) return e.points.map((p) => ({ ...p }));
      return [];
    },
  };
}

/**
 * Injected text-outline flattener for {@link Sketch.textToPath}. Kept out of the
 * pure Sketch so fonts never leak into this module; a host that wants live text
 * conversion passes one (backed by cam/textOutlines.ts). Returns one or more
 * closed contours (glyph outlines) in document mm.
 */
export type TextFlattener = (opts: {
  text: string;
  font: string;
  size: number;
  at: Pt;
  angleDeg: number;
}) => Vec2[][];

/** Where an entity wants to live: a named layer (created on commit if absent). */
export interface LayerHint {
  name: string;
  /** CSS hex colour for the layer if it has to be created. */
  color?: string;
}

/**
 * A CAM operation the generator recommends for some of its output — the piece
 * of intent a layer name alone can't carry (the box generator KNOWS its grooves
 * are pockets at half the material thickness). Recorded here in machine-neutral
 * terms; generators/suggestOps.ts turns suggestions into real `CAMOperation`s
 * at insert time, applying the document's machine kind and tool/feed defaults.
 * Suggestions are advisory: the host may skip them, and once created the ops
 * belong to the user (regeneration never re-creates them).
 */
export interface OpSuggestion {
  /** Operation display name, e.g. "Box panels — Profile (outside)". */
  name: string;
  kind: "profile-outside" | "profile-inside" | "pocket" | "engrave";
  /** Handles of the entities the op should cut (their ids are read at commit). */
  targets: Handle[];
  /** Cut depth: mm below the surface (negative), or "through" = full stock thickness. */
  depth: number | "through";
  /** Dog-bone/T-bone corner relief (profile + pocket only; see cam/dogbone.ts). */
  cornerStyle?: "dogbone" | "tbone";
  /** Per-pass stepdown override (mm); omitted = host default. */
  stepdown?: number;
  /** Tool-diameter override (mm), e.g. clamped small for a narrow bore. */
  toolDiameter?: number;
  /**
   * Set false to opt out of the automatic hold-down tabs a through outside
   * profile gets by default (e.g. a vacuum-table generator).
   */
  tabs?: false;
}

export class Sketch {
  /** Entities emitted so far, in draw order. */
  readonly entities: Entity[] = [];
  /** Layer hint per entity, parallel to {@link entities} (undefined = default layer). */
  readonly entityLayers: (LayerHint | undefined)[] = [];
  /** Variables the generator declared (added to the document on commit). */
  readonly variables: Variable[] = [];
  /** Parameters the generator declared, in declaration order. */
  readonly params: ParamSpec[] = [];
  /**
   * Advisory messages surfaced for the CURRENT parameter values (e.g. an
   * undercut warning at a low tooth count). A generator calls {@link note}
   * while building; since `build()` re-runs on every probe, notes are
   * re-collected fresh each time — a host re-probing on input changes gets
   * live-updating notes. Not persisted with the feature.
   */
  readonly notes: string[] = [];
  /** CAM operations the generator recommends for its output (see {@link OpSuggestion}). */
  readonly opSuggestions: OpSuggestion[] = [];
  /** Stable key per entity, parallel to {@link entities} (undefined = unkeyed; see {@link key}). */
  readonly entityKeys: (string | undefined)[] = [];

  private readonly overrides: Map<string, number>;
  private readonly flatten?: TextFlattener;
  private curLayer?: LayerHint;
  private pendingKey?: string;

  constructor(opts: { params?: Record<string, number>; flatten?: TextFlattener } = {}) {
    this.overrides = new Map(Object.entries(opts.params ?? {}));
    this.flatten = opts.flatten;
  }

  /**
   * Route subsequently-emitted geometry onto a named layer (created on commit if
   * it doesn't exist), e.g. to separate pocket geometry from profile cuts. Call
   * with no name to return to the default (active) layer.
   */
  layer(name?: string, color?: string): void {
    this.curLayer = name ? { name, color } : undefined;
  }

  /**
   * Declare a numeric parameter and return the value to use. If the host supplied
   * an override for `name`, that is used (and clamped to [min,max] when given);
   * otherwise `def`. This is the hook that makes a generator a re-runnable
   * feature: the host reads {@link params} to build an editor and re-runs with
   * new overrides.
   *
   * When `int` is set, rounding happens BEFORE clamping — an override can round
   * to just outside [min,max] (e.g. 100.4 rounds to 100, past a max of 12), and
   * the clamp must have the final say so the declared range is never violated.
   * The recorded `ParamSpec.value` (and the returned value) is the post-round,
   * post-clamp value — exactly what the generator actually built with.
   */
  param(
    name: string,
    def: number,
    opts: { min?: number; max?: number; label?: string; int?: boolean; step?: number } = {},
  ): number {
    let value = this.overrides.has(name) ? this.overrides.get(name)! : def;
    if (opts.int) value = Math.round(value);
    if (opts.min !== undefined) value = Math.max(opts.min, value);
    if (opts.max !== undefined) value = Math.min(opts.max, value);
    this.params.push({
      name,
      value,
      def,
      min: opts.min,
      max: opts.max,
      label: opts.label,
      int: opts.int,
      step: opts.step,
    });
    return value;
  }

  /**
   * Surface an advisory message for the current parameter values (e.g. "below
   * ~17 teeth the involute flanks are undercut"). See {@link notes}.
   */
  note(text: string): void {
    this.notes.push(text);
  }

  /** Declare a document variable (e.g. exposing a driving dimension by name). */
  variable(name: string, expr: string): void {
    this.variables.push(makeVariable(name, expr, "mm"));
  }

  /** Recommend a CAM operation for part of this sketch's output (see {@link OpSuggestion}). */
  suggestOp(spec: OpSuggestion): void {
    this.opSuggestions.push(spec);
  }

  /**
   * Give the NEXT emitted entity a stable identity key (`s.key("front-wall");
   * s.polyline(...)`). Across regenerations, a keyed entity keeps its document
   * id by KEY rather than by emit position — so CAM ops/constraints/dims stay
   * attached to the same logical part even when the output order shifts or an
   * entity was deleted mid-sequence. One-shot (a key names exactly one entity),
   * unlike the modal {@link layer}. Reusing a key within one build throws, so a
   * generator bug surfaces at probe time in the dialog.
   */
  key(k: string): void {
    if (this.entityKeys.includes(k)) throw new Error(`Sketch.key: duplicate key "${k}"`);
    if (this.pendingKey !== undefined) {
      throw new Error(`Sketch.key: "${this.pendingKey}" was never consumed by an entity`);
    }
    this.pendingKey = k;
  }

  // --- self-contained geometry (v1 core) ---------------------------------

  line(a: Pt, b: Pt): Handle {
    return this.push(new LineEntity(a, b));
  }
  circle(center: Pt, radius: number): Handle {
    return this.push(new CircleEntity(center, radius));
  }
  /** Axis-aligned rectangle from a corner and a size (emits one RectEntity). */
  rect(corner: Pt, size: { w: number; h: number }): Handle {
    return this.push(new RectEntity(corner, { x: corner.x + size.w, y: corner.y + size.h }));
  }
  polyline(points: Pt[], opts: { closed?: boolean } = {}): Handle {
    return this.push(new PolylineEntity(points, opts.closed ?? false));
  }
  /** Regular polygon as a closed polyline, keeping its polygon params editable. */
  polygon(o: { sides: number; center: Pt; radius: number; rotationDeg?: number }): Handle {
    const rot = rad(o.rotationDeg ?? 0);
    const pts: Pt[] = [];
    for (let i = 0; i < o.sides; i++) {
      const a = rot + (i * 2 * Math.PI) / o.sides;
      pts.push({ x: o.center.x + o.radius * Math.cos(a), y: o.center.y + o.radius * Math.sin(a) });
    }
    const e = new PolylineEntity(pts, true);
    e.polygon = { sides: o.sides, center: { ...o.center }, radius: o.radius, rotation: rot };
    return this.push(e);
  }
  arc(center: Pt, radius: number, startDeg: number, endDeg: number): Handle {
    return this.push(new ArcEntity(center, radius, rad(startDeg), rad(endDeg)));
  }
  bezier(p0: Pt, p1: Pt, p2: Pt, p3: Pt): Handle {
    return this.push(new BezierEntity(p0, p1, p2, p3));
  }
  point(at: Pt): Handle {
    return this.push(new PointEntity(at));
  }

  /**
   * Flatten a string to path geometry (the escape hatch that keeps generators in
   * resource-free geometry). Requires a {@link TextFlattener} to have been passed
   * to the constructor; throws otherwise so the missing dependency is explicit.
   */
  textToPath(text: string, o: { font: string; size: number; at: Pt; angleDeg?: number }): Handle[] {
    if (!this.flatten) {
      throw new Error("Sketch.textToPath requires a flatten() function (none was provided)");
    }
    const contours = this.flatten({
      text,
      font: o.font,
      size: o.size,
      at: o.at,
      angleDeg: o.angleDeg ?? 0,
    });
    return contours.map((c) => this.push(new PolylineEntity(c, true)));
  }

  private push<T extends Entity>(e: T): Handle {
    this.entities.push(e);
    this.entityLayers.push(this.curLayer);
    this.entityKeys.push(this.pendingKey);
    this.pendingKey = undefined;
    return makeHandle(e);
  }
}
