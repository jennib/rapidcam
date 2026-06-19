import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { CircleEntity } from "../src/model/entities";
import { generateGCode } from "../src/cam/gcode";
import { serializeDoc, parseRcam, applyFile } from "../src/io/fileio";
import type { CAMOperation, CoolantMode } from "../src/cam/types";

function drillOp(
  entityIds: string[],
  { toolNumber = 1, coolant }: { toolNumber?: number; coolant?: CoolantMode } = {},
): CAMOperation {
  return {
    id: `d${toolNumber}-${coolant ?? "off"}`, name: `Drill ${toolNumber}`, type: "drill",
    entityIds, side: "outside", coolant,
    toolType: "drill", toolNumber, diameter: 5, feedrate: 200, plungeRate: 120,
    spindleSpeed: 6000, safeZ: 5, depth: -5, stepdown: 3, stepover: 0.4,
  };
}

test("no coolant on any op: no M7/M8/M9 emitted", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  const a = doc.add(new CircleEntity({ x: 20, y: 20 }, 2.5));
  const g = generateGCode([drillOp([a.id])], doc);
  expect(g).not.toMatch(/\bM7\b|\bM8\b|\bM9\b/);
});

test("flood op: M8 after spindle on, M9 before the final spindle stop", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  const a = doc.add(new CircleEntity({ x: 20, y: 20 }, 2.5));
  const g = generateGCode([drillOp([a.id], { coolant: "flood" })], doc);
  expect(g).toContain("M8 ; flood coolant on");
  expect(g.indexOf("M8 ; flood coolant on")).toBeGreaterThan(g.indexOf("M3 S6000 ; spindle on"));
  expect(g).toMatch(/M9 ; coolant off\nM5 ; spindle stop\nM30 ; end program/);
});

test("coolant cycles around a tool change (mist on both ops)", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  const a = doc.add(new CircleEntity({ x: 20, y: 20 }, 2.5));
  const b = doc.add(new CircleEntity({ x: 80, y: 20 }, 2.5));
  const g = generateGCode(
    [drillOp([a.id], { toolNumber: 1, coolant: "mist" }),
     drillOp([b.id], { toolNumber: 2, coolant: "mist" })],
    doc,
  );
  const lines = g.split("\n");
  // On after each spindle start (2), off before the tool-change stop + at end (2).
  expect(lines.filter((l) => l === "M7 ; mist coolant on").length).toBe(2);
  expect(lines.filter((l) => l === "M9 ; coolant off").length).toBe(2);
});

test("coolant differs per op on a shared tool: a mid-program M9 turns it off", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  const a = doc.add(new CircleEntity({ x: 20, y: 20 }, 2.5));
  const b = doc.add(new CircleEntity({ x: 80, y: 20 }, 2.5));
  // Same tool number → no tool change; op1 flood, op2 off.
  const g = generateGCode(
    [drillOp([a.id], { toolNumber: 1, coolant: "flood" }),
     drillOp([b.id], { toolNumber: 1, coolant: "off" })],
    doc,
  );
  const lines = g.split("\n");
  expect(lines.filter((l) => l === "M8 ; flood coolant on").length).toBe(1);
  // One M9 to switch flood→off mid-program; none extra at the end (already off).
  expect(lines.filter((l) => l === "M9 ; coolant off").length).toBe(1);
  // No spindle stop between the two ops (shared tool).
  expect(lines.filter((l) => l === "M5 ; spindle stop").length).toBe(1);
});

test("coolantSupported:false suppresses coolant even if an op requests it", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  const a = doc.add(new CircleEntity({ x: 20, y: 20 }, 2.5));
  const g = generateGCode([drillOp([a.id], { coolant: "flood" })], doc, { coolantSupported: false });
  expect(g).not.toMatch(/\bM7\b|\bM8\b|\bM9\b/);
});

test("custom start/end blocks are injected at the right spots", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  const a = doc.add(new CircleEntity({ x: 20, y: 20 }, 2.5));
  const g = generateGCode([drillOp([a.id])], doc, {
    customStart: "G54 ; work offset\nM8",
    customEnd: "M0 ; door",
  });
  expect(g).toMatch(/G17 ; XY plane\n\n; --- custom start ---\nG54 ; work offset\nM8\n/);
  expect(g.indexOf("; --- custom start ---")).toBeLessThan(g.indexOf("; --- Drill"));
  expect(g).toMatch(/M5 ; spindle stop\n; --- custom end ---\nM0 ; door\nM30 ; end program/);
});

test("empty custom blocks inject nothing", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  const a = doc.add(new CircleEntity({ x: 20, y: 20 }, 2.5));
  const g = generateGCode([drillOp([a.id])], doc, { customStart: "", customEnd: "   \n " });
  expect(g).not.toMatch(/custom start|custom end/);
});

test("per-op coolant round-trips through save/load", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  const a = doc.add(new CircleEntity({ x: 20, y: 20 }, 2.5));
  doc.operations.push(drillOp([a.id], { coolant: "mist" }));
  const file = serializeDoc(doc, "t");

  const reloaded = new CADDocument({ width: 1, height: 1 });
  applyFile(reloaded, parseRcam(JSON.stringify(file)));
  expect(reloaded.operations[0].coolant).toBe("mist");
});
