import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { CircleEntity } from "../src/model/entities";
import { generateGCode } from "../src/cam/gcode";
import { serializeDoc, parseRcam, applyFile } from "../src/io/fileio";
import type { CAMOperation } from "../src/cam/types";

function drillOp(entityIds: string[], toolNumber = 1): CAMOperation {
  return {
    id: `d${toolNumber}`, name: `Drill ${toolNumber}`, type: "drill", entityIds, side: "outside",
    toolType: "drill", toolNumber, diameter: 5, feedrate: 200, plungeRate: 120,
    spindleSpeed: 6000, safeZ: 5, depth: -5, stepdown: 3, stepover: 0.4,
  };
}

test("coolant off (default): no M7/M8/M9 emitted", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  const a = doc.add(new CircleEntity({ x: 20, y: 20 }, 2.5));
  const g = generateGCode([drillOp([a.id])], doc);
  expect(g).not.toMatch(/\bM7\b|\bM8\b|\bM9\b/);
});

test("flood coolant: M8 after spindle on, M9 before the final spindle stop", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.coolant = "flood";
  const a = doc.add(new CircleEntity({ x: 20, y: 20 }, 2.5));
  const g = generateGCode([drillOp([a.id])], doc);
  expect(g).toMatch(/M3 S6000 ; spindle on\nM8 ; flood coolant on/);
  expect(g).toMatch(/M9 ; coolant off\nM5 ; spindle stop\nM30 ; end program/);
});

test("mist coolant cycles around a tool change", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.coolant = "mist";
  const a = doc.add(new CircleEntity({ x: 20, y: 20 }, 2.5));
  const b = doc.add(new CircleEntity({ x: 80, y: 20 }, 2.5));
  const g = generateGCode([drillOp([a.id], 1), drillOp([b.id], 2)], doc);
  const lines = g.split("\n");
  // On (M7) after each of the two spindle starts; off (M9) before each of the
  // two spindle stops (the mid tool-change one and the program-end one).
  expect(lines.filter((l) => l === "M7 ; mist coolant on").length).toBe(2);
  expect(lines.filter((l) => l === "M9 ; coolant off").length).toBe(2);
});

test("custom start/end blocks are injected at the right spots", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  const a = doc.add(new CircleEntity({ x: 20, y: 20 }, 2.5));
  const g = generateGCode([drillOp([a.id])], doc, {
    customStart: "G54 ; work offset\nM8",
    customEnd: "M0 ; door",
  });
  // Start: after the G17 setup, before the first toolpath comment.
  expect(g).toMatch(/G17 ; XY plane\n\n; --- custom start ---\nG54 ; work offset\nM8\n/);
  expect(g.indexOf("; --- custom start ---")).toBeLessThan(g.indexOf("; --- Drill"));
  // End: after the final spindle stop, before M30.
  expect(g).toMatch(/M5 ; spindle stop\n; --- custom end ---\nM0 ; door\nM30 ; end program/);
});

test("empty custom blocks inject nothing", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  const a = doc.add(new CircleEntity({ x: 20, y: 20 }, 2.5));
  const g = generateGCode([drillOp([a.id])], doc, { customStart: "", customEnd: "   \n " });
  expect(g).not.toMatch(/custom start|custom end/);
});

test("coolant round-trips; off is omitted from the saved file", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.coolant = "flood";
  const file = serializeDoc(doc, "t");
  expect(file.coolant).toBe("flood");
  const reloaded = new CADDocument({ width: 1, height: 1 });
  applyFile(reloaded, parseRcam(JSON.stringify(file)));
  expect(reloaded.coolant).toBe("flood");

  const off = new CADDocument({ width: 100, height: 100 });
  expect("coolant" in serializeDoc(off, "t")).toBe(false);
});
