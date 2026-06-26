/**
 * Laser material-test generator. Produces a grid of engraved squares that sweep
 * **power** (rows, Y) against **speed/feed** (columns, X), plus axis labels, so a
 * user can run it once on a new material and read off the best settings — the
 * laser analogue of a feeds-and-speeds test.
 *
 * It's a pure function: given the ranges it returns geometry (rectangles + label
 * text) and one CAM operation per cell, each carrying that cell's `laserPower`
 * and `feedrate`. Power/speed are already per-operation, so a material test is
 * just N×M ops with swept values — no new execution model. The caller adds the
 * result to the document (in one history step) and typically groups the geometry.
 */

import { RectEntity, TextEntity, type Entity } from "../model/entities";
import { defaultFontId } from "../core/fontManager";
import { nextId } from "../model/ids";
import { type CAMOperation, DEFAULTS } from "./types";

export interface MaterialTestParams {
  /**
   * What each cell does: "engrave" area-fills the square (find the cleanest
   * mark), "cut" traces the square's outline (find the minimum that cuts
   * through — cells that do drop out).
   */
  mode: "engrave" | "cut";
  /** Cut mode only: passes per cell (cut tests often need more than one). */
  cutPasses: number;
  /** Power axis (rows), percent. */
  powerMin: number;
  powerMax: number;
  powerSteps: number;
  /** Speed axis (columns), mm/min. */
  speedMin: number;
  speedMax: number;
  speedSteps: number;
  /** Square cell edge length, mm. */
  cellSize: number;
  /** Gap between cells, mm. */
  gap: number;
  /** Engrave fill line spacing, mm. */
  fillSpacing: number;
  /** Bottom-left corner of the cell grid, world mm. */
  origin: { x: number; y: number };
  /** Engrave axis labels (power % at left, speed at bottom). */
  labels: boolean;
  /** Fixed, legible settings used to engrave the labels (not swept). */
  labelPower: number;
  labelSpeed: number;
  /** Font for labels; defaults to the first loaded font. */
  fontId?: string;
}

export interface MaterialTestResult {
  entities: Entity[];
  operations: CAMOperation[];
}

/** Linear step value; the single-step case collapses to the minimum. */
function lerp(min: number, max: number, i: number, steps: number): number {
  return steps <= 1 ? min : min + (max - min) * (i / (steps - 1));
}

const round = (v: number) => Math.round(v);

function baseLaserOp(
  name: string, type: "engrave" | "profile", entityIds: string[],
  power: number, feed: number, passes: number,
): CAMOperation {
  return {
    id: nextId("cam"),
    name,
    type,
    entityIds,
    side: "outside",
    toolType: "end-mill", // irrelevant for a laser (no tool), but the field is required
    toolNumber: 1,
    diameter: 0,
    feedrate: feed,
    plungeRate: DEFAULTS.plungeRate,
    spindleSpeed: 0,
    safeZ: DEFAULTS.safeZ,
    depth: DEFAULTS.depth,
    stepdown: DEFAULTS.stepdown,
    stepover: DEFAULTS.stepover,
    laserPower: power,
    laserPasses: Math.max(1, Math.round(passes)),
  };
}

/**
 * Build the material-test grid. Rows sweep power (bottom → top = min → max),
 * columns sweep speed (left → right = min → max). Each cell is an area-fill
 * engrave at its (power, feed). Returns geometry + ops; the caller commits them.
 */
export function generateMaterialTest(p: MaterialTestParams): MaterialTestResult {
  const entities: Entity[] = [];
  const operations: CAMOperation[] = [];

  const cell = Math.max(1, p.cellSize);
  const pitch = cell + Math.max(0, p.gap);
  const rows = Math.max(1, Math.round(p.powerSteps));
  const cols = Math.max(1, Math.round(p.speedSteps));
  const fontId = p.fontId || defaultFontId();
  const spacing = Math.max(0.01, p.fillSpacing);

  for (let r = 0; r < rows; r++) {
    const power = lerp(p.powerMin, p.powerMax, r, rows);
    const y = p.origin.y + r * pitch;
    for (let c = 0; c < cols; c++) {
      const feed = lerp(p.speedMin, p.speedMax, c, cols);
      const x = p.origin.x + c * pitch;
      const rect = new RectEntity({ x, y }, { x: x + cell, y: y + cell });
      entities.push(rect);
      if (p.mode === "cut") {
        // Trace the square's outline — cells that cut through drop out.
        const op = baseLaserOp(`P${round(power)}% F${round(feed)}`, "profile", [rect.id], power, feed, p.cutPasses);
        op.kerfWidth = 0; // cut on the line
        operations.push(op);
      } else {
        const op = baseLaserOp(`P${round(power)}% F${round(feed)}`, "engrave", [rect.id], power, feed, 1);
        op.laserFill = true;
        op.laserFillSpacing = spacing;
        operations.push(op);
      }
    }
  }

  if (p.labels && fontId) {
    const ts = Math.max(2, Math.min(cell * 0.4, 6)); // legible label height, mm
    const labelEnts: Entity[] = [];
    // Power labels down the left edge.
    for (let r = 0; r < rows; r++) {
      const power = lerp(p.powerMin, p.powerMax, r, rows);
      const y = p.origin.y + r * pitch + cell / 2 - ts / 2;
      labelEnts.push(new TextEntity(`${round(power)}%`, fontId, ts, { x: p.origin.x - ts * 3.2, y }, 0));
    }
    // Speed labels along the bottom edge.
    for (let c = 0; c < cols; c++) {
      const feed = lerp(p.speedMin, p.speedMax, c, cols);
      const x = p.origin.x + c * pitch + cell * 0.1;
      labelEnts.push(new TextEntity(`${round(feed)}`, fontId, ts, { x, y: p.origin.y - ts - cell * 0.15 }, 0));
    }
    entities.push(...labelEnts);
    // One engrave op marks all labels at the fixed, legible reference settings.
    operations.push(baseLaserOp("Labels", "engrave", labelEnts.map((e) => e.id), p.labelPower, p.labelSpeed, 1));
  }

  return { entities, operations };
}

/** Sensible starting parameters for the dialog. */
export const MATERIAL_TEST_DEFAULTS: Omit<MaterialTestParams, "origin"> = {
  mode: "engrave", cutPasses: 1,
  powerMin: 20, powerMax: 100, powerSteps: 5,
  speedMin: 200, speedMax: 1200, speedSteps: 5,
  cellSize: 10, gap: 2, fillSpacing: 0.2,
  labels: true, labelPower: 80, labelSpeed: 600,
};
