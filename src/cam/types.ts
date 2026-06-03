import type { EntityId } from "../model/entities";

export type CAMOpType = "profile" | "engrave" | "drill";

export interface CAMOperation {
  id: string;
  name: string;
  type: CAMOpType;
  entityIds: EntityId[];
  side: "outside" | "inside"; // profile only
  // tool
  toolNumber: number;         // T-number for tool changer (1-based)
  diameter: number;           // mm
  feedrate: number;           // mm/min
  plungeRate: number;         // mm/min
  spindleSpeed: number;       // rpm
  safeZ: number;              // mm above work surface
  // cut
  depth: number;              // mm below surface (negative)
  stepdown: number;           // mm per depth pass (ignored for drill)
}

export const DEFAULTS = {
  toolNumber: 1,
  diameter: 6,
  feedrate: 1000,
  plungeRate: 300,
  spindleSpeed: 18000,
  safeZ: 5,
  depth: -3,
  stepdown: 1.5,
} as const;
