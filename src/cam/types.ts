import type { EntityId } from "../model/entities";

export type CAMOpType = "profile" | "engrave" | "drill";

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
} as const;

export const TOOL_TYPE_LABELS: Record<ToolType, string> = {
  "end-mill":  "End Mill",
  "ball-nose": "Ball Nose",
  "v-bit":     "V-Bit",
  "drill":     "Drill",
};
