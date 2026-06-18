import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { CircleEntity } from "../src/model/entities";
import { generateGCode } from "../src/cam/gcode";
import { serializeDoc, parseRcam, applyFile } from "../src/io/fileio";
import type { CAMOperation } from "../src/cam/types";

function drillOp(entityIds: string[]): CAMOperation {
  return {
    id: "d1", name: "Drill", type: "drill", entityIds, side: "outside",
    toolType: "drill", toolNumber: 1, diameter: 5, feedrate: 200, plungeRate: 120,
    spindleSpeed: 6000, safeZ: 5, depth: -5, stepdown: 3, stepover: 0.4,
  };
}

test("no end position by default: program ends M5 then M30, no return move", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  const a = doc.add(new CircleEntity({ x: 20, y: 20 }, 2.5));
  const g = generateGCode([drillOp([a.id])], doc);
  expect(g).not.toMatch(/return to end position/);
  // Footer order: spindle stop immediately before end program.
  expect(g).toMatch(/M5 ; spindle stop\nM30 ; end program/);
});

test("end position parks at the requested work coords at safe Z before M30", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.endPosition = { x: 0, y: 0 };
  const a = doc.add(new CircleEntity({ x: 20, y: 20 }, 2.5));
  const lines = generateGCode([drillOp([a.id])], doc).split("\n");

  const parkIdx = lines.findIndex((l) => /return to end position/.test(l));
  expect(parkIdx).toBeGreaterThan(-1);
  expect(lines[parkIdx]).toBe("G0 X0 Y0 ; return to end position");
  // Preceded by a safe-Z lift (op safeZ = 5, top-of-stock origin → Z5).
  expect(lines[parkIdx - 1]).toBe("G0 Z5");
  // And it comes before the program end.
  expect(parkIdx).toBeLessThan(lines.findIndex((l) => /M30/.test(l)));
});

test("end position round-trips through save/load", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.endPosition = { x: 12.5, y: -3 };
  const file = serializeDoc(doc, "t");
  expect(file.endPosition).toEqual({ x: 12.5, y: -3 });

  const reloaded = new CADDocument({ width: 1, height: 1 });
  applyFile(reloaded, parseRcam(JSON.stringify(file)));
  expect(reloaded.endPosition).toEqual({ x: 12.5, y: -3 });
});

test("off end position is omitted from the saved file and loads as null", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  expect(doc.endPosition).toBeNull();
  const file = serializeDoc(doc, "t");
  expect("endPosition" in file).toBe(false);

  const reloaded = new CADDocument({ width: 1, height: 1 });
  applyFile(reloaded, parseRcam(JSON.stringify(file)));
  expect(reloaded.endPosition).toBeNull();
});

test("end position is in work coords — not shifted by the WCS origin offset", () => {
  // Origin at right/back shifts model→work, but the park coords are emitted
  // verbatim (they are already work coordinates).
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.origin = { x: "right", y: "back", z: "top" };
  doc.endPosition = { x: 0, y: 0 };
  const a = doc.add(new CircleEntity({ x: 20, y: 20 }, 2.5));
  const g = generateGCode([drillOp([a.id])], doc);
  expect(g).toMatch(/G0 X0 Y0 ; return to end position/);
});
