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
    id: e.id,
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

export class Sketch {
  /** Entities emitted so far, in draw order. */
  readonly entities: Entity[] = [];
  /** Layer hint per entity, parallel to {@link entities} (undefined = default layer). */
  readonly entityLayers: (LayerHint | undefined)[] = [];
  /** Variables the generator declared (added to the document on commit). */
  readonly variables: Variable[] = [];
  /** Parameters the generator declared, in declaration order. */
  readonly params: ParamSpec[] = [];

  private readonly overrides: Map<string, number>;
  private readonly flatten?: TextFlattener;
  private curLayer?: LayerHint;

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
   */
  param(name: string, def: number, opts: { min?: number; max?: number; label?: string } = {}): number {
    let value = this.overrides.has(name) ? this.overrides.get(name)! : def;
    if (opts.min !== undefined) value = Math.max(opts.min, value);
    if (opts.max !== undefined) value = Math.min(opts.max, value);
    this.params.push({ name, value, def, min: opts.min, max: opts.max, label: opts.label });
    return value;
  }

  /** Declare a document variable (e.g. exposing a driving dimension by name). */
  variable(name: string, expr: string): void {
    this.variables.push(makeVariable(name, expr, "mm"));
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
  textToPath(
    text: string,
    o: { font: string; size: number; at: Pt; angleDeg?: number },
  ): Handle[] {
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
    return makeHandle(e);
  }
}
