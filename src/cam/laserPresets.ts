/**
 * Saved laser material recipes — "3mm birch ply, cut" — stored in localStorage.
 *
 * Power and speed for a laser are a property of *your* machine and *your*
 * material: tube vs diode, lens, mirror alignment, tube age, even the batch of
 * plywood. There is no useful universal answer, which is why this ships EMPTY
 * rather than seeding builtins the way `toolLibrary.ts` does. A 1/8" end mill is
 * a 1/8" end mill on any router; "3mm ply cuts at 100% and 300mm/min" is true
 * only of the machine it was measured on. Seeding numbers a user might trust is
 * worse than showing nothing — a laser running too slowly at high power starts
 * a fire, it doesn't just spoil the part. The intended workflow is to run a
 * Material Test grid (camBar "Material Test"), find the cell that worked, and
 * save those numbers as a preset.
 *
 * Applying a preset copies its values into the operation. Nothing here is
 * referenced by id from a saved `.rcam` — unlike a ToolDef, which is embedded in
 * the document so a file stays self-contained. A preset is a personal shortcut
 * for filling in a dialog, so a design opened on another machine carries the
 * numbers it was cut with and no dangling reference to a recipe that machine
 * never had.
 */

import { StorageKeys } from "../core/storageKeys";

const STORAGE_KEY = StorageKeys.laserPresets;

/**
 * Recipes for the same material differ enormously by job: engraving ply might be
 * 20% at 3000mm/min where cutting it is 100% at 300, and a score/fold line is a
 * deliberately shallow surface pass at lower power still. A preset records which
 * job it was tuned for and the picker offers only the matching kind — handing a
 * cut recipe to a score op would suggest a power an order of magnitude too high.
 */
export type LaserPresetKind = "cut" | "engrave" | "score";

export interface LaserPreset {
  id: string;
  name: string;
  kind: LaserPresetKind;
  /** mm/min. */
  feedrate: number;
  /** 0–100. */
  laserPower: number;
  laserPasses: number;
  /** mm. Omitted when the recipe doesn't pin it. */
  kerfWidth?: number;
  airAssist?: boolean;
}

/** Every saved preset, oldest first. Returns [] when there are none or the store is unreadable. */
export function loadPresets(): LaserPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LaserPreset[];
    if (!Array.isArray(parsed)) return [];
    // Drop anything that isn't a usable recipe rather than letting a corrupt
    // entry surface as NaN power in the dialog.
    return parsed.filter(isPreset);
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return [];
  }
}

/** The presets valid for a given job kind — the only ones worth offering. */
export function presetsFor(kind: LaserPresetKind): LaserPreset[] {
  return loadPresets().filter((p) => p.kind === kind);
}

export function savePresets(presets: LaserPreset[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

/** Insert, or replace in place when the id already exists. */
export function addPreset(preset: LaserPreset): void {
  const presets = loadPresets();
  const idx = presets.findIndex((p) => p.id === preset.id);
  if (idx >= 0) presets[idx] = preset;
  else presets.push(preset);
  savePresets(presets);
}

export function removePreset(id: string): void {
  savePresets(loadPresets().filter((p) => p.id !== id));
}

/** A collision-resistant id for a newly saved preset. */
export function newPresetId(): string {
  return `lp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Structural check — a stored blob is only usable if the numbers are real. */
function isPreset(p: unknown): p is LaserPreset {
  if (!p || typeof p !== "object") return false;
  const c = p as Partial<LaserPreset>;
  return (
    typeof c.id === "string" &&
    typeof c.name === "string" &&
    (c.kind === "cut" || c.kind === "engrave" || c.kind === "score") &&
    Number.isFinite(c.feedrate) &&
    Number.isFinite(c.laserPower) &&
    Number.isFinite(c.laserPasses)
  );
}
