import type { EntityId } from "../model/entities";

export type CAMOpType = "profile" | "engrave" | "drill" | "pocket";

export type ToolType = "end-mill" | "ball-nose" | "v-bit" | "drill";

/** Coolant mode emitted around an operation: off (none), mist (M7), or flood (M8). M9 turns it off. */
export type CoolantMode = "off" | "mist" | "flood";

export interface ToolDef {
  id: string;
  name: string;
  toolType: ToolType;
  diameter: number;       // mm
  vAngle?: number;        // V-bit included angle, degrees
  tipDiameter?: number;   // V-bit flat tip diameter, mm (0 = sharp)
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
