/** The CAD document: canvas definition, geometry, constraints, dimensions. */

import type { Unit } from "../core/units";
import { type Vec2, dist, mid } from "../core/vec2";

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

/**
 * The blank's rectangle in work coordinates — {@link stockFootprint} plus where
 * it actually sits.
 *
 * Anything PHYSICAL measures from here, never from `doc.canvas`: you turn a
 * workpiece over about its own centreline, a registration pin is bored through
 * the blank, and a clamp grips a material edge. Passing `doc.canvas` used to
 * look correct only because New Project centres the blank on its sheet, which
 * makes the two centrelines the same point — so a hole 20mm from the blank's
 * left edge came back 20mm from its right edge by coincidence. Offset the blank
 * and the same code puts it 80mm off the material entirely.
 */
export function stockBox(doc: CADDocument): StockRect {
  const { width, height } = stockFootprint(doc);
  return { x: doc.stockRect?.x ?? 0, y: doc.stockRect?.y ?? 0, width, height };
}

/** Room left around the stock when the sheet is generated for you, mm per side. */
export const SHEET_MARGIN = 50;

/**
 * The sheet size implied by the stock (and the machine, when it is known).
 *
 * The stock is what the user typed and is never derived from anything — the
 * dependency runs one way only. The sheet is the frame you draw in, so it is
 * generated:
 *
 * - **A bed is configured** → the sheet IS the bed. You are drawing on a
 *   representation of your actual table, and the stock sits somewhere on it.
 * - **No bed** → the stock plus {@link SHEET_MARGIN} on every side. The margin
 *   exists because clamps overhang the stock edge: hold-downs are drawn as
 *   geometry on a fixture layer, so there has to be sheet outside the blank to
 *   draw them on.
 *
 * Returns null for a ROTARY document, which has no derivable sheet: its canvas
 * is the unrolled cylinder surface and its wrapped dimension is already locked to
 * the circumference (π·⌀), which is itself derived from the stock. Rotary already
 * worked this way; callers must leave it alone.
 */
export function deriveSheet(
  doc: CADDocument,
  bed?: { width: number; height: number } | null,
): { width: number; height: number } | null {
  if (isRotary(doc.machineKind)) return null;
  if (bed && bed.width > 0 && bed.height > 0) return { width: bed.width, height: bed.height };
  const { width, height } = stockFootprint(doc);
  return { width: width + SHEET_MARGIN * 2, height: height + SHEET_MARGIN * 2 };
}

/**
 * The document state the built-in parametric keywords resolve against — see
 * {@link ../model/variables.StockContext} and
 * {@link ../model/variables.builtinKeywords}. Built here (not in variables.ts) so
 * the keyword layer stays a plain-data consumer and never imports the document,
 * keeping the model import graph acyclic.
 */
export function builtinContext(doc: CADDocument): StockContext {
  const { ox, oy, zOffset } = resolveOrigin(doc);
  const base = {
    stockThickness: doc.stockThickness,
    sheetWidth: isRotary(doc.machineKind) ? null : doc.canvas.width,
    sheetHeight: isRotary(doc.machineKind) ? null : doc.canvas.height,
    originX: ox,
    originY: oy,
    originZ: zOffset,
    counter: doc.counter,
  };
  if (isRotary(doc.machineKind)) {
    const s = doc.stock as { kind: "cylinder"; length: number; diameter: number; wall: number };
    return {
      ...base,
      stockWidth: null,
      stockHeight: null,
      diameter: s.diameter,
      length: s.length,
      circumference: Math.PI * s.diameter,
      wall: s.wall,
    };
  }
  const s = doc.stock as { kind: "box"; width: number; height: number; thickness: number };
  return {
    ...base,
    stockWidth: s.width,
    stockHeight: s.height,
    diameter: null,
    length: null,
    circumference: null,
    wall: null,
  };
}
import {
  Entity,
  type EntityId,
  type SnapPoint,
  type Bounds,
  LineEntity,
  CircleEntity,
  RectEntity,
  type CornerType,
  CORNER_TYPES,
  PolylineEntity,
  type PolygonParams,
  ArcEntity,
  BezierEntity,
  PointEntity,
  TextEntity,
  RasterImageEntity,
} from "./entities";
import type { CAMOperation, LaserRecipe, ToolDef } from "../cam/types";

export const ORIGIN_ENTITY_ID = "__origin__";

/**
 * Sentinel `PointRef.entityId` for the stock rectangle's corners/edge-midpoints —
 * lets a dimension anchor to the material the same way it already anchors to the
 * WCS origin. Deliberately NOT a real entry in `doc.entities` the way
 * {@link ORIGIN_ENTITY_ID} is: origin's approach needs matching exclusions
 * everywhere geometry is iterated (CAM export, DXF export, `bounds()`, snapshot/
 * restore, machinability checks, …) and still cost three separate bugs in one
 * feature (see the "origin-entity-trap" note). A stock ref is resolved on demand
 * by {@link stockRefEntity} purely to satisfy `Geo` lookups, so none of that
 * exclusion machinery is needed, and — since it's never in `doc.entities` — the
 * solver can never mistake it for a free variable either.
 */
export const STOCK_ENTITY_ID = "__stock__";

const STOCK_POINT_KEYS = ["bl", "br", "tr", "tl", "mid_b", "mid_r", "mid_t", "mid_l"] as const;
export type StockPointKey = (typeof STOCK_POINT_KEYS)[number];

/**
 * The stock's four edges, in the canonical winding bl -> br -> tr -> tl.
 *
 * ONE statement of that order. It was previously restated in
 * `dimensionTool.pickStockEdge` (as mid_b/mid_r/mid_t/mid_l) and in
 * `offsetTool` (as bottom/right/top/left), and it also has to agree with
 * `RECT_EDGE_CORNERS` in entities.ts — three copies of a fact that, if one were
 * reordered, would silently attach constraints and dimensions to the WRONG edge.
 *
 * Both spellings are kept because both are already written into saved files:
 * `mid` is what a dimension anchors to, `name` is what an offset-inherited
 * `pointOnLine` references. `edgeEndsOf` resolves either.
 */
export const STOCK_EDGES = [
  { corners: ["bl", "br"], mid: "mid_b", name: "bottom" },
  { corners: ["br", "tr"], mid: "mid_r", name: "right" },
  { corners: ["tr", "tl"], mid: "mid_t", name: "top" },
  { corners: ["tl", "bl"], mid: "mid_l", name: "left" },
] as const;

export interface StockEdgeSeg {
  edge: (typeof STOCK_EDGES)[number];
  a: Vec2;
  b: Vec2;
}

/**
 * The stock's four edges as world segments, or null when there is no flat stock
 * (a rotary document's canvas is the unrolled cylinder, not a rectangle).
 * Resolves through {@link stockRefPoint}, so "stock fills the sheet" works too.
 */
export function stockEdgeSegments(doc: CADDocument): StockEdgeSeg[] | null {
  const out: StockEdgeSeg[] = [];
  for (const edge of STOCK_EDGES) {
    const a = stockRefPoint(doc, edge.corners[0]);
    const b = stockRefPoint(doc, edge.corners[1]);
    if (!a || !b) return null;
    out.push({ edge, a, b });
  }
  return out;
}

/**
 * The stock rectangle's corner/edge-midpoint in world mm, or null when there's no
 * flat stock to dimension from (a rotary document's canvas is the unrolled
 * cylinder surface, not a rectangle) or `key` isn't one of the 8 recognised
 * points. Same corner/midpoint vocabulary as `RectEntity`
 * (bl/br/tr/tl, mid_b/mid_r/mid_t/mid_l) so it plugs into the same dimension code.
 */
export function stockRefPoint(doc: CADDocument, key: string): Vec2 | null {
  if (isRotary(doc.machineKind)) return null;
  const { width, height } = stockFootprint(doc);
  const sx = doc.stockRect?.x ?? 0;
  const sy = doc.stockRect?.y ?? 0;
  const bl = { x: sx, y: sy };
  const br = { x: sx + width, y: sy };
  const tr = { x: sx + width, y: sy + height };
  const tl = { x: sx, y: sy + height };
  switch (key as StockPointKey) {
    case "bl":
      return bl;
    case "br":
      return br;
    case "tr":
      return tr;
    case "tl":
      return tl;
    case "mid_b":
      return mid(bl, br);
    case "mid_r":
      return mid(br, tr);
    case "mid_t":
      return mid(tr, tl);
    case "mid_l":
      return mid(tl, bl);
    default:
      return null;
  }
}

/** All 8 stock corner/edge-midpoint snap points, or `[]` for a rotary document. */
export function stockSnapPoints(doc: CADDocument): SnapPoint[] {
  const out: SnapPoint[] = [];
  for (const key of STOCK_POINT_KEYS) {
    const pos = stockRefPoint(doc, key);
    if (!pos) continue;
    out.push({
      pos,
      kind: key.startsWith("mid") ? "midpoint" : "endpoint",
      entityId: STOCK_ENTITY_ID,
      key,
    });
  }
  return out;
}

/**
 * Fixed reference entity resolving the stock rectangle's corners/edge-midpoints —
 * exists only to answer `Geo` lookups (dimension measurement/rendering/solving);
 * never added to `doc.entities` (see {@link STOCK_ENTITY_ID}). `translate` is a
 * no-op: dimensions anchor TO the stock, the stock never moves in response.
 */
class StockRefEntity extends Entity {
  readonly type = "point" as const;
  constructor(private doc: CADDocument) {
    super(STOCK_ENTITY_ID);
  }
  bounds(): Bounds {
    const p = stockRefPoint(this.doc, "bl") ?? { x: 0, y: 0 };
    return { min: p, max: p };
  }
  distanceTo(): number {
    return Infinity; // never hit-tested as a body
  }
  snapPoints(): SnapPoint[] {
    return stockSnapPoints(this.doc);
  }
  translate(): void {}
  duplicate(): Entity {
    return new StockRefEntity(this.doc);
  }
  override getPoint(key: string): Vec2 {
    const p = stockRefPoint(this.doc, key);
    if (!p) throw new Error(`stock ref has no point '${key}'`);
    return p;
  }
}

/** The one place a `Geo` lookup should resolve {@link STOCK_ENTITY_ID} from. */
export function stockRefEntity(doc: CADDocument): Entity {
  return new StockRefEntity(doc);
}
import {
  type Constraint,
  type PointRef,
  type SegmentRef,
  sameSegmentRef,
  samePointRef,
  constraintEntityIds,
  type ConstraintType,
  lineRefEntityId,
  type Geo,
} from "./constraints";
import { type Dimension, dimensionHitDistance } from "./dimensions";
import type { Variable, StockContext } from "./variables";
import type { ScalarBinding } from "./bindings";
import { type PatternDef, clonePatternDef } from "./patterns";
import { updateCounter, nextId } from "./ids";

/** Constraint types that tie one entity's POSITION to another's — see carriedBy. */
const POSITION_COUPLING = new Set<ConstraintType>([
  "coincident",
  "pointOnLine",
  "pointOnArc",
  "pointOnCircle",
  "concentric",
  "midpoint",
  "symmetric",
  "collinear",
  "tangent",
  "center",
]);

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
  /**
   * Laser documents only: beam power/speed/passes for everything on this layer —
   * the colour-driven workflow (cut on black, score on red). Operations whose
   * geometry all sits here take these numbers at toolpath time unless they have
   * forked; see cam/types.ts `LaserRecipe` and `resolveOpLaser`. Absent = each
   * operation keeps its own settings, which is how every pre-recipe file behaves.
   */
  laser?: LaserRecipe;
}

/**
 * Copy a layer for snapshot/restore. The beam recipe is a nested object, so a
 * bare spread would let an undo snapshot and the live layer share it — editing
 * a power in place would silently rewrite history.
 */
function cloneLayer(l: LayerDef): LayerDef {
  return { ...l, ...(l.laser ? { laser: { ...l.laser } } : {}) };
}

/** Id of the layer every entity falls back to when it names none. */
export const DEFAULT_LAYER_ID = "layer-0";

/**
 * The layer a document has when nobody has made one. A factory, not a shared
 * constant, so the caller owns its copy — and one definition rather than the
 * three literals this used to be spelled as (fresh doc, `clear()`, `restore()`).
 */
export function defaultLayer(): LayerDef {
  return { id: DEFAULT_LAYER_ID, name: "Default", color: "#cdd2da", visible: true, locked: false };
}

/**
 * Fields every entity snapshot carries whatever its geometry. Factored out so a
 * new one can't be added to seven of the eight shapes and silently dropped from
 * the eighth. Mirrored by the published schema — see public/schema/rcam-v3.schema.json.
 */
interface EntitySnapshotCommon {
  id: string;
  selected: boolean;
  isConstruction: boolean;
  layerId?: string;
  /** Design-tree custom name. Absent = derive a description from the geometry. */
  name?: string;
  /** Omitted when visible (the default); only a hidden entity writes `false`. */
  visible?: boolean;
  /** Omitted when unlocked (the default); only a locked entity writes `true`. */
  locked?: boolean;
  /**
   * Workholding only: this clamp's own height above the stock top (mm).
   * Omitted = inherit the fixture layer's `fixtureHeight` (see Entity).
   */
  fixtureHeight?: number;
}

type EntitySnapshot = EntitySnapshotCommon &
  (
    | { type: "line"; a: Vec2; b: Vec2 }
    | { type: "circle"; center: Vec2; radius: number }
    // cornerRadii/cornerType are written only when a corner is actually shaped,
    // so a plain rectangle — every rectangle in every existing file — serialises
    // byte-for-byte as it always did.
    | { type: "rectangle"; p0: Vec2; p1: Vec2; cornerRadii?: number[]; cornerType?: CornerType }
    // cornerRadii is keyed by VERTEX ID, not by position — the same addressing
    // constraints and dimensions use — and like a rectangle's it is written only
    // when a corner is actually shaped, so every existing polyline serialises
    // byte-for-byte as it always did.
    | {
        type: "polyline";
        points: Vec2[];
        vertexIds?: string[];
        closed: boolean;
        polygon?: PolygonParams;
        cornerRadii?: Record<string, number>;
        cornerType?: CornerType;
      }
    | { type: "arc"; center: Vec2; radius: number; startAngle: number; endAngle: number }
    | { type: "bezier"; p0: Vec2; p1: Vec2; p2: Vec2; p3: Vec2 }
    | {
        type: "text";
        text: string;
        fontId: string;
        sizeMM: number;
        position: Vec2;
        angle: number;
      }
    // widthExpr/heightExpr/angleExpr are LEGACY (read-only): pre-unification image
    // formulas, migrated to scalar bindings on load and never written back out.
    | {
        type: "image";
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
        /** Both omitted when false (the rigid default) — see RasterImageEntity. */
        constraintResize?: boolean;
        constraintRotate?: boolean;
      }
  );

/**
 * The geometry-independent half of an entity snapshot. `name`, `visible` and
 * `locked` are written only when they differ from the default, so a document
 * that never touched the design tree serialises byte-for-byte as it did before
 * those fields existed.
 */
function entityCommon(e: Entity): EntitySnapshotCommon {
  return {
    id: e.id,
    selected: e.selected,
    isConstruction: e.isConstruction,
    layerId: e.layerId,
    ...(e.name ? { name: e.name } : {}),
    ...(e.visible ? {} : { visible: false }),
    ...(e.locked ? { locked: true } : {}),
    ...(e.fixtureHeight !== undefined ? { fixtureHeight: e.fixtureHeight } : {}),
  };
}

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
  /** Incrementing serial counter. Default 1 when absent (older files). */
  counter?: number;
  stockRect?: StockRect | null;
  origin?: OriginDef;
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
   * Incrementing serial counter (the `counter`/`serial`/`seq` built-in keywords).
   * A user-facing serial number: bumped by the Settings "+1" button, serialized in
   * `.rcam` projects and undo snapshots. Default 1.
   */
  counter = 1;
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
  /**
   * Work-coordinate-system origin expressed as named positions.
   * Default = front-left-top (the most common CNC router convention).
   */
  origin: OriginDef = { x: "left", y: "front", z: "top" };
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
  layers: LayerDef[] = [defaultLayer()];
  activeLayerId: string = DEFAULT_LAYER_ID;
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
    if (e.layerId === DEFAULT_LAYER_ID && this.activeLayerId !== DEFAULT_LAYER_ID) {
      e.layerId = this.activeLayerId;
    }
    if (this.isConstructionMode && !e.isConstruction) {
      e.isConstruction = true;
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
    if (e.layerId === DEFAULT_LAYER_ID && this.activeLayerId !== DEFAULT_LAYER_ID) {
      e.layerId = this.activeLayerId;
    }
    if (this.isConstructionMode && !e.isConstruction) {
      e.isConstruction = true;
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
  /**
   * Delete the selection. Locked entities survive — locking has to mean
   * something once the design tree can put one in the selection that the canvas
   * would never have let you click.
   */
  removeSelected(): void {
    const before = this.entities.length;
    this.entities = this.entities.filter(
      (e) => !e.selected || e.locked || e.id === ORIGIN_ENTITY_ID,
    );
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
    this.layers = [defaultLayer()];
    this.activeLayerId = DEFAULT_LAYER_ID;
    this.operations = [];
    this.tools = [];
    this.endPosition = null;
    this.toolChangePosition = null;
    this.flip = null;
    this.metadata = {};
    this.counter = 1;
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
    // STOCK_ENTITY_ID is never in `this.entities` (see its doc comment) — it's
    // resolved on demand, not removable, so a dimension anchored to it is never
    // "orphaned". Without this, deleting ANY unrelated entity would silently
    // drop every stock-anchored dimension the next time this runs.
    // Applied to EVERY reference, not just a dimension's points. The exemption
    // used to cover `d.points` alone, so a constraint or dimension anchored to a
    // stock EDGE (`__stock__#mid_b`, which arrives here in `entities`) was
    // silently destroyed the next time any unrelated entity was deleted —
    // exactly the failure this guard was written to prevent, missed on the two
    // paths that carry an edge reference. `lineRefEntityId` strips the `#edge`
    // suffix so the check asks about the entity, not the edge.
    const stillExists = (ref: EntityId) => {
      const id = lineRefEntityId(ref);
      return id === STOCK_ENTITY_ID || ids.has(id);
    };
    this.constraints = this.constraints.filter((c) =>
      constraintEntityIds(c).every(stillExists),
    );
    this.dimensions = this.dimensions.filter(
      (d) => d.entities.every(stillExists) && d.points.every((p) => stillExists(p.entityId)),
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
    updateCounter(v.id);
    this.variables.push(v);
    this.emitChange();
    return v;
  }
  removeVariable(id: string): void {
    const before = this.variables.length;
    this.variables = this.variables.filter((v) => v.id !== id);
    if (this.variables.length !== before) this.emitChange();
  }
  /** Find human-readable descriptions of everywhere `varName` is currently used. */
  variableUsages(varName: string): string[] {
    const usages: string[] = [];
    const re = new RegExp(`\\b${varName}\\b`);

    for (const d of this.dimensions) {
      if (d.expr && re.test(d.expr)) {
        usages.push(`Dimension (${d.expr})`);
      }
    }
    for (const v of this.variables) {
      if (v.name !== varName && re.test(v.expr)) {
        usages.push(`Variable '${v.name}'`);
      }
    }
    for (const pat of this.patterns) {
      const p = pat.params as unknown as Record<string, string | number | undefined>;
      let usedInPat = false;
      for (const key of [
        "countXExpr",
        "countYExpr",
        "spacingXExpr",
        "spacingYExpr",
        "countExpr",
      ] as const) {
        const e = p[key];
        if (typeof e === "string" && re.test(e)) {
          usedInPat = true;
          break;
        }
      }
      if (usedInPat) usages.push(`Pattern '${pat.kind}'`);
    }
    for (const b of this.bindings) {
      if (re.test(b.expr)) {
        usages.push(`Scalar Binding (${b.scalarKey})`);
      }
    }
    for (const f of this.features) {
      if (!f.paramExprs) continue;
      for (const key of Object.keys(f.paramExprs)) {
        if (re.test(f.paramExprs[key])) {
          usages.push(`Feature '${f.generatorId}'`);
          break;
        }
      }
    }
    return usages;
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
    for (const op of this.operations) {
      if (!op.paramExprs) continue;
      for (const key of Object.keys(op.paramExprs)) {
        op.paramExprs[key] = op.paramExprs[key].replace(re, newName);
      }
    }
  }
  private geo(): Geo {
    const m = new Map(this.entities.map((e) => [e.id, e]));
    return (id) => (id === STOCK_ENTITY_ID ? stockRefEntity(this) : m.get(id));
  }
  /** Topmost dimension whose lines/text are within `tol` mm of `p`, or null. */
  dimensionAt(p: Vec2, tol: number, pxPerMm?: number): Dimension | null {
    const geo = this.geo();
    for (let i = this.dimensions.length - 1; i >= 0; i--) {
      if (this.dimensions[i].hidden) continue; // headless — nothing drawn to click
      if (dimensionHitDistance(this.dimensions[i], geo, p, this.displayUnit, pxPerMm) <= tol) {
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

  /** Nearest pickable point DOF within `tol` mm of `p`, or null. Includes the
   *  stock rectangle's corners/edge-midpoints (see {@link STOCK_ENTITY_ID}) so a
   *  dimension can anchor to the material the same way it already anchors to any
   *  other point — they compete on pure distance with every entity's points. */
  pickPoint(p: Vec2, tol: number): { ref: PointRef; pos: Vec2 } | null {
    let best: { ref: PointRef; pos: Vec2 } | null = null;
    let bestD = tol;
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];
      if (!this.isPickable(e)) continue;

      for (const dp of e.pickablePoints()) {
        const d = dist(dp.pos, p);
        if (d <= bestD) {
          bestD = d;
          best = { ref: { entityId: e.id, key: dp.key }, pos: dp.pos };
        }
      }
    }
    for (const sp of stockSnapPoints(this)) {
      const d = dist(sp.pos, p);
      if (d <= bestD) {
        bestD = d;
        best = { ref: { entityId: sp.entityId, key: sp.key! }, pos: sp.pos };
      }
    }
    return best;
  }

  // --- queries -------------------------------------------------------------
  /**
   * Can the user reach this entity on the canvas — click it, marquee it, drag
   * it? False when its layer is hidden or locked, and false when the entity
   * itself is (see the design tree). The single gate for hit-testing, marquee
   * and Select All, so hiding and locking mean the same thing however the
   * selection is made.
   *
   * Deliberately NOT consulted by the CAM side: hiding geometry is a drafting
   * convenience and must never quietly change a toolpath that references it.
   */
  /**
   * The layer an entity belongs to — always a real layer, never undefined.
   *
   * Renderer, snapping, picking and CAM all need this and all used to spell it
   * `layers.find(...) || layers[0]`, which is only total while `layers` is
   * non-empty. It wasn't: a file carrying `"layers": []` produced a document
   * with none, and the seven copies of that expression each threw on
   * `layer.visible`. One definition, and it holds even if the array is somehow
   * emptied again.
   */
  layerFor(e: { layerId: string }): LayerDef {
    return this.layers.find((l) => l.id === e.layerId) ?? this.layers[0] ?? defaultLayer();
  }

  isPickable(e: Entity): boolean {
    if (!e.visible) return false;
    const layer = this.layerFor(e);
    return layer.visible && !layer.locked;
  }

  /**
   * May the user move this entity — drag, scale, rotate, nudge, delete it?
   *
   * False when the design tree has locked it, and false when a `fixed`
   * constraint pins it. Locking is deliberately SolidWorks-flavoured and is a
   * weaker thing than {@link isPickable}: a locked entity stays clickable,
   * dimensionable and snappable, it just refuses to move. Locking a *layer*
   * remains the blunter tool — that takes its geometry out of reach entirely.
   *
   * Note this does not pin the SOLVER. A locked entity coincident with one you
   * drag still follows, because that is the constraint doing its job; use the
   * `fixed` constraint when you mean "the solver may not move this".
   */
  isMovable(e: Entity): boolean {
    if (e.locked) return false;
    return !this.constraints.some((c) => c.type === "fixed" && c.entities.includes(e.id));
  }

  /**
   * Everything that must travel WITH a drag: entities tied to `moving` by a
   * position-coupling constraint, transitively, excluding `moving` itself.
   *
   * Dragging geometry that something else is constrained to used to do nothing
   * at all. Both outcomes satisfy the constraint — carry the circle, or refuse
   * to move the line — and the solver picked the second, because a drag pin is
   * weighted far below the anchor holding the circle still. So the line sprang
   * back and the gesture was silently discarded.
   *
   * Translating the attached geometry by the same delta BEFORE solving fixes it
   * at the source rather than by re-weighting: a rigid translation preserves
   * every positional constraint exactly, so the solver starts already satisfied
   * and has nothing to undo. It then still resolves whatever the carried
   * geometry is ALSO tied to — a circle on two lines slides along the one that
   * did not move.
   *
   * Orientation and size couplings (parallel, equal, an angle) are deliberately
   * excluded: two parallel lines a metre apart are related, but moving one does
   * not move the other. `fixed`/`fixedPoint` anchor to the world, not to
   * another entity, and immovable geometry is skipped outright.
   */
  carriedBy(moving: Entity[]): Entity[] {
    const seen = new Set(moving.map((e) => e.id));
    const queue = moving.map((e) => e.id);
    const out: Entity[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const c of this.constraints) {
        if (!POSITION_COUPLING.has(c.type)) continue;
        const ids = constraintEntityIds(c);
        if (!ids.includes(id)) continue;
        for (const other of ids) {
          if (seen.has(other)) continue;
          seen.add(other);
          const ent = this.entities.find((x) => x.id === other);
          if (!ent || !this.isMovable(ent)) continue;
          out.push(ent);
          queue.push(other);
        }
      }
    }
    return out;
  }

  /** Topmost entity whose outline is within `tol` mm of `p`, or null. */
  hitTest(p: Vec2, tol: number): Entity | null {
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];
      if (!this.isPickable(e)) continue;
      if (e.distanceTo(p) <= tol) return e;
    }
    return null;
  }

  /** All object-snap points across every entity (optionally excluding some), plus
   *  the stock rectangle's corners/edge-midpoints (see {@link STOCK_ENTITY_ID}) —
   *  so drawing tools can snap new geometry onto the material, not just onto
   *  other entities. */
  snapPoints(exclude?: Set<EntityId>): SnapPoint[] {
    const out: SnapPoint[] = [];
    for (const e of this.entities) {
      if (exclude?.has(e.id)) continue;
      const layer = this.layerFor(e);
      // Snapping still works on locked geometry — that's what a locked datum is
      // FOR — but never on something you cannot see.
      if (!layer.visible || !e.visible) continue;
      out.push(...e.snapPoints());
    }
    out.push(...stockSnapPoints(this));
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
              a: { ...e.a },
              b: { ...e.b },
              ...entityCommon(e),
            };
          if (e instanceof CircleEntity)
            return {
              type: "circle",
              center: { ...e.center },
              radius: e.radius,
              ...entityCommon(e),
            };
          if (e instanceof RectEntity)
            return {
              type: "rectangle",
              p0: { ...e.p0 },
              p1: { ...e.p1 },
              // The ASKED-FOR radii, not the clamped ones: a rectangle that is
              // momentarily too small for its corners must reopen with them
              // intact (see RectEntity.effectiveCornerRadii).
              ...(e.cornerRadii.some((r) => r > 0)
                ? { cornerRadii: [...e.cornerRadii], cornerType: e.cornerType }
                : {}),
              ...entityCommon(e),
            };
          if (e instanceof ArcEntity)
            return {
              type: "arc",
              center: { ...e.center },
              radius: e.radius,
              startAngle: e.startAngle,
              endAngle: e.endAngle,
              ...entityCommon(e),
            };
          if (e instanceof BezierEntity)
            return {
              type: "bezier",
              p0: { ...e.p0 },
              p1: { ...e.p1 },
              p2: { ...e.p2 },
              p3: { ...e.p3 },
              ...entityCommon(e),
            };
          if (e instanceof TextEntity)
            return {
              type: "text",
              text: e.text,
              fontId: e.fontId,
              sizeMM: e.sizeMM,
              position: { ...e.position },
              angle: e.angle,
              ...entityCommon(e),
            };
          if (e instanceof RasterImageEntity)
            return {
              type: "image",
              imageId: e.imageId,
              position: { ...e.position },
              widthMM: e.widthMM,
              heightMM: e.heightMM,
              angle: e.angle,
              flipX: e.flipX,
              flipY: e.flipY,
              aspectLocked: e.aspectLocked,
              ...(e.constraintResize ? { constraintResize: true } : {}),
              ...(e.constraintRotate ? { constraintRotate: true } : {}),
              ...entityCommon(e),
            };
          const pe = e as PolylineEntity;
          return {
            type: "polyline",
            points: pe.points.map((p) => ({ ...p })),
            vertexIds: [...pe.vertexIds],
            closed: pe.closed,
            ...(pe.polygon ? { polygon: { ...pe.polygon, center: { ...pe.polygon.center } } } : {}),
            ...(pe.cornerRadii.size > 0
              ? {
                  cornerRadii: Object.fromEntries(pe.cornerRadii),
                  cornerType: pe.cornerType,
                }
              : {}),
            ...entityCommon(pe),
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
      counter: this.counter,
      stockRect: this.stockRect ? { ...this.stockRect } : null,
      origin: { ...this.origin },
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
      layers: this.layers.map(cloneLayer),
      activeLayerId: this.activeLayerId,
      operations: this.operations.map((op) => ({
        ...op,
        entityIds: [...op.entityIds],
        ...(op.paramExprs ? { paramExprs: { ...op.paramExprs } } : {}),
      })),
      tools: this.tools.map((t) => ({ ...t })),
    };
  }

  restore(s: DocSnapshot): void {
    // Length, not truthiness: a hand- or AI-authored file that writes
    // `"layers": []` is saying "I have no layers", not "give me none". Left
    // empty, every entity's `layerId` names a layer that doesn't exist and the
    // `layerFor` fallback has nothing to fall back TO — which used to throw on
    // the first entity drawn and abort the frame, leaving a canvas with grid,
    // stock and origin but no geometry at all.
    this.layers = s.layers?.length ? s.layers.map(cloneLayer) : [defaultLayer()];
    for (const l of this.layers) updateCounter(l.id);
    // Likewise the active layer must name one that exists: a file listing only
    // "l-cut" and no activeLayerId would otherwise point at the absent
    // "layer-0", and every entity drawn next would be filed onto nothing.
    this.activeLayerId = this.layers.some((l) => l.id === s.activeLayerId)
      ? s.activeLayerId!
      : this.layers[0].id;

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
          const rect = new RectEntity({ ...es.p0 }, { ...es.p1 }, es.id);
          // Tolerant of a hand-authored file: the schema says four numbers, but
          // a short, long or junk-filled array loads as far as it makes sense
          // rather than throwing or producing NaN geometry.
          if (es.cornerRadii) {
            rect.cornerRadii = [0, 1, 2, 3].map((i) => {
              const v = es.cornerRadii?.[i];
              return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
            }) as [number, number, number, number];
          }
          if (es.cornerType && CORNER_TYPES.includes(es.cornerType)) rect.cornerType = es.cornerType;
          e = rect;
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
          // Tolerant of a hand-authored file, as the rectangle branch is: a key
          // naming no vertex, or a junk value, is dropped rather than throwing
          // or producing NaN geometry.
          if (es.cornerRadii) {
            for (const [vid, v] of Object.entries(es.cornerRadii)) {
              if (typeof v === "number" && Number.isFinite(v) && v > 0 && pl.vertexIds.includes(vid))
                pl.cornerRadii.set(vid, v);
            }
          }
          if (es.cornerType && CORNER_TYPES.includes(es.cornerType)) pl.cornerType = es.cornerType;
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
          // Coerced, not trusted: applyFile doesn't schema-validate, so a
          // hand-written/generated .rcam could carry anything here. Absent or
          // non-true means the image stays rigid.
          (e as RasterImageEntity).constraintResize = es.constraintResize === true;
          (e as RasterImageEntity).constraintRotate = es.constraintRotate === true;
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
        e.layerId = es.layerId ?? DEFAULT_LAYER_ID;
        e.name = es.name || undefined;
        // Absent = the default, so a pre-design-tree file loads fully visible
        // and unlocked. Coerced rather than trusted: applyFile doesn't
        // schema-validate (see the image branch above).
        e.visible = es.visible !== false;
        e.locked = es.locked === true;
        // Only a positive, finite number is a height; anything else means
        // "inherit the layer", which is what every pre-per-clamp file says.
        e.fixtureHeight =
          typeof es.fixtureHeight === "number" &&
          es.fixtureHeight > 0 &&
          Number.isFinite(es.fixtureHeight)
            ? es.fixtureHeight
            : undefined;
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
    this.variables = (s.variables || []).map((v) => {
      updateCounter(v.id);
      return { ...v };
    });
    this.bindings = [...(s.bindings || []).map((b) => ({ ...b })), ...legacyImageBindings];
    for (const b of this.bindings) updateCounter(b.id);

    this.isConstructionMode = s.isConstructionMode;
    this.selectedPoints = s.selectedPoints.map((p) => ({ ...p }));
    this.selectedConstraintId = s.selectedConstraintId ?? null;
    this.selectedDimensionId = s.selectedDimensionId ?? null;
    if (s.canvas) this.canvas = { ...s.canvas };
    if (s.stockThickness !== undefined) this.stockThickness = s.stockThickness;
    if (s.counter !== undefined) this.counter = s.counter;
    this.stockRect = s.stockRect ? { ...s.stockRect } : null;
    if (s.origin) this.origin = { ...s.origin };
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
          ...(op.paramExprs ? { paramExprs: { ...op.paramExprs } } : {}),
        }))
      : [];
    for (const op of this.operations) updateCounter(op.id);
    // Tools need no reconciliation: their ids are `builtin-*` or `tool-<timestamp>`,
    // never nextId-generated, so updateCounter's /^[a-zA-Z]+\d+$/ pattern never matches.
    this.tools = s.tools ? s.tools.map((t) => ({ ...t })) : [];
    // Always ensure the WCS origin entity is present after loading.
    if (!this.entities.find((e) => e.id === ORIGIN_ENTITY_ID))
      this.entities.unshift(new PointEntity({ x: 0, y: 0 }, ORIGIN_ENTITY_ID));
    this.emitChange();
  }
}
