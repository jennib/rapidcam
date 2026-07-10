import { test, expect } from "vitest";
import { generateGCode } from "../src/cam/gcode";
import { CADDocument } from "../src/model/document";
import { RectEntity, CircleEntity } from "../src/model/entities";
import type { CAMOperation } from "../src/cam/types";
import {
  parseProgram,
  emitProgram,
  isCutMove,
  unsupportedMotions,
  type GProgram,
  type GMoveEvent,
} from "../src/cam/gcodeMotion";

/** Real generator output: a rect outside profile (straight G1s) + a circle profile (G2 arcs). */
function sampleGcode(): string {
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
  return generateGCode(ops, doc);
}

const moves = (p: GProgram): GMoveEvent[] =>
  p.events.filter((e): e is GMoveEvent => e.kind === "move");
const raws = (p: GProgram): string[] => p.events.flatMap((e) => (e.kind === "raw" ? [e.text] : []));

test("round-trips real generator output without losing positions or pass-through lines", () => {
  const g = sampleGcode();
  const p = parseProgram(g);
  expect(moves(p).length).toBeGreaterThan(5);

  const p2 = parseProgram(emitProgram(p)); // no translation
  expect(p2.events.length).toBe(p.events.length);
  expect(moves(p2).map((m) => [m.x, m.y, m.z])).toEqual(moves(p).map((m) => [m.x, m.y, m.z]));
  expect(raws(p2)).toEqual(raws(p)); // comments/M-codes/setup untouched
});

test("parses the circle profile as real arcs with incremental centres", () => {
  const p = parseProgram(sampleGcode());
  const arcs = moves(p).filter((m) => m.motion === 2 || m.motion === 3);
  expect(arcs.length).toBeGreaterThan(0);
  expect(arcs.every((m) => m.i !== undefined && m.j !== undefined)).toBe(true);
  expect(moves(p).some(isCutMove)).toBe(true);
});

test("translation shifts absolute coords but leaves arc I/J, feeds and raw lines alone", () => {
  const p = parseProgram(sampleGcode());
  const shifted = parseProgram(emitProgram(p, { dx: 10, dy: 20 }));
  const a = moves(p),
    b = moves(shifted);
  expect(b.length).toBe(a.length);
  a.forEach((m, k) => {
    if (m.hasX) expect(b[k].x).toBeCloseTo(m.x - 10, 3);
    if (m.hasY) expect(b[k].y).toBeCloseTo(m.y - 20, 3);
    expect(b[k].i).toBe(m.i); // incremental — unchanged by translation
    expect(b[k].j).toBe(m.j);
    expect(b[k].f).toBe(m.f);
  });
  expect(raws(shifted)).toEqual(raws(p));
});

test("flags motions it cannot clip (e.g. G5 splines), and passes clean output", () => {
  expect(unsupportedMotions(sampleGcode())).toEqual([]);
  expect(unsupportedMotions("G1 X0 Y0 F100\nG5 X1 Y2 I1 J2 P3 Q4\nG1 X3 Y4")).toContain("G5");
});

test("keeps commented moves verbatim (park lines) rather than mis-translating them", () => {
  const g = "G0 X10 Y10 ; park for tool change\nG1 X5 Y5 F100";
  const p = parseProgram(g);
  expect(p.events[0]).toEqual({ kind: "raw", text: "G0 X10 Y10 ; park for tool change" });
  expect(emitProgram(p, { dx: 100, dy: 100 }).split("\n")[0]).toBe(
    "G0 X10 Y10 ; park for tool change",
  );
});
