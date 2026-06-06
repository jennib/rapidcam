import { type ToolDef } from "./types";
import { nextId } from "../model/ids";

const STORAGE_KEY = "rapidcam-tool-library";

const BUILTIN_DEFAULTS: Omit<ToolDef, "id">[] = [
  { name: '1/8" End Mill',  toolType: "end-mill",  diameter: 3.175, feedrate: 1000, plungeRate: 300, spindleSpeed: 18000, safeZ: 5 },
  { name: '1/4" End Mill',  toolType: "end-mill",  diameter: 6.35,  feedrate: 1500, plungeRate: 400, spindleSpeed: 18000, safeZ: 5 },
  { name: "60° V-Bit",      toolType: "v-bit",     diameter: 0.1,   vAngle: 60,  feedrate: 800, plungeRate: 200, spindleSpeed: 18000, safeZ: 5 },
  { name: "90° V-Bit",      toolType: "v-bit",     diameter: 0.1,   vAngle: 90,  feedrate: 800, plungeRate: 200, spindleSpeed: 18000, safeZ: 5 },
  { name: "3mm Ball Nose",  toolType: "ball-nose", diameter: 3,     feedrate: 1000, plungeRate: 300, spindleSpeed: 18000, safeZ: 5 },
  { name: "3mm Drill Bit",  toolType: "drill",     diameter: 3,     tipAngle: 118, feedrate: 600, plungeRate: 200, spindleSpeed: 3000,  safeZ: 5 },
];

export function loadLibrary(): ToolDef[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seedDefaults();
    const parsed = JSON.parse(raw) as ToolDef[];
    if (!Array.isArray(parsed)) return seedDefaults();
    return parsed;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return seedDefaults();
  }
}

function seedDefaults(): ToolDef[] {
  const tools: ToolDef[] = BUILTIN_DEFAULTS.map(d => ({ ...d, id: nextId("tool") }));
  saveLibrary(tools);
  return tools;
}

export function saveLibrary(tools: ToolDef[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tools));
}

export function addTool(def: ToolDef): void {
  const tools = loadLibrary();
  const idx = tools.findIndex(t => t.id === def.id);
  if (idx >= 0) tools[idx] = def;
  else tools.push(def);
  saveLibrary(tools);
}

export function removeTool(id: string): void {
  saveLibrary(loadLibrary().filter(t => t.id !== id));
}
