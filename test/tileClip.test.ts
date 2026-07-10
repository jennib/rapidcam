import { test, expect } from "vitest";
import { generateGCode } from "../src/cam/gcode";
import { CADDocument } from "../src/model/document";
import { RectEntity, CircleEntity, type Bounds } from "../src/model/entities";
import type { CAMOperation } from "../src/cam/types";
import { parseProgram, type GProgram, type GMoveEvent } from "../src/cam/gcodeMotion";
import { clipProgramToTile, clipGCodeToTile } from "../src/cam/tileClip";

const moves = (p: GProgram): GMoveEvent[] =>
  p.events.filter((e): e is GMoveEvent => e.kind === "move");
const raws = (p: GProgram): string[] => p.events.flatMap((e) => (e.kind === "raw" ? [e.text] : []));

const R = (x0: number, y0: number, x1: number, y1: number): Bounds => ({
  min: { x: x0, y: y0 },
  max: { x: x1, y: y1 },
});

const STRAIGHT_CUT = [
  "G21",
  "G90",
  "M3 S1000",
  "G0 Z5",
  "G0 X0 Y10",
  "G1 Z-2 F300",
  "G1 X100 Y10 F1000",
  "G0 Z5",
  "M5",
  "M30",
].join("\n");

test("a cut crossing a seam is clipped to the tile and plunges full-depth at the seam", () => {
  const res = clipGCodeToTile(STRAIGHT_CUT, R(0, 0, 50, 100)); // left tile
  expect(res.hasCuts).toBe(true);

  for (const m of moves(res.program)) {
    if (m.hasX) {
      expect(m.x).toBeLessThanOrEqual(50 + 1e-6);
      expect(m.x).toBeGreaterThanOrEqual(-1e-6);
    }
  }
  // Reaches the seam edge at x=50 with a feed move (so it meets the next tile).
  expect(moves(res.program).some((m) => m.motion === 1 && Math.abs(m.x - 50) < 1e-6)).toBe(true);
  // Full-depth plunge present.
  expect(moves(res.program).some((m) => m.motion === 1 && m.hasZ && Math.abs(m.z + 2) < 1e-6)).toBe(
    true,
  );
  // Setup / spindle / end lines survive untouched.
  expect(raws(res.program)).toEqual(
    expect.arrayContaining(["G21", "G90", "M3 S1000", "M5", "M30"]),
  );
});

test("the neighbouring tile takes the other half, entering at the shared seam", () => {
  const res = clipGCodeToTile(STRAIGHT_CUT, R(50, 0, 100, 100)); // right tile
  expect(res.hasCuts).toBe(true);
  const ms = moves(res.program);
  for (const m of ms) if (m.hasX) expect(m.x).toBeGreaterThanOrEqual(50 - 1e-6);
  // Its cut starts exactly at the seam (x=50).
  const firstRapidXY = ms.find((m) => m.motion === 0 && m.hasX);
  expect(firstRapidXY && Math.abs(firstRapidXY.x - 50) < 1e-6).toBe(true);
});

test("a cut entirely outside the tile leaves no cutting", () => {
  const res = clipGCodeToTile(STRAIGHT_CUT, R(0, 50, 100, 100)); // cut is at y=10
  expect(res.hasCuts).toBe(false);
  expect(moves(res.program).length).toBe(0);
  expect(raws(res.program)).toContain("M30"); // structure still preserved
});

// Real generator output: a rect profile (lines) + a circle profile (arcs).
function sampleProgram(): GProgram {
  const doc = new CADDocument({ width: 300, height: 300 });
  const rect = new RectEntity({ x: 20, y: 20 }, { x: 120, y: 80 });
  const circ = new CircleEntity({ x: 200, y: 150 }, 30);
  doc.entities.push(rect, circ);
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
  const ops: CAMOperation[] = [
    { ...base, id: "p1", type: "profile", entityIds: [rect.id] },
    { ...base, id: "p2", type: "profile", entityIds: [circ.id] },
  ];
  return parseProgram(generateGCode(ops, doc));
}

test("every clipped cut stays within the tile, and arcs are linearized away", () => {
  const rect = R(0, 0, 160, 300); // splits the sheet through the circle
  const res = clipProgramToTile(sampleProgram(), rect);
  expect(res.hasCuts).toBe(true);
  for (const m of moves(res.program)) {
    expect(m.motion === 0 || m.motion === 1).toBe(true); // no G2/G3 survive
    if (m.hasX) {
      expect(m.x).toBeGreaterThanOrEqual(-1e-6);
      expect(m.x).toBeLessThanOrEqual(160 + 1e-6);
    }
  }
});

const DRILL = [
  "G21",
  "G90",
  "M3 S1000",
  "G0 Z5",
  "G0 X30 Y30",
  "G1 Z-5 F200",
  "G0 Z5",
  "M5",
  "M30",
].join("\n");

test("a drill plunge is kept when inside the tile and dropped when outside", () => {
  const inside = clipGCodeToTile(DRILL, R(0, 0, 50, 50));
  expect(inside.hasCuts).toBe(true);
  expect(
    moves(inside.program).some((m) => m.motion === 1 && m.hasZ && Math.abs(m.z + 5) < 1e-6),
  ).toBe(true);

  const outside = clipGCodeToTile(DRILL, R(0, 0, 20, 20));
  expect(outside.hasCuts).toBe(false);
});

test("always lifts the tool before stopping the spindle and at program end", () => {
  const res = clipGCodeToTile(STRAIGHT_CUT, R(0, 0, 50, 100));
  const ms = moves(res.program);
  const last = ms[ms.length - 1];
  expect(last.motion).toBe(0); // a rapid...
  expect(last.hasZ && last.z > 0).toBe(true); // ...to safe Z, not a cut at depth

  const idxM5 = res.program.events.findIndex((e) => e.kind === "raw" && e.text === "M5");
  const before = res.program.events[idxM5 - 1];
  expect(before.kind === "move" && before.motion === 0 && before.z > 0).toBe(true);
});

test("linearizes a partial arc on the correct side (no wrong-way bulge)", () => {
  // Quarter CCW (G3) around the origin from (10,0) to (0,10): must stay in the
  // +x/+y quadrant. A reversed sweep would swing through (0,-10)/(-10,0).
  const g = ["G0 Z5", "G0 X10 Y0", "G1 Z-1 F300", "G3 X0 Y10 I-10 J0 F1000", "G0 Z5", "M30"].join(
    "\n",
  );
  const res = clipGCodeToTile(g, R(-1, -1, 11, 11));
  const cut = moves(res.program).filter((m) => m.motion === 1 && m.hasX);
  expect(cut.length).toBeGreaterThan(3); // fanned into several chords
  for (const m of cut) {
    expect(Math.hypot(m.x, m.y)).toBeCloseTo(10, 1); // on the r=10 circle
    expect(m.x).toBeGreaterThan(-1e-6); // never the wrong way round
    expect(m.y).toBeGreaterThan(-1e-6);
  }
  expect(cut.some((m) => m.x > 6 && m.x < 8 && m.y > 6 && m.y < 8)).toBe(true); // through the 45° region
});

test("a cut lying exactly on a seam is kept by both tiles (harmless double-cut)", () => {
  const g = ["G0 Z5", "G0 X0 Y50", "G1 Z-1 F300", "G1 X100 Y50 F1000", "G0 Z5", "M30"].join("\n");
  expect(clipGCodeToTile(g, R(0, 0, 100, 50)).hasCuts).toBe(true);
  expect(clipGCodeToTile(g, R(0, 50, 100, 100)).hasCuts).toBe(true);
});

test("warns when a toolpath varies continuously in Z", () => {
  const g = [
    "G0 Z5",
    "G0 X0 Y0",
    "G1 Z-1 F300",
    "G1 X10 Y0 Z-2 F1000",
    "G1 X20 Y0 Z-3",
    "G0 Z5",
  ].join("\n");
  const res = clipGCodeToTile(g, R(-5, -5, 30, 30));
  expect(res.warnings.length).toBeGreaterThan(0);
  expect(res.warnings[0]).toMatch(/varies continuously in Z/);
});
