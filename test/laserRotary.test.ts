/**
 * Laser on a rotary: the beam head combined with cylinder stock. The wrapped axis
 * is SUBSTITUTED (left as a linear word in surface mm) rather than wrapped to A
 * degrees — see cam/klein.ts `rotaryOutput` for why (GRBL has no 4th axis).
 */
import { expect, test } from "vitest";
import { generateRotaryProgram, rotaryOutput, wrapGCode, validateRotary } from "../src/cam/klein";
import { generateGCode } from "../src/cam/gcode";
import {
  CADDocument,
  isLaser,
  isRotary,
  MACHINE_KINDS,
  type MachineKind,
  type RotarySettings,
} from "../src/model/document";
import { CircleEntity } from "../src/model/entities";
import type { CAMOperation } from "../src/cam/types";
import { applyFile, serializeDoc } from "../src/io/fileio";

const CYL: RotarySettings = { axisWord: "A", diameter: 80, wrapAxis: "y" };
const CIRC = Math.PI * 80; // 251.327mm — one revolution of surface

function laserCutOp(entityIds: string[]): CAMOperation {
  return {
    id: "op1",
    name: "cut",
    type: "profile",
    side: "outside",
    entityIds,
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 0,
    feedrate: 1200,
    plungeRate: 300,
    spindleSpeed: 0,
    safeZ: 5,
    depth: -1,
    stepdown: 1,
    stepover: 0.4,
    laserPower: 80,
    laserPasses: 1,
  };
}

/** A laser-rotary document with one circle to cut. */
function laserRotaryDoc(): CADDocument {
  const doc = new CADDocument({ width: 200, height: CIRC });
  doc.machineKind = "laser-rotary";
  doc.rotary = { ...CYL };
  const c = doc.add(new CircleEntity({ x: 100, y: CIRC / 2 }, 30));
  doc.operations = [laserCutOp([c.id])];
  return doc;
}

test("the machine-kind predicates split head from stock", () => {
  const heads: [MachineKind, boolean, boolean][] = [
    // kind, isLaser, isRotary
    ["mill", false, false],
    ["laser", true, false],
    ["mill-rotary", false, true],
    ["laser-rotary", true, true],
  ];
  for (const [kind, laser, rotary] of heads) {
    expect(isLaser(kind), kind).toBe(laser);
    expect(isRotary(kind), kind).toBe(rotary);
  }
  // Every kind is offered in the pickers — a new one can't be added and hidden.
  expect(MACHINE_KINDS.map(([k]) => k).sort()).toEqual(
    ["laser", "laser-rotary", "mill", "mill-rotary"].sort(),
  );
});

test("a laser rotary uses the cylinder stock model, like a milled one", () => {
  const doc = laserRotaryDoc();
  expect(doc.isLaser).toBe(true);
  expect(doc.isRotary).toBe(true);
  expect(doc.stock).toMatchObject({ kind: "cylinder", length: 200 });
  expect((doc.stock as { diameter: number }).diameter).toBeCloseTo(80, 6);
});

test("output is substituted for a beam and a rotary word for a spindle", () => {
  const doc = laserRotaryDoc();
  expect(rotaryOutput(doc)).toBe("linear-substitute");
  doc.machineKind = "mill-rotary";
  expect(rotaryOutput(doc)).toBe("rotary-word");
});

test("a laser rotary posts the FLAT beam program — no A word, wrapped axis in surface mm", () => {
  const doc = laserRotaryDoc();
  const { program, warnings } = generateRotaryProgram(doc);
  expect(warnings).toEqual([]);

  const motion = program
    .split("\n")
    .filter((l) => /^G[0-3]\b/.test(l.trim()))
    .map((l) => l.trim());
  expect(motion.length).toBeGreaterThan(1);
  // No 4th-axis word anywhere: GRBL would reject it outright.
  expect(motion.some((l) => /\b[AB]-?[\d.]/.test(l))).toBe(false);
  // Nor inverse-time feed, which belongs to combined linear+rotary moves.
  expect(program).not.toMatch(/\bG93\b/);
  // Still a beam program: power commanded, no Z, and arcs left as arcs (nothing
  // linearises them, because nothing wrapped them).
  expect(program).toMatch(/^M4 S\d+/m);
  expect(motion.some((l) => /\bZ-?[\d.]/.test(l))).toBe(false);
  expect(motion.some((l) => /^G[23]\b/.test(l))).toBe(true);

  // Body is byte-identical to the ordinary flat laser program: substitution is a
  // no-op transform by design — the canvas is already in surface millimetres.
  const flat = generateGCode(doc.operations, doc, {});
  expect(program.endsWith(flat)).toBe(true);
});

test("the banner tells the operator what one revolution must measure", () => {
  const { program } = generateRotaryProgram(laserRotaryDoc());
  expect(program).toMatch(/axis substitution/i);
  expect(program).toMatch(/SURFACE MILLIMETRES, NOT DEGREES/);
  // The number the rotary's steps/mm has to be derived from.
  expect(program).toMatch(new RegExp(`one revolution = ${CIRC.toFixed(3)}mm of Y travel`));
  // G-code must be ASCII, so toAsciiGcode transliterates the banner's symbols.
  expect(program).toMatch(/dia 80mm/);
  expect([...program].find((ch) => ch.charCodeAt(0) > 127)).toBeUndefined();
  // Mill-only advice must not leak into a beam program.
  expect(program).not.toMatch(/Cylinder Dia:/); // gSender's 4th-axis visualiser token
  expect(program).not.toMatch(/touch the tool off/i);
});

test("a milled rotary still wraps to degrees (the laser change didn't disturb it)", () => {
  const doc = laserRotaryDoc();
  doc.machineKind = "mill-rotary";
  doc.operations[0] = { ...doc.operations[0], diameter: 3, spindleSpeed: 18000 };
  const { program } = generateRotaryProgram(doc);
  expect(program).toMatch(/Rotary \/ cylindrical wrap/);
  expect(program).toMatch(/\bA-?[\d.]/);
  expect(program).toMatch(/\bG93\b/);
});

test("laser-rotary round-trips through save/load", () => {
  const doc = laserRotaryDoc();
  const doc2 = new CADDocument({ width: 1, height: 1 });
  applyFile(doc2, serializeDoc(doc, "lr"));
  expect(doc2.machineKind).toBe("laser-rotary");
  expect(doc2.isLaser && doc2.isRotary).toBe(true);
  expect(doc2.rotary).toMatchObject({ diameter: 80, wrapAxis: "y" });
});

test("a rotary laser document is not rejected by the pre-flight advisories", () => {
  expect(validateRotary(laserRotaryDoc())).toEqual([]);
});

// --- the wrap's word preservation (regression) --------------------------------

test("wrapGCode keeps inline words it doesn't interpret — a laser's S power", () => {
  // Regression: parseMove used to read only G/X/Y/Z/I/J/F, and the linear branch
  // REBUILDS each line from those, so an inline S vanished — a wrapped beam
  // program would have gone dark. (Reachable through wrapGCode directly; the
  // laser machine kind itself substitutes rather than wraps.)
  const s: RotarySettings = { axisWord: "A", diameter: 360 / Math.PI, wrapAxis: "y" };
  const out = wrapGCode("G1 X30 Y40 F500 S255", s);
  expect(out).toBe("G1 X30 A40 F500 S255");

  // Rapids and modal-only lines keep theirs too.
  expect(wrapGCode("G0 X1 Y2 S0", s)).toBe("G0 X1 A2 S0");

  // An arc becomes several chords; the power belongs to the whole move, so every
  // chord must carry it or the beam drops out part-way round.
  const chords = wrapGCode("G0 X5 Y0\nG3 X0 Y5 I-5 J0 F800 S200", s)
    .split("\n")
    .filter((l) => l.startsWith("G1"));
  expect(chords.length).toBeGreaterThan(1);
  expect(chords.every((l) => /\bS200\b/.test(l))).toBe(true);
});
