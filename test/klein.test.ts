import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { CircleEntity } from "../src/model/entities";
import { serializeDoc, applyFile } from "../src/io/fileio";
import type { CAMOperation } from "../src/cam/types";
import type { RotarySettings } from "../src/model/document";
import {
  wrapAngleDeg,
  circumference,
  flattenArc,
  wrapGCode,
  validateRotary,
  generateRotaryProgram,
  defaultRotarySettings,
} from "../src/cam/klein";

// A cylinder whose circumference is exactly 360mm, so 1mm of surface = 1° of
// rotation and A === Y numerically — keeps wrap assertions trivially readable.
const UNIT: RotarySettings = { axisWord: "A", diameter: 360 / Math.PI, wrapAxis: "y" };

function profileOp(id: string, entityIds: string[], opts: Partial<CAMOperation> = {}): CAMOperation {
  return {
    id, name: `profile ${id}`, type: "profile", side: "outside", entityIds,
    toolType: "end-mill", toolNumber: 1, diameter: 6,
    feedrate: 1000, plungeRate: 300, spindleSpeed: 18000,
    safeZ: 5, depth: -2, stepdown: 2, stepover: 0.4, ...opts,
  };
}

/** Motion lines (drop comments/blank/M/G-setup) for structural assertions. */
function motions(code: string): string[] {
  return code.split("\n").map((l) => l.trim()).filter((l) => /^G[0-3]\b/.test(l));
}

// --- wrap math ---------------------------------------------------------------

test("wrapAngleDeg maps one circumference to 360° and is cumulative (no mod)", () => {
  expect(circumference(UNIT)).toBeCloseTo(360, 6);
  expect(wrapAngleDeg(0, UNIT)).toBeCloseTo(0, 6);
  expect(wrapAngleDeg(90, UNIT)).toBeCloseTo(90, 6);
  expect(wrapAngleDeg(360, UNIT)).toBeCloseTo(360, 6);
  expect(wrapAngleDeg(540, UNIT)).toBeCloseTo(540, 6); // past a full turn → spirals, not folded
});

test("a bigger diameter turns less per mm", () => {
  const big: RotarySettings = { axisWord: "A", diameter: 720 / Math.PI, wrapAxis: "y" };
  expect(wrapAngleDeg(360, big)).toBeCloseTo(180, 6); // circumference 720 → half a turn
});

// --- linear wrapping ---------------------------------------------------------

test("wrapGCode swaps only the wrapped word and preserves X/Z/F, comments, and non-motion lines", () => {
  const flat = [
    "G21 ; metric",
    "G0 Z5",
    "G0 X10 Y20",
    "G1 Z-1 F300",
    "G1 X30 Y20 F1000 ; cut",
    "G1 X30 Y50",
    "M5",
  ].join("\n");
  const wrapped = wrapGCode(flat, UNIT).split("\n");
  expect(wrapped[0]).toBe("G21 ; metric");     // passthrough
  expect(wrapped[1]).toBe("G0 Z5");            // no wrapped axis → untouched
  expect(wrapped[2]).toBe("G0 X10 A20");       // Y20 → A20
  expect(wrapped[3]).toBe("G1 Z-1 F300");      // plunge untouched
  expect(wrapped[4]).toBe("G1 X30 A20 F1000 ; cut"); // comment kept
  expect(wrapped[5]).toBe("G1 X30 A50");
  expect(wrapped[6]).toBe("M5");
});

test("wrapAxis 'x' wraps X instead and leaves Y linear", () => {
  const s: RotarySettings = { axisWord: "B", diameter: 360 / Math.PI, wrapAxis: "x" };
  const out = wrapGCode("G1 X30 Y40 F500", s);
  expect(out).toBe("G1 B30 Y40 F500"); // X→B emitted in source word order, Y stays linear
});

// --- arc flattening ----------------------------------------------------------

test("flattenArc walks a quarter CCW arc to the exact endpoint on-radius", () => {
  const pts = flattenArc(5, 0, 0, 5, 0, 0, /*cw*/ false, 0.1);
  expect(pts.length).toBeGreaterThan(1);
  for (const p of pts) expect(Math.hypot(p.x, p.y)).toBeCloseTo(5, 6); // stays on the circle
  const last = pts[pts.length - 1];
  expect(last.x).toBeCloseTo(0, 9);
  expect(last.y).toBeCloseTo(5, 9); // lands exactly on the commanded end
});

test("flattenArc treats a start==end sweep as a full turn", () => {
  const pts = flattenArc(5, 0, 5, 0, 0, 0, /*cw*/ false, 0.1);
  // Full circle → last point back at the start, several chords around.
  expect(pts.length).toBeGreaterThan(8);
  const last = pts[pts.length - 1];
  expect(last.x).toBeCloseTo(5, 9);
  expect(last.y).toBeCloseTo(0, 9);
});

test("wrapGCode linearises G2/G3 into G1 chords carrying the rotary word", () => {
  const flat = ["G0 X5 Y0", "G3 X0 Y5 I-5 J0 F800"].join("\n");
  const wrapped = wrapGCode(flat, UNIT);
  expect(wrapped).not.toMatch(/\bG[23]\b/);           // no arcs survive the wrap
  const cut = motions(wrapped).filter((l) => l.startsWith("G1"));
  expect(cut.length).toBeGreaterThan(1);              // flattened to several chords
  expect(cut[0]).toMatch(/F800/);                     // feed carried onto the first chord
  expect(cut.every((l) => /A[-\d.]+/.test(l))).toBe(true); // every chord commands the rotary axis
  const end = cut[cut.length - 1];
  expect(parseFloat(end.match(/A([-\d.]+)/)![1])).toBeCloseTo(5, 3); // Y5 → A5
});

// --- end-to-end --------------------------------------------------------------

test("generateRotaryProgram wraps a real circle profile: banner, no arcs, resolves diameter", () => {
  const doc = new CADDocument({ width: 200, height: 100 });
  doc.stockThickness = 20;
  const c = doc.add(new CircleEntity({ x: 100, y: 50 }, 30));
  doc.operations = [profileOp("p", [c.id], { side: "outside", depth: -5 })];
  doc.rotary = { axisWord: "A", diameter: 100, wrapAxis: "y" };

  const { program } = generateRotaryProgram(doc);
  expect(program).toMatch(/Rotary \/ cylindrical wrap/);
  expect(program).toMatch(/⌀100mm/);
  expect(program).not.toMatch(/\bG[23]\b/); // the circle's G2 arcs are all linearised
  // The A words are real numbers within a full turn's worth of degrees.
  const aVals = [...program.matchAll(/A(-?[\d.]+)/g)].map((m) => parseFloat(m[1]));
  expect(aVals.length).toBeGreaterThan(4);
  expect(Math.max(...aVals)).toBeLessThanOrEqual(360.001);
});

// --- validation --------------------------------------------------------------

test("validateRotary flags overlap past one full turn", () => {
  const doc = new CADDocument({ width: 200, height: 100 });
  doc.rotary = { axisWord: "A", diameter: 10, wrapAxis: "y" }; // circ ≈31.4 « 100mm tall
  const w = validateRotary(doc);
  expect(w.some((m) => /past one full wrap|overlap/i.test(m))).toBe(true);
});

test("validateRotary flags a bad diameter, laser mode, and a flip clash", () => {
  const doc = new CADDocument({ width: 200, height: 100 });
  doc.rotary = { axisWord: "A", diameter: 0, wrapAxis: "y" };
  expect(validateRotary(doc).some((m) => /diameter/i.test(m))).toBe(true);

  doc.rotary = { axisWord: "A", diameter: 40, wrapAxis: "y" };
  doc.machineKind = "laser";
  expect(validateRotary(doc).some((m) => /mill-only/i.test(m))).toBe(true);
  doc.machineKind = "mill";

  doc.flip = { axis: "h", registration: "none", pinDiameter: 6, pinDepth: 4, pins: [] };
  expect(validateRotary(doc).some((m) => /flip/i.test(m))).toBe(true);
});

test("a clean setup validates with no warnings", () => {
  const doc = new CADDocument({ width: 200, height: 100 });
  doc.rotary = { axisWord: "A", diameter: 100 / Math.PI, wrapAxis: "y" }; // circ = 100 = height
  expect(validateRotary(doc)).toEqual([]);
});

test("defaultRotarySettings makes the design span exactly one wrap", () => {
  const doc = new CADDocument({ width: 200, height: 100 });
  const s = defaultRotarySettings(doc);
  // circumference ≈ height, so a full-height design wraps ~once (no overlap warning).
  expect(circumference(s)).toBeCloseTo(100, 0);
  doc.rotary = s;
  expect(validateRotary(doc)).toEqual([]);
});

// --- persistence -------------------------------------------------------------

test("rotary settings round-trip through .rcam serialize/apply", () => {
  const doc = new CADDocument({ width: 200, height: 100 });
  doc.rotary = { axisWord: "B", diameter: 63.5, wrapAxis: "x", arcTolerance: 0.05 };
  const file = serializeDoc(doc, "wrap");

  const doc2 = new CADDocument({ width: 10, height: 10 });
  applyFile(doc2, file);
  expect(doc2.rotary).toEqual(doc.rotary);
});

test("a flat document serializes without a rotary key", () => {
  const doc = new CADDocument({ width: 200, height: 100 });
  const file = serializeDoc(doc, "flat") as Record<string, unknown>;
  expect("rotary" in file).toBe(false);
});
