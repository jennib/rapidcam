/** The CAD document: canvas definition, geometry, constraints, dimensions. */

import type { Unit } from "../core/units";
import { type Vec2, dist } from "../core/vec2";

// --- origin types ------------------------------------------------------------

export type OriginX = "left" | "center" | "right";
export type OriginY = "front" | "center" | "back";
export type OriginZ = "top" | "bed";

/**
 * The kind of machine the document outputs for. Two independent axes of meaning,
 * which is why the union reads the way it does:
 *
 * - **Head** — "mill" is the 3-axis spindle path (Z plunge/retract); "laser" is a
 *   fixed-Z beam (on/off, power + passes, no Z). Other fixed-Z cutters (waterjet,
 *   plasma) would join as additional post-processors — see cam/laserposts/. Test
 *   this with {@link isLaser}, never `=== "laser"`, or the rotary laser silently
 *   falls into the mill branch.
 * - **Stock** — the "-rotary" kinds machine a *cylinder* rather than a flat blank:
 *   the canvas becomes its unrolled surface, locked to π·diameter, with the
 *   per-job cylinder in {@link RotarySettings} (`doc.rotary`). Test with
 *   {@link isRotary}.
 *
 * The two combine, so the head behaviour is unchanged by the stock: "mill-rotary"
 * behaves like "mill" everywhere except that export **wraps** the finished program
 * to A/B degrees (cam/klein.ts), and "laser-rotary" behaves like "laser"
 * everywhere *including* export — a laser rotary substitutes the wrapped axis on
 * its ordinary linear word instead of wrapping (see cam/klein.ts `rotaryOutput`).
 */
export type MachineKind = "mill" | "laser" | "mill-rotary" | "laser-rotary";

/** Every beam (fixed-Z, no-spindle) machine kind — flat or on the rotary. */
export function isLaser(kind: MachineKind): boolean {
  return kind === "laser" || kind === "laser-rotary";
}

/** Every machine kind whose stock is a cylinder and whose canvas is its unrolled surface. */
export function isRotary(kind: MachineKind): boolean {
  return kind === "mill-rotary" || kind === "laser-rotary";
}

/**
 * Every machine kind with its menu label, in picker order. The ONE list both
 * machine pickers (New Project and Machine Settings) build from, so a new kind
 * can't reach one dialog and miss the other.
 */
export const MACHINE_KINDS: readonly (readonly [MachineKind, string])[] = [
  ["mill", "CNC Mill / Router"],
  ["mill-rotary", "CNC Mill — Rotary / 4th axis"],
  ["laser", "Laser"],
  ["laser-rotary", "Laser — Rotary (cylinder)"],
] as const;

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
 * Double-sided machining setup. When present, operations carry a `face`
 * ("top" | "bottom", see {@link ../cam/types.CAMOperation}); the top ops are cut
 * as drawn, then the operator flips the stock and cuts the bottom ops from a
 * program whose geometry is mirrored about the flip axis so features align
 * through the part. Registration dowel holes bored at the end of the top-side
 * program let the flipped stock drop back into exact alignment.
 *
 * Mill-only. See cam/flip.ts for the generation logic.
 */
export interface FlipSettings {
  /**
   * The mirror the flip performs, matching {@link ../core/transform}'s helpers.
   * "h" = flip left ↔ right (mirror X about the stock's vertical centreline,
   * applyFlipH); "v" = flip near ↔ far (mirror Y about the horizontal
   * centreline, applyFlipV).
   */
  axis: "h" | "v";
  /**
   * How the flipped stock is realigned. "pins" bores dowel holes through the
   * stock into the spoilboard at the end of the top-side program; "none" leaves
   * it to the operator (e.g. a fixed fence/corner).
   */
  registration: "pins" | "none";
  /** Dowel-pin (hole) diameter in mm. */
  pinDiameter: number;
  /** How far past the stock bottom the pin holes bore into the spoilboard, mm. */
  pinDepth: number;
  /**
   * Registration hole centres, in world/canvas mm. For the flip to align, this
   * set must be invariant under the mirror (each pin has a mirror-image partner,
   * or sits on the flip-axis centreline). The default places two on the centreline.
   */
  pins: { x: number; y: number }[];
}

/** Rotary axis word letter. `A` rotates about machine X, `B` about machine Y. */
export type RotaryAxisWord = "A" | "B";

/**
 * Cylindrical / rotary parameters — the per-job cylinder for a rotary machine
 * (`mill-rotary` or `laser-rotary`). The *mode* is {@link MachineKind} (see
 * {@link isRotary});
 * these are the stock/wrap params it uses: one work axis stays linear (along the
 * cylinder length) and the perpendicular one is emitted as a rotary word in
 * degrees. Not compatible with `flip`. See cam/klein.ts for the generation logic
 * and the wrap math.
 */
export interface RotarySettings {
  /** Rotary axis word for the wrapped coordinate: `"A"` (about X) or `"B"` (about Y). */
  axisWord: RotaryAxisWord;
  /** Cylinder stock diameter in mm — 360° of rotation = π·diameter of surface travel. Must be > 0. */
  diameter: number;
  /** Which work axis rolls around the cylinder: `"y"` (default) or `"x"`; the other runs along the length. */
  wrapAxis: "x" | "y";
  /** Chord tolerance (mm) for flattening arcs into the wrap. Default 0.1. */
  arcTolerance?: number;
  /**
   * Where Z0 sits. `"surface"` (default): Z0 is the top of the cylinder surface —
   * the operator touches off on the stock top, cuts go negative. gSender only
   * visualizes this correctly with its "Visualize non-center zeros" toggle on
   * (helped by the "Cylinder Dia:" banner token). `"center"`: Z0 is the rotary
   * axis (cylinder centreline) — the native rotary convention gSender and most
   * controllers visualize with no extra toggle. Emitted Z is shifted up by the
   * radius (surface sits at Z = radius). Omitted = `"surface"` (back-compat).
   */
  zero?: "surface" | "center";
}

/**
 * Free-form job metadata carried with the document. All fields optional; only
 * non-empty fields are serialized and emitted in the G-code header. Purely
 * informational — affects no geometry or toolpaths.
 */
export interface DocMetadata {
  /** Job name / part number. */
  job?: string;
  /** Revision identifier (e.g. "A", "v2"). */
  revision?: string;
  /** Free-form notes. */
  notes?: string;
}

/**
 * The physical material being cut, as a first-class object. `box` is the flat
 * case (a rectangular blank); `cylinder` is the rotary case (a rod on the 4th
 * axis, whose unrolled surface is the canvas). In Phase 1 this is a DERIVED VIEW
 * over `canvas` + `stockThickness` (+ `rotary`) — see {@link CADDocument.stock} —
 * so persistence and G-code are unchanged. A later phase promotes it to the stored
 * source of truth (positioned within a work area, alongside fixtures). See the
 * `workholding-stock-workarea` design note.
 */
export type Stock =
  | { kind: "box"; width: number; height: number; thickness: number }
  | { kind: "cylinder"; length: number; diameter: number; wall: number };

/**
 * A flat stock blank positioned *within* the work area (`canvas`): lower-left at
 * (`x`,`y`), sized `width`×`height`, all in work-area mm. When a document has one
 * (`doc.stockRect`), the material is this rectangle rather than the whole canvas —
 * so the canvas can be larger (room for fixtures) and the WCS origin datums land
 * on the stock, not the work-area corner. `null` (the default/legacy) means the
 * stock fills the work area. Box/flat only; a rotary cylinder ignores it.
 */
export interface StockRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Resolve the named origin into concrete offsets used by G-code generation.
 * ox / oy: subtract from canvas coords to get G-code coords. When the stock is a
 * positioned {@link StockRect}, the datums are relative to the stock (its corner /
 * centre), so zeroing on the physical blank is correct even when it sits inside a
 * larger work area. zOffset: add to all Z (0 for top-of-stock, thickness for bed).
 */
export function resolveOrigin(doc: CADDocument): { ox: number; oy: number; zOffset: number } {
  const { width, height } = stockFootprint(doc);
  const sx = doc.stockRect?.x ?? 0;
  const sy = doc.stockRect?.y ?? 0;
  const s = doc.stock;
  const thickness = s.kind === "cylinder" ? s.wall : s.thickness;

  const ox = doc.origin.x === "left" ? sx : doc.origin.x === "right" ? sx + width : sx + width / 2;

  const oy =
    doc.origin.y === "front" ? sy : doc.origin.y === "back" ? sy + height : sy + height / 2;

  // A cylinder has no bed — the wrap is always surface-zeroed (Z0 on the stock
  // top; see cam/klein.ts). Ignore an errant `origin.z === "bed"` (from a saved
  // default, an old file, or a UI that offered it) so Z can't shift by the wall
  // and cut air, and so the rotary banner's "Z0 = top" claim always holds.
  const zOffset = s.kind === "cylinder" || doc.origin.z === "top" ? 0 : thickness;

  return { ox, oy, zOffset };
}

/**
 * The stock's extent in the XY work plane (mm) — the positioned {@link StockRect}
 * when present, else the whole canvas (legacy: stock fills the work area). A rotary
 * cylinder always uses the canvas (its unrolled surface). Read this, not
 * `doc.canvas`, in any code that means "how big is the material".
 */
export function stockFootprint(doc: CADDocument): { width: number; height: number } {
  const r = doc.stockRect;
  if (r && !isRotary(doc.machineKind)) return { width: r.width, height: r.height };
  return { width: doc.canvas.width, height: doc.canvas.height };
}
import {
  type Entity,
  type EntityId,
  type SnapPoint,
  type Bounds,
  LineEntity,
  CircleEntity,
  RectEntity,
  PolylineEntity,
  type PolygonParams,
  ArcEntity,
  BezierEntity,
  PointEntity,
  TextEntity,
  RasterImageEntity,
  type ImageConstraintFit,
  IMAGE_CONSTRAINT_FITS,
} from "./entities";
import type { CAMOperation, ToolDef } from "../cam/types";

export const ORIGIN_ENTITY_ID = "__origin__";
import {
  type Constraint,
  type PointRef,
  type SegmentRef,
  sameSegmentRef,
  samePointRef,
  constraintEntityIds,
  type Geo,
} from "./constraints";
import { type Dimension, dimensionHitDistance } from "./dimensions";
import type { Variable } from "./variables";
import type { ScalarBinding } from "./bindings";
import { type PatternDef, clonePatternDef } from "./patterns";
import { updateCounter, nextId } from "./ids";

export interface GroupDef {
  id: string;
  name: string;
  entityIds: EntityId[];
}

/**
 * A parametric feature: geometry that was produced by a generator (see
 * generators/) and remains re-editable. It records which generator ran and with
 * what parameters, plus the {@link GroupDef} holding its emitted entities, so the
 * feature can be regenerated in place when its parameters change (see
 * generators/index.ts `regenerateFeature`). Absent from files that use no
 * generators.
 */
export interface FeatureInstance {
  id: string;
  /** Generator id (a key of GENERATORS) that produced this feature. */
  generatorId: string;
  /** Parameter overrides the feature was generated with — the re-run inputs. */
  params: Record<string, number>;
  /** Id of the group holding this feature's entities. */
  groupId: string;
  /**
   * Translation applied to the generator's origin-based output to place it in the
   * work area (generators draw around (0,0); the runner centres the part on
   * insert). Persisted and re-applied on regenerate so editing a parameter
   * rebuilds the feature *where it sits*, not back at the origin. Absent = none.
   */
  offset?: { x: number; y: number };
  /**
   * Optional expression per param, evaluated against document variables (and
   * `stock`, the stock thickness — see model/variables.ts `varMap`). `params`
   * holds the last resolved values as cache/fallback: a param with no entry
   * here, or whose expression fails to evaluate, keeps its cached numeric.
   */
  paramExprs?: Record<string, string>;
  /**
   * Stable-key → entity-id map for entities the generator named via
   * `Sketch.key()`. Regeneration pairs keyed entities by KEY (falling back to
   * emit position for unkeyed ones), so references survive output reordering
   * and partial deletes. Entries whose entity is deleted are pruned.
   */
  keyIds?: Record<string, EntityId>;
}

export interface LayerDef {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  locked: boolean;
  /**
   * When true, closed shapes on this layer are **workholding** (clamps / fixtures),
   * not parts to cut: they aren't machined, and pre-flight flags any move that would
   * hit one. See cam/fixtures.ts. Default absent/false.
   */
  fixture?: boolean;
  /**
   * Fixture layers only: how far the clamp stands above the stock top, mm. A rapid
   * clears the clamp only above this height; any move over the footprint below it is
   * a collision. Absent = treat as full-height (blocks any pass) — set a real value
   * to allow rapids over short clamps.
   */
  fixtureHeight?: number;
}

type EntitySnapshot =
  | {
      type: "line";
      id: string;
      a: Vec2;
      b: Vec2;
      selected: boolean;
      isConstruction: boolean;
      layerId?: string;
    }
  | {
      type: "circle";
      id: string;
      center: Vec2;
      radius: number;
      selected: boolean;
      isConstruction: boolean;
      layerId?: string;
    }
  | {
      type: "rectangle";
      id: string;
      p0: Vec2;
      p1: Vec2;
      selected: boolean;
      isConstruction: boolean;
      layerId?: string;
    }
  | {
      type: "polyline";
      id: string;
      points: Vec2[];
      vertexIds?: string[];
      closed: boolean;
      polygon?: PolygonParams;
      selected: boolean;
      isConstruction: boolean;
      layerId?: string;
    }
  | {
      type: "arc";
      id: string;
      center: Vec2;
      radius: number;
      startAngle: number;
      endAngle: number;
      selected: boolean;
      isConstruction: boolean;
      layerId?: string;
    }
  | {
      type: "bezier";
      id: string;
      p0: Vec2;
      p1: Vec2;
      p2: Vec2;
      p3: Vec2;
      selected: boolean;
      isConstruction: boolean;
      layerId?: string;
    }
  | {
      type: "text";
      id: string;
      text: string;
      fontId: string;
      sizeMM: number;
      position: Vec2;
      angle: number;
      selected: boolean;
      isConstruction: boolean;
      layerId?: string;
    }
  // widthExpr/heightExpr/angleExpr are LEGACY (read-only): pre-unification image
  // formulas, migrated to scalar bindings on load and never written back out.
  | {
      type: "image";
      id: string;
      imageId: string;
      position: Vec2;
      widthMM: number;
      heightMM: number;
      angle: number;
      flipX?: boolean;
      flipY?: boolean;
      widthExpr?: string;
      heightExpr?: string;
      angleExpr?: string;
      aspectLocked?: boolean;
      /** Omitted for the "rigid" default — see {@link ImageConstraintFit}. */
      constraintFit?: ImageConstraintFit;
      selected: boolean;
      isConstruction: boolean;
      layerId?: string;
    };

export interface DocSnapshot {
  entities: EntitySnapshot[];
  constraints: Constraint[];
  dimensions: Dimension[];
  variables?: Variable[];
  bindings?: ScalarBinding[];
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
  stockRect?: StockRect | null;
  hasToolChanger?: boolean;
  origin?: OriginDef;
  postProcessor?: string;
  machineKind?: MachineKind;
  endPosition?: EndPosition | null;
  toolChangePosition?: EndPosition | null;
  flip?: FlipSettings | null;
  rotary?: RotarySettings | null;
  metadata?: DocMetadata;
  groups?: GroupDef[];
  features?: FeatureInstance[];
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
  /**
   * Optional positioned flat stock within the work area (`canvas`). `null` (the
   * default/legacy) = the stock fills the work area. When set, the material is this
   * rectangle: the canvas can be larger (room for fixtures) and the WCS origin is
   * relative to the stock. Ignored for a rotary cylinder. See {@link StockRect}.
   */
  stockRect: StockRect | null = null;
  /**
   * The material as a first-class {@link Stock} — a derived view. Size comes from
   * `stockRect` when set, else the whole `canvas`; thickness from `stockThickness`;
   * `cylinder` for a rotary rod (its unrolled surface is the canvas, so
   * diameter = wrapped-canvas-dimension / π). Read this — and {@link stockFootprint}
   * — instead of `canvas`/`stockThickness` in CAM, preview, and bounds code.
   */
  /** Whether this document outputs to a beam head — flat laser or laser-rotary.
   *  Prefer this over `machineKind === "laser"`; see {@link isLaser}. */
  get isLaser(): boolean {
    return isLaser(this.machineKind);
  }
  /** Whether the stock is a cylinder and the canvas its unrolled surface.
   *  Prefer this over `machineKind === "mill-rotary"`; see {@link isRotary}. */
  get isRotary(): boolean {
    return isRotary(this.machineKind);
  }
  get stock(): Stock {
    if (isRotary(this.machineKind)) {
      const wrapX = this.rotary?.wrapAxis === "x";
      const length = wrapX ? this.canvas.height : this.canvas.width;
      const circumference = wrapX ? this.canvas.width : this.canvas.height;
      return {
        kind: "cylinder",
        length,
        diameter: circumference / Math.PI,
        wall: this.stockThickness,
      };
    }
    const r = this.stockRect;
    return {
      kind: "box",
      width: r?.width ?? this.canvas.width,
      height: r?.height ?? this.canvas.height,
      thickness: this.stockThickness,
    };
  }
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
   * Which machine the document outputs for. Default "mill" (spindle + Z). When
   * "laser", export routes through the laser generator (beam on/off, no Z) and
   * the toolpath UI shows power/passes instead of spindle/depth. See
   * {@link MachineKind}.
   */
  machineKind: MachineKind = "mill";
  /**
   * Optional end-of-program park position (work coords, mm). When set, the
   * G-code rapids here at safe Z before M30; `null` leaves the tool where the
   * last toolpath ended. Defaults to off.
   */
  endPosition: EndPosition | null = null;
  /**
   * Optional park position (work coords, mm) the tool rapids to at safe Z before
   * a *manual* tool change, so the operator can reach the spindle. `null` leaves
   * the tool over the work. Ignored with an automatic tool changer and on lasers.
   */
  toolChangePosition: EndPosition | null = null;
  /**
   * Double-sided machining setup, or `null` (the default) for single-sided work.
   * When set, operations may carry a `face` and export produces a top-side and a
   * (mirrored) bottom-side program. See {@link FlipSettings} and cam/flip.ts.
   */
  flip: FlipSettings | null = null;
  /**
   * Per-job cylinder parameters for a rotary machine (see {@link MachineKind}),
   * or `null` when unset — in which case a rotary export falls back to
   * {@link RotarySettings} defaults derived from the stock. Ignored unless
   * {@link isRotary}. Not combinable with `flip`. See cam/klein.ts.
   */
  rotary: RotarySettings | null = null;
  /**
   * Optional job metadata (job name, revision, notes). Informational only —
   * serialized when non-empty and emitted in the G-code header. See
   * {@link DocMetadata}.
   */
  metadata: DocMetadata = {};

  entities: Entity[] = [];
  groups: GroupDef[] = [];
  features: FeatureInstance[] = [];
  patterns: PatternDef[] = [];
  layers: LayerDef[] = [
    { id: "layer-0", name: "Default", color: "#cdd2da", visible: true, locked: false },
  ];
  activeLayerId: string = "layer-0";
  constraints: Constraint[] = [];
  dimensions: Dimension[] = [];
  variables: Variable[] = [];
  /** Headless parametric bindings (formula → an entity's scalar DOF). */
  bindings: ScalarBinding[] = [];
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
  add<T extends Entity>(e: T): T {
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
  /**
   * Reset to an empty document. Clears *every* mutable field — geometry,
   * constraints, dimensions, variables/bindings, groups, patterns, layers, and
   * CAM state (operations, tools, job metadata) — so a New Project can't inherit
   * the previous drawing's toolpaths or variables. Document-level settings
   * (canvas/units/origin/machine) are reset to defaults here and then overwritten
   * by the caller's chosen values (see ProjectManager.openSetupDialog).
   *
   * NOTE: keep this in sync with the fields captured by {@link snapshot} — any
   * new persisted field must be reset here too, or it leaks across New Project.
   */
  clear(): void {
    this.entities = [new PointEntity({ x: 0, y: 0 }, ORIGIN_ENTITY_ID)];
    this.constraints = [];
    this.dimensions = [];
    this.variables = [];
    this.bindings = [];
    this.groups = [];
    this.features = [];
    this.patterns = [];
    this.layers = [
      { id: "layer-0", name: "Default", color: "#cdd2da", visible: true, locked: false },
    ];
    this.activeLayerId = "layer-0";
    this.operations = [];
    this.tools = [];
    this.endPosition = null;
    this.toolChangePosition = null;
    this.flip = null;
    this.metadata = {};
    this.isConstructionMode = false;
    this.selectedPoints = [];
    this.selectedSegments = [];
    this.selectedConstraintId = null;
    this.selectedDimensionId = null;
    // Transient dialog/highlight state must not survive a document swap.
    this.toolpathHighlightIds = null;
    this.toolpathHighlightColor = null;
    this.regionPickHandler = null;
    this.regionHoverHandler = null;
    this.regionPickFills = null;
    this.regionPickHoverFill = null;
    this.emitChange();
  }

  /** Drop constraints/dimensions/point-selections/patterns that reference removed entities. */
  private pruneReferences(): void {
    const ids = new Set(this.entities.map((e) => e.id));
    this.constraints = this.constraints.filter((c) =>
      constraintEntityIds(c).every((id) => ids.has(id)),
    );
    this.dimensions = this.dimensions.filter(
      (d) => d.entities.every((id) => ids.has(id)) && d.points.every((p) => ids.has(p.entityId)),
    );
    this.bindings = this.bindings.filter((b) => ids.has(b.entityId));
    this.selectedPoints = this.selectedPoints.filter((p) => ids.has(p.entityId));
    this.selectedSegments = this.selectedSegments.filter((s) => ids.has(s.entityId));
    if (
      this.selectedConstraintId &&
      !this.constraints.find((c) => c.id === this.selectedConstraintId)
    )
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
    // Trim groups to surviving members (replacing only the id array so a held
    // GroupDef reference — e.g. during a generator regeneration — stays live),
    // drop groups left empty, and drop generator features whose backing group
    // is gone: a feature whose geometry was entirely deleted must not linger
    // invisibly in the document and its saved files.
    for (const g of this.groups) g.entityIds = g.entityIds.filter((id) => ids.has(id));
    this.groups = this.groups.filter((g) => g.entityIds.length > 0);
    const groupIds = new Set(this.groups.map((g) => g.id));
    this.features = this.features.filter((f) => groupIds.has(f.groupId));
    // Drop key mappings to deleted entities so a regeneration re-creates the
    // keyed entity fresh instead of pairing with a dead id.
    for (const f of this.features) {
      if (!f.keyIds) continue;
      for (const k of Object.keys(f.keyIds)) {
        if (!ids.has(f.keyIds[k])) delete f.keyIds[k];
      }
    }
  }

  // --- patterns ------------------------------------------------------------
  addPattern<T extends PatternDef>(p: T): T {
    this.patterns.push(p);
    this.emitChange();
    return p;
  }
  removePattern(id: string): void {
    this.patterns = this.patterns.filter((p) => p.id !== id);
    this.emitChange();
  }
  updatePattern(
    id: string,
    patch: Partial<Pick<PatternDef, "instanceIds" | "params" | "sourceSnapshot">>,
  ): void {
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
      for (const key of [
        "countXExpr",
        "countYExpr",
        "spacingXExpr",
        "spacingYExpr",
        "countExpr",
      ] as const) {
        const e = p[key];
        if (typeof e === "string") p[key] = e.replace(re, newName);
      }
    }
    for (const b of this.bindings) b.expr = b.expr.replace(re, newName);
    for (const f of this.features) {
      if (!f.paramExprs) continue;
      for (const key of Object.keys(f.paramExprs)) {
        f.paramExprs[key] = f.paramExprs[key].replace(re, newName);
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
      if (this.dimensions[i].hidden) continue; // headless — nothing drawn to click
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
    let changed =
      this.selectedPoints.length > 0 ||
      this.selectedSegments.length > 0 ||
      this.selectedConstraintId !== null ||
      this.selectedDimensionId !== null;
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
      const layer = this.layers.find((l) => l.id === e.layerId) || this.layers[0];
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
      const layer = this.layers.find((l) => l.id === e.layerId) || this.layers[0];
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
      const layer = this.layers.find((l) => l.id === e.layerId) || this.layers[0];
      if (!layer.visible) continue; // snapping still works on locked layers, but not invisible ones
      out.push(...e.snapPoints());
    }
    return out;
  }

  /** Combined bounds of all geometry, or null when empty. */
  bounds(): Bounds | null {
    const drawable = this.entities.filter((e) => e.id !== ORIGIN_ENTITY_ID);
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
    return this.groups.find((g) => g.entityIds.includes(entityId)) ?? null;
  }

  // --- undo/redo snapshots --------------------------------------------------
  snapshot(): DocSnapshot {
    return {
      entities: this.entities
        .filter((e) => e.id !== ORIGIN_ENTITY_ID)
        .map((e): EntitySnapshot => {
          if (e instanceof LineEntity)
            return {
              type: "line",
              id: e.id,
              a: { ...e.a },
              b: { ...e.b },
              selected: e.selected,
              isConstruction: e.isConstruction,
              layerId: e.layerId,
            };
          if (e instanceof CircleEntity)
            return {
              type: "circle",
              id: e.id,
              center: { ...e.center },
              radius: e.radius,
              selected: e.selected,
              isConstruction: e.isConstruction,
              layerId: e.layerId,
            };
          if (e instanceof RectEntity)
            return {
              type: "rectangle",
              id: e.id,
              p0: { ...e.p0 },
              p1: { ...e.p1 },
              selected: e.selected,
              isConstruction: e.isConstruction,
              layerId: e.layerId,
            };
          if (e instanceof ArcEntity)
            return {
              type: "arc",
              id: e.id,
              center: { ...e.center },
              radius: e.radius,
              startAngle: e.startAngle,
              endAngle: e.endAngle,
              selected: e.selected,
              isConstruction: e.isConstruction,
              layerId: e.layerId,
            };
          if (e instanceof BezierEntity)
            return {
              type: "bezier",
              id: e.id,
              p0: { ...e.p0 },
              p1: { ...e.p1 },
              p2: { ...e.p2 },
              p3: { ...e.p3 },
              selected: e.selected,
              isConstruction: e.isConstruction,
              layerId: e.layerId,
            };
          if (e instanceof TextEntity)
            return {
              type: "text",
              id: e.id,
              text: e.text,
              fontId: e.fontId,
              sizeMM: e.sizeMM,
              position: { ...e.position },
              angle: e.angle,
              selected: e.selected,
              isConstruction: e.isConstruction,
              layerId: e.layerId,
            };
          if (e instanceof RasterImageEntity)
            return {
              type: "image",
              id: e.id,
              imageId: e.imageId,
              position: { ...e.position },
              widthMM: e.widthMM,
              heightMM: e.heightMM,
              angle: e.angle,
              flipX: e.flipX,
              flipY: e.flipY,
              aspectLocked: e.aspectLocked,
              ...(e.constraintFit !== "rigid" ? { constraintFit: e.constraintFit } : {}),
              selected: e.selected,
              isConstruction: e.isConstruction,
              layerId: e.layerId,
            };
          const pe = e as PolylineEntity;
          return {
            type: "polyline",
            id: pe.id,
            points: pe.points.map((p) => ({ ...p })),
            vertexIds: [...pe.vertexIds],
            closed: pe.closed,
            ...(pe.polygon ? { polygon: { ...pe.polygon, center: { ...pe.polygon.center } } } : {}),
            selected: pe.selected,
            isConstruction: pe.isConstruction,
            layerId: pe.layerId,
          };
        }),
      constraints: this.constraints.map((c) => ({
        id: c.id,
        type: c.type,
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
      bindings: this.bindings.map((b) => ({ ...b })),
      isConstructionMode: this.isConstructionMode,
      selectedPoints: this.selectedPoints.map((p) => ({ ...p })),
      selectedConstraintId: this.selectedConstraintId,
      selectedDimensionId: this.selectedDimensionId,
      canvas: { ...this.canvas },
      stockThickness: this.stockThickness,
      stockRect: this.stockRect ? { ...this.stockRect } : null,
      hasToolChanger: this.hasToolChanger,
      origin: { ...this.origin },
      postProcessor: this.postProcessor,
      machineKind: this.machineKind,
      endPosition: this.endPosition ? { ...this.endPosition } : null,
      toolChangePosition: this.toolChangePosition ? { ...this.toolChangePosition } : null,
      flip: this.flip ? { ...this.flip, pins: this.flip.pins.map((p) => ({ ...p })) } : null,
      rotary: this.rotary ? { ...this.rotary } : null,
      metadata: { ...this.metadata },
      groups: this.groups.map((g) => ({ id: g.id, name: g.name, entityIds: [...g.entityIds] })),
      features: this.features.map((f) => ({
        ...f,
        params: { ...f.params },
        ...(f.offset ? { offset: { ...f.offset } } : {}),
        ...(f.paramExprs ? { paramExprs: { ...f.paramExprs } } : {}),
        ...(f.keyIds ? { keyIds: { ...f.keyIds } } : {}),
      })),
      patterns: this.patterns.map(clonePatternDef),
      layers: this.layers.map((l) => ({ ...l })),
      activeLayerId: this.activeLayerId,
      operations: this.operations.map((op) => ({ ...op, entityIds: [...op.entityIds] })),
      tools: this.tools.map((t) => ({ ...t })),
    };
  }

  restore(s: DocSnapshot): void {
    this.layers = s.layers
      ? s.layers.map((l) => ({ ...l }))
      : [{ id: "layer-0", name: "Default", color: "#cdd2da", visible: true, locked: false }];
    this.activeLayerId = s.activeLayerId ?? "layer-0";

    // Legacy image direct-drive formulas (widthExpr/heightExpr/angleExpr) migrated
    // to scalar bindings during entity restore; merged into `bindings` below.
    const legacyImageBindings: ScalarBinding[] = [];
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
          const pl = new PolylineEntity(
            es.points.map((p) => ({ ...p })),
            es.closed,
            es.id,
            es.vertexIds,
          );
          if (es.polygon) pl.polygon = { ...es.polygon, center: { ...es.polygon.center } };
          e = pl;
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
        case "image": {
          e = new RasterImageEntity(
            es.imageId,
            { ...es.position },
            es.widthMM,
            es.heightMM,
            es.angle,
            es.flipX ?? false,
            es.flipY ?? false,
            es.id,
          );
          (e as RasterImageEntity).aspectLocked = es.aspectLocked ?? true;
          // Sanitised, not trusted: applyFile doesn't schema-validate, so a
          // hand-written/generated .rcam could carry any string here — and an
          // unknown fit would have no entry in the solver's free-scalar table.
          (e as RasterImageEntity).constraintFit = IMAGE_CONSTRAINT_FITS.includes(
            es.constraintFit as ImageConstraintFit,
          )
            ? (es.constraintFit as ImageConstraintFit)
            : "rigid";
          // Migrate legacy direct-drive image formulas (widthExpr/heightExpr/angleExpr,
          // pre-unification) to the general scalar-binding channel.
          const mig: [string | undefined, string, number][] = [
            [es.widthExpr, "w", 1],
            [es.heightExpr, "h", 1],
            [es.angleExpr, "angle", Math.PI / 180],
          ];
          for (const [expr, key, scale] of mig) {
            if (expr)
              legacyImageBindings.push({
                id: nextId("bind"),
                entityId: es.id,
                scalarKey: key,
                expr,
                ...(scale !== 1 ? { scale } : {}),
              });
          }
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
      const c = {
        id: cs.id,
        type: cs.type,
        points: (cs.points ?? []).map((p) => ({ ...p })),
        entities: [...(cs.entities ?? [])],
        params: cs.params ? [...cs.params] : undefined,
      } as Constraint;
      updateCounter(c.id);
      return c;
    });

    this.dimensions = (s.dimensions || []).map((ds) => {
      const d = {
        ...ds,
        points: (ds.points ?? []).map((p) => ({ ...p })),
        entities: [...(ds.entities ?? [])],
      } as Dimension;
      updateCounter(d.id);
      return d;
    });
    this.variables = (s.variables || []).map((v) => ({ ...v }));
    this.bindings = [...(s.bindings || []).map((b) => ({ ...b })), ...legacyImageBindings];

    this.isConstructionMode = s.isConstructionMode;
    this.selectedPoints = s.selectedPoints.map((p) => ({ ...p }));
    this.selectedConstraintId = s.selectedConstraintId ?? null;
    this.selectedDimensionId = s.selectedDimensionId ?? null;
    if (s.canvas) this.canvas = { ...s.canvas };
    if (s.stockThickness !== undefined) this.stockThickness = s.stockThickness;
    this.stockRect = s.stockRect ? { ...s.stockRect } : null;
    if (s.hasToolChanger !== undefined) this.hasToolChanger = s.hasToolChanger;
    if (s.origin) this.origin = { ...s.origin };
    if (s.postProcessor) this.postProcessor = s.postProcessor;
    this.machineKind = s.machineKind ?? "mill";
    this.endPosition = s.endPosition ? { x: s.endPosition.x, y: s.endPosition.y } : null;
    this.toolChangePosition = s.toolChangePosition
      ? { x: s.toolChangePosition.x, y: s.toolChangePosition.y }
      : null;
    this.flip = s.flip ? { ...s.flip, pins: (s.flip.pins ?? []).map((p) => ({ ...p })) } : null;
    this.rotary = s.rotary ? { ...s.rotary } : null;
    this.metadata = s.metadata ? { ...s.metadata } : {};
    this.groups = s.groups
      ? s.groups.map((g) => ({ id: g.id, name: g.name ?? "", entityIds: [...g.entityIds] }))
      : [];
    this.features = s.features
      ? s.features.map((f) => ({
          ...f,
          params: { ...f.params },
          ...(f.offset ? { offset: { ...f.offset } } : {}),
          ...(f.paramExprs ? { paramExprs: { ...f.paramExprs } } : {}),
        ...(f.keyIds ? { keyIds: { ...f.keyIds } } : {}),
        }))
      : [];
    for (const f of this.features) updateCounter(f.id);
    this.patterns = s.patterns ? s.patterns.map(clonePatternDef) : [];
    for (const p of this.patterns) updateCounter(p.id);
    this.operations = s.operations
      ? s.operations.map((op) => ({
          ...op,
          toolType: op.toolType ?? "end-mill",
          stepover: op.stepover ?? 0.4,
          entityIds: [...op.entityIds],
        }))
      : [];
    this.tools = s.tools ? s.tools.map((t) => ({ ...t })) : [];
    // Always ensure the WCS origin entity is present after loading.
    if (!this.entities.find((e) => e.id === ORIGIN_ENTITY_ID))
      this.entities.unshift(new PointEntity({ x: 0, y: 0 }, ORIGIN_ENTITY_ID));
    this.emitChange();
  }
}
