import { test, expect } from "vitest";
import { generateGCode } from "../src/cam/gcode";
import { CADDocument } from "../src/model/document";
import { RectEntity } from "../src/model/entities";
import type { CAMOperation } from "../src/cam/types";
import { parseProgram, type GProgram, type GMoveEvent } from "../src/cam/gcodeMotion";
import { stitchGCode } from "../src/cam/stitch";

const cutMoves = (p: GProgram): GMoveEvent[] =>
  p.events.filter((e): e is GMoveEvent => e.kind === "move" && e.motion !== 0);
const allMoves = (p: GProgram): GMoveEvent[] =>
  p.events.filter((e): e is GMoveEvent => e.kind === "move");

const base = {
  name: "t",
  toolType: "end-mill" as const,
  side: "outside" as const,
  toolNumber: 1,
  diameter: 6,
  feedrate: 1000,
  plungeRate: 300,
  spindleSpeed: 18000,
  safeZ: 5,
  depth: -3,
  stepdown: 1.5,
  stepover: 0.4,
};

/** Outside profile of one rectangle spanning `x0..x1`, `y0..y1`. */
function rectProfileGCode(x0: number, y0: number, x1: number, y1: number): string {
  const doc = new CADDocument({ width: 400, height: 400 });
  const rect = new RectEntity({ x: x0, y: y0 }, { x: x1, y: y1 });
  doc.entities.push(rect);
  const op: CAMOperation = { ...base, id: "p1", type: "profile", entityIds: [rect.id] };
  return generateGCode([op], doc);
}

test("splits a design wider than the bed into tiles, each in its own local origin", () => {
  const g = rectProfileGCode(20, 20, 280, 80); // ~266mm wide toolpath
  const res = stitchGCode(g, { tileW: 150, tileH: 150, name: "sign" });

  expect(res.plan?.cols).toBe(2);
  expect(res.plan?.rows).toBe(1);
  expect(res.tiles).toHaveLength(2);

  for (const tile of res.tiles) {
    expect(tile.gcode.startsWith("; RapidCAM Stitch")).toBe(true);
    const cuts = cutMoves(parseProgram(tile.gcode));
    expect(cuts.length).toBeGreaterThan(0); // each tile actually cuts something
    for (const m of cuts) {
      // Local coordinates: everything fits within the bed from origin (0,0).
      if (m.hasX) {
        expect(m.x).toBeGreaterThanOrEqual(-1e-6);
        expect(m.x).toBeLessThanOrEqual(150 + 1e-6);
      }
      if (m.hasY) {
        expect(m.y).toBeGreaterThanOrEqual(-1e-6);
        expect(m.y).toBeLessThanOrEqual(150 + 1e-6);
      }
    }
  }
  expect(res.tiles.map((t) => t.name)).toEqual(["sign_c1_r1", "sign_c2_r1"]);
});

test("emits shared dowel holes into both tiles at the seam (in each tile's local coords)", () => {
  const g = rectProfileGCode(20, 20, 280, 80);
  const res = stitchGCode(g, {
    tileW: 150,
    tileH: 150,
    registration: "holes",
    registrationOptions: { holeDepth: 4 }, // distinct from the -3 cut depth
  });
  expect(res.tiles).toHaveLength(2);

  for (const tile of res.tiles) {
    expect(tile.gcode).toContain("Stitch registration (holes)");
    const holes = allMoves(parseProgram(tile.gcode)).filter(
      (m) => m.motion === 1 && m.hasZ && Math.abs(m.z + 4) < 1e-6,
    );
    expect(holes).toHaveLength(2); // two features on the shared seam
  }
  // The seam (world x=167) lands at the right tile's left edge (x≈0) and the
  // left tile's right edge (x≈150).
  const left = res.tiles.find((t) => t.col === 0)!;
  const right = res.tiles.find((t) => t.col === 1)!;
  const rapidXs = (t: typeof left) =>
    allMoves(parseProgram(t.gcode))
      .filter((m) => m.motion === 0 && m.hasX)
      .map((m) => m.x);
  expect(rapidXs(left).some((x) => Math.abs(x - 150) < 0.5)).toBe(true);
  expect(rapidXs(right).some((x) => Math.abs(x - 0) < 0.5)).toBe(true);
});

test("registration defaults to none, and crosshairs scribe instead of drilling", () => {
  const g = rectProfileGCode(20, 20, 280, 80);
  expect(stitchGCode(g, { tileW: 150, tileH: 150 }).tiles[0].gcode).not.toContain(
    "Stitch registration",
  );

  const cross = stitchGCode(g, { tileW: 150, tileH: 150, registration: "crosshairs" });
  expect(cross.tiles[0].gcode).toContain("Stitch registration (crosshairs)");
});

test("a design that already fits the bed comes back as a single unchanged file", () => {
  const g = rectProfileGCode(20, 20, 120, 80);
  const res = stitchGCode(g, { tileW: 300, tileH: 300 });
  expect(res.tiles).toHaveLength(1);
  expect(res.tiles[0].gcode).toBe(g); // untouched
});

test("refuses to tile programs with motions it can't clip (G5), with a clear warning", () => {
  const res = stitchGCode("G1 X0 Y0 F100\nG5 X1 Y2 I1 J2 P3 Q4\nG1 X200 Y0", {
    tileW: 150,
    tileH: 150,
  });
  expect(res.tiles).toEqual([]);
  expect(res.warnings[0]).toMatch(/can't tile/);
});

test("reports when there is nothing to cut", () => {
  const res = stitchGCode("G21\nG90\nM5\nM30", { tileW: 150, tileH: 150 });
  expect(res.tiles).toEqual([]);
  expect(res.warnings[0]).toMatch(/no cutting/);
});
