import type { EntityId } from "../model/entities";
import type { Vec2 } from "../core/vec2";

export type CAMOpType = "profile" | "engrave" | "drill" | "pocket";

export type ToolType = "end-mill" | "ball-nose" | "v-bit" | "drill";

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
   * Pocket only: flood-fill region seeds. Each seed is a world point inside an
   * enclosed area; the region around it (bounded by the nearest geometry, with
   * enclosed shapes as islands) is recomputed from live geometry at G-code time.
   * When present, these define the pocket instead of entityIds/islandIds.
   */
  regionSeeds?: Vec2[];
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
