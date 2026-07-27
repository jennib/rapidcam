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

function profileOp(
  id: string,
  entityIds: string[],
  opts: Partial<CAMOperation> = {},
): CAMOperation {
  return {
    id,
    name: `profile ${id}`,
    type: "profile",
    side: "outside",
    entityIds,
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 6,
    feedrate: 1000,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -2,
    stepdown: 2,
    stepover: 0.4,
    ...opts,
  };
}

/** Motion lines (drop comments/blank/M/G-setup) for structural assertions. */
function motions(code: string): string[] {
  return code
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^G[0-3]\b/.test(l));
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
  expect(wrapped[0]).toBe("G21 ; metric"); // passthrough
  expect(wrapped[1]).toBe("G0 Z5"); // no wrapped axis → untouched
  expect(wrapped[2]).toBe("G0 X10 A20"); // Y20 → A20
  expect(wrapped[3]).toBe("G1 Z-1 F300"); // plunge untouched
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
  expect(wrapped).not.toMatch(/\bG[23]\b/); // no arcs survive the wrap
  const cut = motions(wrapped).filter((l) => l.startsWith("G1"));
  expect(cut.length).toBeGreaterThan(1); // flattened to several chords
  expect(cut[0]).toMatch(/F800/); // feed carried onto the first chord
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
  expect(program).toMatch(/dia 100mm/);
  expect(program).not.toMatch(/\bG[23]\b/); // the circle's G2 arcs are all linearised
  // The A words are real numbers within a full turn's worth of degrees.
  const aVals = [...program.matchAll(/A(-?[\d.]+)/g)].map((m) => parseFloat(m[1]));
  expect(aVals.length).toBeGreaterThan(4);
  expect(Math.max(...aVals)).toBeLessThanOrEqual(360.001);
});

test("banner emits a diameter token that gSender's rotary parser matches", () => {
  // gSender (Visualize.worker.ts) reads the cylinder diameter from a comment to
  // wrap the preview. If our token drifts out of its accepted shape, gSender
  // silently falls back to a flat view. This locks our output to gSender's real
  // regexes (copied verbatim from that file) so a reword can't break it unnoticed.
  const GSENDER_PATTERNS = [
    /Cylinder\s*Dia\s*:\s*([0-9.+-]+)/i,
    /Cylinder\s*Dia(?:meter)?\s*[=:]\s*([0-9]+[.,][0-9]+|[0-9]+)/i,
    /(?:Cylinder\s+)?Dia(?:meter)?\s*[=:]\s*([0-9]+[.,][0-9]+|[0-9]+)/i,
  ];
  const doc = new CADDocument({ width: 200, height: 100 });
  doc.stockThickness = 20;
  const c = doc.add(new CircleEntity({ x: 100, y: 50 }, 30));
  doc.operations = [profileOp("p", [c.id], { side: "outside", depth: -5 })];
  doc.rotary = { axisWord: "A", diameter: 63.5, wrapAxis: "y" }; // 2.5" — a decimal ⌀

  const { program } = generateRotaryProgram(doc);
  // The first gSender pattern to hit must recover our real diameter (63.5mm).
  let parsed: number | null = null;
  for (const re of GSENDER_PATTERNS) {
    const m = program.match(re);
    if (m) {
      parsed = Number(m[1].replace(",", "."));
      break;
    }
  }
  expect(parsed).toBeCloseTo(63.5, 3);
});

test("a rotary job is surface-zeroed even if origin.z is 'bed' (no radial-wall Z shift)", () => {
  // A cylinder has no bed. An errant bed Z-origin (old file / saved default) must
  // NOT shift Z by the wall — that would post cuts high and cut air, while the
  // banner still promises "Z0 = top". resolveOrigin forces surface-zero here.
  const mk = (z: "top" | "bed") => {
    const doc = new CADDocument({ width: 200, height: 100 });
    doc.machineKind = "mill-rotary";
    doc.stockThickness = 20; // radial wall
    doc.origin = { x: "left", y: "front", z };
    doc.rotary = { axisWord: "A", diameter: 100, wrapAxis: "y" };
    const c = doc.add(new CircleEntity({ x: 100, y: 50 }, 25));
    doc.operations = [profileOp("p", [c.id], { side: "outside", depth: -4, stepdown: 2 })];
    return generateRotaryProgram(doc).program;
  };
  const bed = mk("bed");
  // Z words are identical to the top-zeroed program (no +20 wall offset)…
  const zOf = (g: string) => [...g.matchAll(/\bZ(-?[\d.]+)/g)].map((m) => m[1]);
  expect(zOf(bed)).toEqual(zOf(mk("top")));
  // …the deepest cut is the authored depth, not depth+wall…
  expect(Math.min(...zOf(bed).map(Number))).toBeCloseTo(-4, 6);
  // …and the header stays honest about surface zero.
  expect(bed).toMatch(/Z0 is the TOP of the cylinder/);
  expect(bed).not.toMatch(/Bed \(top at Z=/);
});

test("centre-zeroing lifts every emitted Z by the radius, leaving X/A/F untouched", () => {
  const s: RotarySettings = { axisWord: "A", diameter: 100, wrapAxis: "y", zero: "center" };
  const flat = ["G0 Z5", "G0 X10 Y20", "G1 Z-2 F300", "G1 X30 Y20 F1000"].join("\n");
  const out = wrapGCode(flat, s);
  // radius = 50: the retract 5 → 55, the plunge -2 → 48.
  expect(out).toContain("G0 Z55");
  expect(out).toContain("Z48");
  // Only Z changes vs a surface wrap — the wrapped word, linear axis and feeds match.
  const surf = wrapGCode(flat, { ...s, zero: "surface" });
  const stripZ = (g: string) => g.replace(/ ?Z-?[\d.]+/g, "");
  expect(stripZ(out)).toBe(stripZ(surf));
});

test("centre-zeroed program: Z0 at rotary centre, cuts lifted by R, no gSender toggle token", () => {
  const mk = (zero: "surface" | "center") => {
    const doc = new CADDocument({ width: 200, height: 100 });
    doc.machineKind = "mill-rotary";
    doc.rotary = { axisWord: "A", diameter: 100, wrapAxis: "y", zero };
    const c = doc.add(new CircleEntity({ x: 100, y: 50 }, 25));
    doc.operations = [profileOp("p", [c.id], { side: "outside", depth: -4, stepdown: 2 })];
    return generateRotaryProgram(doc).program;
  };
  const center = mk("center");
  const surface = mk("surface");
  // The banner reflects the centre reference and drops the surface-zero visualizer hint.
  expect(center).toMatch(/Z0 is the ROTARY CENTRE/);
  expect(center).not.toMatch(/Cylinder Dia:/);
  expect(center).not.toMatch(/Visualize non-center zeros/);
  expect(surface).toMatch(/Cylinder Dia:/);
  // Every cut Z is lifted by the radius (50): deepest cut -4 → 46. (Motion lines
  // only — the banner's "Z0 is the …" comment must not count.)
  const zMin = (g: string) =>
    Math.min(
      ...g
        .split("\n")
        .filter((l) => !l.trimStart().startsWith(";"))
        .flatMap((l) => [...l.matchAll(/\bZ(-?[\d.]+)/g)].map((m) => Number(m[1]))),
    );
  expect(zMin(surface)).toBeCloseTo(-4, 6);
  expect(zMin(center)).toBeCloseTo(46, 6);
});

test("generateRotaryProgram falls back to default settings when doc.rotary is null", () => {
  // A rotary machine (machineKind) with no per-job cylinder yet — the new-project
  // path — must still wrap, using a stock-derived default diameter.
  const doc = new CADDocument({ width: 200, height: 100 });
  doc.machineKind = "mill-rotary";
  const c = doc.add(new CircleEntity({ x: 100, y: 50 }, 20));
  doc.operations = [profileOp("p", [c.id], { side: "outside", depth: -3 })];
  expect(doc.rotary).toBeNull();

  const { program } = generateRotaryProgram(doc);
  expect(program).toMatch(/Rotary \/ cylindrical wrap/);
  expect(program).not.toMatch(/\bG[23]\b/);
  expect([...program.matchAll(/A(-?[\d.]+)/g)].length).toBeGreaterThan(0);
});

// --- inverse-time feed (G93) -------------------------------------------------

test("inverse-time feed: F = surface-feed ÷ path-length, framed by G93 … G94", () => {
  const flat = [
    "G90",
    "G0 X0 Y0",
    "G1 Z-2 F300", // plunge, length 2mm  → F = 300/2  = 150
    "G1 X30 Y0 F1200", // pure length move 30mm → F = 1200/30 = 40
    "G1 X30 Y40", // modal feed 1200, wrapped move 40mm → F = 1200/40 = 30
    "M5",
    "M30",
  ].join("\n");
  const w = wrapGCode(flat, UNIT, { inverseTimeFeed: true }).split("\n");

  const iG93 = w.findIndex((l) => /^G93\b/.test(l));
  const iG94 = w.findIndex((l) => /^G94\b/.test(l));
  const iM30 = w.findIndex((l) => /^M30\b/.test(l));
  expect(iG93).toBeGreaterThanOrEqual(0);
  expect(iG94).toBeGreaterThan(iG93); // restored…
  expect(iG94).toBeLessThan(iM30); // …before program end

  expect(w).toContain("G1 Z-2 F150"); // plunge inverse-time
  expect(w.find((l) => l.startsWith("G1 X30 A0"))).toMatch(/\bF40\b/); // length move
  expect(w.find((l) => l.startsWith("G1 X30 A40"))).toMatch(/\bF30\b/); // wrapped move
});

test("inverse-time feed: every arc chord carries its own F", () => {
  const flat = ["G0 X5 Y0", "G1 Z-1 F200", "G3 X0 Y5 I-5 J0 F600", "M30"].join("\n");
  const w = wrapGCode(flat, UNIT, { inverseTimeFeed: true });
  const chords = w.split("\n").filter((l) => /^G1 /.test(l) && /A-?[\d.]/.test(l));
  expect(chords.length).toBeGreaterThan(1); // arc was flattened
  expect(chords.every((l) => /\bF[\d.]+/.test(l))).toBe(true); // each chord commands a feed
  expect(w).toMatch(/^G93\b/m);
  expect(w).toMatch(/^G94\b/m);
});

test("default (no option) leaves feeds as authored mm/min — no G93", () => {
  const flat = ["G0 X0 Y0", "G1 X30 Y0 F1200", "M30"].join("\n");
  const w = wrapGCode(flat, UNIT);
  expect(w).not.toMatch(/G9[34]\b/);
  expect(w).toContain("G1 X30 A0 F1200"); // untouched authored feed
});

test("generateRotaryProgram emits inverse-time feed (G93 … G94 before M30)", () => {
  const doc = new CADDocument({ width: 200, height: 100 });
  const c = doc.add(new CircleEntity({ x: 100, y: 50 }, 30));
  doc.machineKind = "mill-rotary";
  doc.rotary = { axisWord: "A", diameter: 100, wrapAxis: "y" };
  doc.operations = [profileOp("p", [c.id], { depth: -3 })];

  const { program } = generateRotaryProgram(doc);
  const lines = program.split("\n");
  expect(program).toMatch(/^G93\b/m);
  expect(program).toMatch(/^G94\b/m);
  expect(lines.findIndex((l) => /^G94\b/.test(l))).toBeLessThan(
    lines.findIndex((l) => /^M30\b/.test(l)),
  );
  // Every wrapped feed move commands a feed (inverse-time is per-move).
  const cutMoves = lines.filter((l) => /^G1 /.test(l) && /A-?[\d.]/.test(l));
  expect(cutMoves.length).toBeGreaterThan(4);
  expect(cutMoves.every((l) => /\bF[\d.]+/.test(l))).toBe(true);
});

// --- validation --------------------------------------------------------------

test("validateRotary flags overlap past one full turn", () => {
  const doc = new CADDocument({ width: 200, height: 100 });
  doc.rotary = { axisWord: "A", diameter: 10, wrapAxis: "y" }; // circ ≈31.4 « 100mm tall
  const w = validateRotary(doc);
  expect(w.some((m) => /past one full wrap|overlap/i.test(m))).toBe(true);
});

test("validateRotary flags a bad diameter and a flip clash", () => {
  const doc = new CADDocument({ width: 200, height: 100 });
  doc.rotary = { axisWord: "A", diameter: 0, wrapAxis: "y" };
  expect(validateRotary(doc).some((m) => /diameter/i.test(m))).toBe(true);

  doc.flip = { axis: "h", registration: "none", pinDiameter: 6, pinDepth: 4, pins: [] };
  doc.rotary = { axisWord: "A", diameter: 40, wrapAxis: "y" };
  expect(validateRotary(doc).some((m) => /flip/i.test(m))).toBe(true);
});

test("a beam machine on the rotary is NOT rejected — laser rotary is supported", () => {
  const doc = new CADDocument({ width: 200, height: 100 });
  doc.rotary = { axisWord: "A", diameter: 100 / Math.PI, wrapAxis: "y" };
  doc.machineKind = "laser-rotary";
  // Used to warn "Rotary wrap is mill-only"; a laser rotary now substitutes the
  // wrapped axis instead of wrapping it (rotaryOutput), so there is nothing wrong.
  expect(validateRotary(doc)).toEqual([]);
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

test("the JOB half of rotary settings round-trips; the machine half is not stored", () => {
  const doc = new CADDocument({ width: 200, height: 100 });
  doc.rotary = { axisWord: "B", diameter: 63.5, wrapAxis: "x", zero: "center", arcTolerance: 0.05 };
  const file = serializeDoc(doc, "wrap");

  // The cylinder IS the stock, so diameter/wrapAxis/zero are the design. The
  // axis word and arc tolerance describe the machine and left the file in v3
  // (SETTINGS_MODEL.md) — generateRotaryProgram supplies them from the profile.
  expect(file.rotary).toEqual({ diameter: 63.5, wrapAxis: "x", zero: "center" });

  const doc2 = new CADDocument({ width: 10, height: 10 });
  applyFile(doc2, file);
  expect(doc2.rotary).toMatchObject({ diameter: 63.5, wrapAxis: "x", zero: "center" });
  expect(doc2.rotary?.arcTolerance).toBeUndefined();
});

test("a flat document serializes without a rotary key", () => {
  const doc = new CADDocument({ width: 200, height: 100 });
  const file = serializeDoc(doc, "flat") as unknown as Record<string, unknown>;
  expect("rotary" in file).toBe(false);
});
