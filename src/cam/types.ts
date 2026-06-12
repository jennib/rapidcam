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
