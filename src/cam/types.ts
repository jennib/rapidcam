import type { EntityId } from "../model/entities";
import type { Vec2 } from "../core/vec2";

export type CAMOpType = "profile" | "engrave" | "drill" | "pocket" | "chamfer" | "vcarve";

/** Which side of the contour a chamfer's bevel sits on ("on" = centred on the edge). */
export type ChamferSide = "on" | "outside" | "inside";

export type ToolType = "end-mill" | "ball-nose" | "v-bit" | "drill";

/** Coolant mode emitted around an operation: off (none), mist (M7), or flood (M8). M9 turns it off. */
export type CoolantMode = "off" | "mist" | "flood";

/**
 * A cutting tool. Geometry fields vary by `toolType`; the V-bit is the one
 * worth a picture, because `diameter` and `tipDiameter` measure OPPOSITE ends
 * and are easy to confuse:
 *
 *        diameter Ø  (cutting/major diameter — the WIDEST part, at the
 *        |<------->|  top of the flutes; this is the conventional "size")
 *   ─────┴─────────┴─────   top of cutting flutes
 *         \       /
 *          \ vAngle (the INCLUDED angle across the point, e.g. 60° — not
 *           \  ↕  /   the half-angle; code halves it as vAngle/2)
 *            \   /
 *           ┌─┴─┐
 *           tipDiameter  (the small flat at the POINT; 0 = perfectly sharp)
 *
 * end-mill: flat, `diameter` only. ball-nose: round tip, radius = `diameter`/2.
 * drill: `diameter` + `tipAngle` (conical point, e.g. 118°).
 */
export interface ToolDef {
  id: string;
  name: string;
  toolType: ToolType;
  diameter: number;       // mm — cutting/major diameter (widest part; see diagram above)
  vAngle?: number;        // V-bit included angle (total, not half), degrees
  tipDiameter?: number;   // V-bit flat tip diameter, mm (0 = sharp); the narrow end, ≠ diameter
  tipAngle?: number;      // Drill tip angle, degrees
  feedrate: number;       // mm/min
  plungeRate: number;     // mm/min
  spindleSpeed: number;   // rpm
  safeZ: number;          // mm
}

export type LeadType = "none" | "linear" | "arc";

export interface LeadDef {
  type: LeadType;
  length: number; // mm
}

export interface TabDef {
  enabled: boolean;
  count: number;    // tabs distributed evenly around the path
  width: number;    // mm — arc-length of each tab
  height: number;   // mm — material left standing above the cut floor
}

/**
 * A parametric reference to one enclosed region (pocket face), resolved against
 * live geometry at toolpath time so it survives constraint-driven reflow.
 *
 * A face in the planar arrangement of closed loops is uniquely identified by the
 * set of loops that *contain* it (it lies inside exactly these, outside all
 * others). We store each containing loop by the entity ids whose geometry forms
 * it — ids are stable across reflow, coordinates are not. At toolpath time the
 * loops are rebuilt from current geometry, matched back by id-set, and the face
 * (with any enclosed loops as islands) is recomputed fresh. If a referenced loop
 * no longer exists, the reference fails loudly rather than cutting the wrong area.
 */
export interface RegionRef {
  /** Entity-id sets of the loops enclosing the region; one inner array per loop. */
  containingLoops: EntityId[][];
}

export interface CAMOperation {
  id: string;
  name: string;
  type: CAMOpType;
  entityIds: EntityId[];
  side: "outside" | "inside"; // profile only
  /**
   * When the op's geometry belongs to a pattern, the toolpath covers the whole
   * pattern and follows its count (resolved at toolpath time). Set false to opt
   * out and cut only the literal `entityIds`. Default (undefined) = follow.
   */
  followPattern?: boolean;
  // tool
  /**
   * Optional reference into the document's `tools` library. When set and it
   * resolves to a tool, that tool's geometry/feeds (toolType, diameter, vAngle,
   * tipAngle, feedrate, plungeRate, spindleSpeed, safeZ) drive the operation and
   * the inline fields below act only as a fallback for unresolved ids. Editing a
   * tool field in the UI clears `toolId` (the op forks to a one-off). Old files
   * have no `toolId`, so their inline fields are always authoritative.
   */
  toolId?: string;
  toolType: ToolType;
  toolNumber: number;         // T-number for tool changer (1-based)
  diameter: number;           // mm
  vAngle?: number;            // V-bit included angle, degrees (default 60)
  tipDiameter?: number;       // V-bit flat tip, mm (default 0)
  tipAngle?: number;          // Drill tip angle, degrees (default 118)
  feedrate: number;           // mm/min
  plungeRate: number;         // mm/min
  spindleSpeed: number;       // rpm
  safeZ: number;              // mm above work surface
  // cut
  depth: number;              // mm below surface (negative)
  stepdown: number;           // mm per depth pass (ignored for drill)
  /**
   * Drill only: peck increment in mm. When > 0, the hole is drilled in steps of
   * this depth, fully retracting to safe Z between pecks to clear chips
   * (G83-style). Omitted/0 = a single full-depth plunge.
   */
  peckDepth?: number;
  /**
   * Coolant for this operation: off | mist (M7) | flood (M8). Default off.
   * Only emitted when the machine is flagged as having coolant (a machine-wide
   * capability, see core/prefs); otherwise suppressed regardless of this value.
   */
  coolant?: CoolantMode;
  /**
   * Profile/pocket: when true, leave a thin radial skin during stepdown roughing
   * and remove it in a final full-depth wall pass — cleaning the ridges left
   * between depth levels. Default false.
   */
  finishPass?: boolean;
  /**
   * Radial stock (mm) left on the walls during roughing and removed by the
   * finishing pass. Only used when `finishPass` is true; default 0.2. Clamped
   * below the tool radius so the finish lap still enters through cleared stock.
   */
  finishAllowance?: number;
  /**
   * Chamfer only: the horizontal width (mm) of the bevel face. The plunge depth
   * is derived from this and the V-bit angle (`depth = width / tan(½·vAngle)`).
   */
  chamferWidth?: number;
  /** Chamfer only: which side of the contour the bevel sits on. Default "on". */
  chamferSide?: ChamferSide;
  /**
   * V-carve only: radial inset (mm) between successive offset-peel passes — the
   * pitch that sets how smooth the sloped/flat floor is. Smaller = finer finish,
   * more passes. Default 0.4. The carve uses the V-bit `vAngle` for the slope and
   * `|depth|` as the maximum depth (wide areas bottom out flat at that depth).
   */
  vStep?: number;
  /**
   * Chamfer only: lift the V-bit tip up into each sharp (convex) corner so the
   * bevel comes to a crisp point instead of a rounded fillet. Default false.
   */
  sharpenCorners?: boolean;
  tabs?: TabDef;              // profile only
  // pocket
  stepover: number;           // fraction of tool diameter (default 0.4)
  /**
   * Pocket clearing strategy. "offset" = contour-parallel concentric loops
   * (default; wraps islands with no lifting), "raster" = zig-zag rows.
   * Undefined is treated as "offset".
   */
  pocketStrategy?: "offset" | "raster";
  islandIds?: EntityId[];     // pocket only (legacy): entities to treat as islands (excluded from fill)
  /**
   * Pocket only: the enclosed regions to clear, identified *parametrically* so
   * they reflow with the model. Each region records the loops that enclose it
   * (by the entity ids whose live geometry forms each loop); the actual fill is
   * recomputed from current geometry at toolpath time — see {@link RegionRef}.
   * When present, these define the pocket instead of entityIds/islandIds.
   */
  regions?: RegionRef[];
  // lead-in / lead-out (profile only)
  leadIn?: LeadDef;
  leadOut?: LeadDef;
  // --- laser (machineKind === "laser") -------------------------------------
  /**
   * Laser/jet beam power as a percentage (0–100) of the machine's maximum. The
   * generator scales it to an `S` word against the controller's max power
   * (GRBL `$30`). Ignored when the document's machine is a mill.
   */
  laserPower?: number;
  /**
   * Number of times the beam re-traces each path (laser/jet). >1 cuts through
   * thicker stock in repeated passes — the fixed-Z analogue of milling
   * stepdown. Default 1.
   */
  laserPasses?: number;
  /**
   * Kerf width (mm) of the beam, used to compensate closed profiles: the path is
   * offset outward ("outside") or inward ("inside") by half this. 0 = cut on the
   * line (no compensation). Engrave ignores it (always centreline).
   */
  kerfWidth?: number;
  /**
   * Laser engrave only: fill the interior of closed shapes with parallel scan
   * lines (area/solid engraving) in addition to outlining them, instead of
   * tracing the centreline only. Closed contours are grouped even–odd so letter
   * counters (the hole in "O") stay unfilled. Default false.
   */
  laserFill?: boolean;
  /** Laser fill only: spacing (mm) between scan lines — roughly the beam/line width. Default 0.2. */
  laserFillSpacing?: number;
}

export const DEFAULTS = {
  toolType: "end-mill" as ToolType,
  toolNumber: 1,
  diameter: 6,
  vAngle: 60,
  tipAngle: 118,
  feedrate: 1000,
  plungeRate: 300,
  spindleSpeed: 18000,
  safeZ: 5,
  depth: -3,
  stepdown: 1.5,
  stepover: 0.4,
  coolant: "off" as CoolantMode,
  peckDepth: 0,
  finishAllowance: 0.2,
  chamferWidth: 3,
  chamferSide: "on" as ChamferSide,
  vStep: 0.4,
  laserPower: 80,
  laserPasses: 1,
  kerfWidth: 0,
  laserFillSpacing: 0.2,
} as const;

export const TOOL_TYPE_LABELS: Record<ToolType, string> = {
  "end-mill":  "End Mill",
  "ball-nose": "Ball Nose",
  "v-bit":     "V-Bit",
  "drill":     "Drill",
};

/**
 * Resolve an operation's effective tool. If `op.toolId` references a tool in
 * `tools`, return a shallow copy of the op with that tool's geometry/feeds
 * applied (so a single library tool can drive many ops — edit it once, every
 * referencing op updates). Otherwise the op is returned unchanged, so the inline
 * fields stay authoritative. `toolNumber`/`depth`/`stepdown`/`stepover` and other
 * per-op cut settings are never overridden — they belong to the operation.
 */
/**
 * Plunge depth (negative, mm) for a V-bit chamfer of the given face width: the
 * bit's flank reaches `chamferWidth` horizontally at `depth = width / tan(½·vAngle)`.
 * Shared by the G-code generator and the preview rasterizer so they agree.
 *
 *   stock top (Z=0) ──────┬──────────────
 *                         │\
 *        chamferWidth     │ \   ← bevel face; slope set by vAngle
 *        |<-------->|     │  \
 *                  depth ─┴───● ← V tip plunged to here
 *
 * Assumes a sharp tip (tipDiameter is intentionally not folded in). The face
 * can't be wider than the bit's cutting radius (`diameter`/2); the G-code
 * generator warns when `chamferWidth` exceeds it.
 */
export function chamferDepth(op: CAMOperation): number {
  const halfTan = Math.tan(((op.vAngle ?? 60) / 2) * (Math.PI / 180));
  const w = op.chamferWidth ?? 0;
  return halfTan > 1e-6 ? -w / halfTan : 0;
}

/** A point on a chamfer toolpath; `lift` = ramp the tip up to the surface here. */
export interface ChamferPathPt { x: number; y: number; lift: boolean; }

/**
 * Expand a closed CCW contour into a chamfer toolpath that sharpens its inside
 * corners. At each sharp (convex) corner the bevel tapers to the surface right
 * *at the corner vertex* — the V-bit tip is pulled up into the corner so the two
 * bevel faces meet at a crisp point instead of a rounded fillet. The taper runs
 * over `width` of travel on each side of the vertex; other vertices are emitted
 * at full depth. Concave corners are left as-is (a V-bit can't sharpen them).
 */
export function chamferSharpSequence(ccw: Vec2[], width: number): ChamferPathPt[] {
  const N = ccw.length;
  if (N < 3) return ccw.map((v) => ({ x: v.x, y: v.y, lift: false }));
  const seq: ChamferPathPt[] = [];
  for (let i = 0; i < N; i++) {
    const prev = ccw[(i - 1 + N) % N], v = ccw[i], next = ccw[(i + 1) % N];
    const il = Math.hypot(v.x - prev.x, v.y - prev.y) || 1;
    const dinx = (v.x - prev.x) / il, diny = (v.y - prev.y) / il;
    const ol = Math.hypot(next.x - v.x, next.y - v.y) || 1;
    const doutx = (next.x - v.x) / ol, douty = (next.y - v.y) / ol;
    // cross = sin(deflection); > 0 = convex (inside corner) for a CCW contour.
    // Only sharpen corners turning more than ~30°.
    const cross = dinx * douty - diny * doutx;
    if (width <= 0 || cross <= 0.5) {
      seq.push({ x: v.x, y: v.y, lift: false });
      continue;
    }
    const lin = Math.min(width, il * 0.45), lout = Math.min(width, ol * 0.45);
    seq.push({ x: v.x - dinx * lin, y: v.y - diny * lin, lift: false }); // ramp up
    seq.push({ x: v.x, y: v.y, lift: true });                            // tip at the corner
    seq.push({ x: v.x + doutx * lout, y: v.y + douty * lout, lift: false }); // ramp down
  }
  return seq;
}

/**
 * The operations selected for a combined export, in **document order** (so the
 * single file runs them top-to-bottom regardless of the order they were ticked).
 */
export function selectedOpsInOrder(operations: CAMOperation[], ids: Set<string>): CAMOperation[] {
  return operations.filter((op) => ids.has(op.id));
}

export function resolveOpTool(op: CAMOperation, tools?: ToolDef[]): CAMOperation {
  if (!op.toolId || !tools || tools.length === 0) return op;
  const t = tools.find((td) => td.id === op.toolId);
  if (!t) return op;
  return {
    ...op,
    toolType: t.toolType,
    diameter: t.diameter,
    vAngle: t.vAngle ?? op.vAngle,
    tipAngle: t.tipAngle ?? op.tipAngle,
    feedrate: t.feedrate,
    plungeRate: t.plungeRate,
    spindleSpeed: t.spindleSpeed,
    safeZ: t.safeZ,
  };
}
