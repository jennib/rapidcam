/**
 * Stitch phase 2c — orchestration.
 *
 * Ties the planner, motion parser, and clip together: given one finished G-code
 * program, split it into machine-bed-sized tiles, each translated to its own
 * local origin (re-zero at that tile's lower-left corner per setup) so it fits
 * the bed. Registration-feature emission is a later phase; the plan is returned
 * so callers can preview/emit it.
 *
 * Everything runs in the G-code's own (work) coordinate space — the tiling
 * bounds come from the program's cut extents, so there is no canvas↔work
 * reconciliation to get wrong.
 */

import { planTiles, type StitchOptions, type StitchPlan } from "./tiling";
import { parseProgram, emitProgram, unsupportedMotions } from "./gcodeMotion";
import { clipProgramToTile, programCutBounds } from "./tileClip";

export interface StitchTile {
  index: number;
  row: number;
  col: number;
  /** Suggested filename stem (no extension). */
  name: string;
  /** Tile-local G-code (origin at this tile's lower-left corner). */
  gcode: string;
  warnings: string[];
}

export interface StitchResult {
  tiles: StitchTile[];
  plan: StitchPlan | null;
  /** Program-level problems (e.g. motions that can't be tiled). */
  warnings: string[];
}

export interface StitchGCodeOptions extends StitchOptions {
  /** Base name for the tile files (default "toolpaths"). */
  name?: string;
}

function tileHeader(name: string, col: number, row: number, plan: StitchPlan, o: StitchGCodeOptions): string {
  return [
    `; RapidCAM Stitch — ${name}`,
    `; Tile column ${col + 1}/${plan.cols}, row ${row + 1}/${plan.rows} (bed ${o.tileW}×${o.tileH}mm)`,
    `; Local origin (X0 Y0) is this tile's lower-left corner — re-zero here after repositioning the stock`,
    "",
  ].join("\n");
}

/**
 * Split finished G-code into per-tile programs. A design that already fits one
 * tile comes back as a single unchanged file.
 */
export function stitchGCode(gcode: string, opts: StitchGCodeOptions): StitchResult {
  const name = opts.name ?? "toolpaths";
  const warnings: string[] = [];

  const unsupported = unsupportedMotions(gcode);
  if (unsupported.length > 0) {
    warnings.push(
      `contains motions Stitch can't tile (${unsupported.join(", ")}) — re-post with the GRBL processor ` +
      `or avoid bezier engraving, then try again`,
    );
    return { tiles: [], plan: null, warnings };
  }

  const program = parseProgram(gcode);
  const bounds = programCutBounds(program);
  if (!bounds) {
    warnings.push("no cutting toolpaths to tile");
    return { tiles: [], plan: null, warnings };
  }

  const plan = planTiles(bounds, opts);

  // Already fits the bed → hand back the original program untouched.
  if (plan.tiles.length === 1) {
    return {
      tiles: [{ index: 0, row: 0, col: 0, name, gcode, warnings: [] }],
      plan,
      warnings,
    };
  }

  const tiles: StitchTile[] = [];
  for (const cell of plan.tiles) {
    const clip = clipProgramToTile(program, cell.rect);
    if (!clip.hasCuts) continue; // nothing of the design reaches this tile
    const body = emitProgram(clip.program, { dx: cell.rect.min.x, dy: cell.rect.min.y });
    tiles.push({
      index: cell.index,
      row: cell.row,
      col: cell.col,
      name: `${name}_c${cell.col + 1}_r${cell.row + 1}`,
      gcode: tileHeader(name, cell.col, cell.row, plan, opts) + body,
      warnings: clip.warnings,
    });
  }

  return { tiles, plan, warnings };
}
