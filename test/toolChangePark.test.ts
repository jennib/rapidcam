import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { CircleEntity } from "../src/model/entities";
import { generateGCode } from "../src/cam/gcode";
import { serializeDoc, parseRcam, applyFile } from "../src/io/fileio";
import type { CAMOperation } from "../src/cam/types";

// Two ops on different tools force a tool change between them.
const drillOp = (id: string, ids: string[], tool: number): CAMOperation => ({
  id,
  name: "op",
  type: "drill",
  entityIds: ids,
  side: "outside",
  toolType: "drill",
  toolNumber: tool,
  diameter: 3 + tool,
  feedrate: 200,
  plungeRate: 120,
  spindleSpeed: 6000,
  safeZ: 5,
  depth: -3,
  stepdown: 3,
  stepover: 0.4,
});

function twoToolDoc(): { doc: CADDocument; ops: CAMOperation[] } {
  const doc = new CADDocument({ width: 100, height: 100 });
  const a = doc.add(new CircleEntity({ x: 20, y: 20 }, 2));
  const b = doc.add(new CircleEntity({ x: 60, y: 60 }, 2.5));
  return { doc, ops: [drillOp("o1", [a.id], 1), drillOp("o2", [b.id], 2)] };
}

test("no park by default — a manual tool change doesn't add a park move", () => {
  const { doc, ops } = twoToolDoc();
  const g = generateGCode(ops, doc);
  expect(g).toMatch(/Manual tool change to T2/); // the change happens
  expect(g).not.toMatch(/park for tool change/); // but no park
});

test("park position parks (work coords, at safe Z) right before the manual change", () => {
  const { doc, ops } = twoToolDoc();
  doc.toolChangePosition = { x: 0, y: 90 };
  const lines = generateGCode(ops, doc).split("\n");

  const parkIdx = lines.findIndex((l) => /park for tool change/.test(l));
  expect(parkIdx).toBeGreaterThan(-1);
  expect(lines[parkIdx]).toBe("G0 X0 Y90 ; park for tool change");
  // A safe-Z lift precedes the park…
  expect(
    lines
      .slice(0, parkIdx)
      .reverse()
      .find((l) => /^G0 Z/.test(l)),
  ).toBe("G0 Z5");
  // …and the park comes immediately before the manual-change banner.
  expect(lines[parkIdx + 1]).toMatch(/Manual tool change to T2/);
});

test("no park on the first op (no change) or when there's only one tool", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.toolChangePosition = { x: 0, y: 90 };
  const a = doc.add(new CircleEntity({ x: 20, y: 20 }, 2));
  const b = doc.add(new CircleEntity({ x: 60, y: 60 }, 2));
  const g = generateGCode([drillOp("o1", [a.id], 1), drillOp("o2", [b.id], 1)], doc);
  expect(g).not.toMatch(/park for tool change/); // same tool → no change → no park
});

test("an automatic tool changer uses M6 and ignores the park position", () => {
  const { doc, ops } = twoToolDoc();
  doc.hasToolChanger = true;
  doc.toolChangePosition = { x: 0, y: 90 };
  const g = generateGCode(ops, doc);
  expect(g).toMatch(/T2 M6 ; tool change/);
  expect(g).not.toMatch(/park for tool change/);
});

test("park position round-trips through save/load and is omitted when off", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.toolChangePosition = { x: 5, y: -2.5 };
  const file = serializeDoc(doc, "t");
  expect(file.toolChangePosition).toEqual({ x: 5, y: -2.5 });
  const reloaded = new CADDocument({ width: 1, height: 1 });
  applyFile(reloaded, parseRcam(JSON.stringify(file)));
  expect(reloaded.toolChangePosition).toEqual({ x: 5, y: -2.5 });

  const off = new CADDocument({ width: 100, height: 100 });
  expect("toolChangePosition" in serializeDoc(off, "t")).toBe(false);
});
