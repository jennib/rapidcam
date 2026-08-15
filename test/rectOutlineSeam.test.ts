import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { RectEntity } from "../src/model/entities";

/**
 * The seam parametric corners will hang off.
 *
 * `RectEntity.corners()` returns four points. Fifteen CAM call sites used to
 * rebuild a rectangle out of those four as straight segments, so giving a
 * rectangle a corner radius would have left every toolpath cutting square
 * corners while the canvas drew round ones — the drawing and the program
 * disagreeing, which is the worst failure this app has available to it.
 *
 * `outlinePoints()` is now the one place a rectangle becomes a boundary. It
 * returns exactly `corners()` today, which is what made the migration provable:
 * the whole suite passed unchanged.
 *
 * These two tests are what keep it that way — one pins the contract, one stops
 * the assumption creeping back into CAM.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CAM_DIR = join(here, "..", "src", "cam");

test("outlinePoints is the corner ring while no radius exists", () => {
  const r = new RectEntity({ x: 10, y: 20 }, { x: 60, y: 50 });
  expect(r.outlinePoints()).toEqual(r.corners());
  // CCW from bottom-left — the winding every CAM consumer relies on.
  expect(r.outlinePoints()).toEqual([
    { x: 10, y: 20 },
    { x: 60, y: 20 },
    { x: 60, y: 50 },
    { x: 10, y: 50 },
  ]);
});

test("no CAM file rebuilds a rectangle from corners()", () => {
  const offenders: string[] = [];
  for (const f of readdirSync(CAM_DIR).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(CAM_DIR, f), "utf8");
    // The exact shape that was migrated: spreading the four corners into a ring.
    if (/\[\s*\.\.\.\s*\w+\.corners\(\)\s*\]/.test(src)) offenders.push(f);
  }

  expect(
    offenders,
    `these treat a rectangle as four straight segments — use outlinePoints() so ` +
      `corner radii reach the toolpath: ${offenders.join(", ")}`,
  ).toEqual([]);

  // Positive control: the pattern this searches for is one the regex really
  // does catch, so an empty result means "none left" and not "never matched".
  expect(/\[\s*\.\.\.\s*\w+\.corners\(\)\s*\]/.test("const a = [...ent.corners()];")).toBe(true);
});
