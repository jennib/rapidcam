import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { CircleEntity, RectEntity } from "../src/model/entities";
import { serializeDoc } from "../src/io/fileio";
import { resolveOpTool, type CAMOperation, type ToolDef } from "../src/cam/types";
import { generateGCode } from "../src/cam/gcode";

const TOOL: ToolDef = {
  id: "tool-em-6", name: "6mm End Mill", toolType: "end-mill", diameter: 6,
  feedrate: 900, plungeRate: 250, spindleSpeed: 18000, safeZ: 5,
};

function baseOp(over: Partial<CAMOperation> = {}): CAMOperation {
  return {
    id: "op1", name: "Profile", type: "profile", entityIds: ["e1"], side: "outside",
    toolType: "end-mill", toolNumber: 2, diameter: 6, feedrate: 900, plungeRate: 250,
    spindleSpeed: 18000, safeZ: 5, depth: -6, stepdown: 2, stepover: 0.4, ...over,
  };
}

test("resolveOpTool overrides tool fields but keeps per-op cut settings", () => {
  const op = baseOp({ toolId: "tool-em-6", diameter: 99, feedrate: 1, toolNumber: 7, depth: -10 });
  const r = resolveOpTool(op, [TOOL]);
  expect(r.diameter).toBe(6);        // from the tool, not the stale inline 99
  expect(r.feedrate).toBe(900);      // from the tool
  expect(r.toolNumber).toBe(7);      // per-op, untouched
  expect(r.depth).toBe(-10);         // per-op, untouched
});

test("resolveOpTool leaves the op unchanged when there is no toolId or no match", () => {
  const noId = baseOp({ diameter: 99 });
  expect(resolveOpTool(noId, [TOOL])).toBe(noId);
  const badId = baseOp({ toolId: "missing", diameter: 99 });
  expect(resolveOpTool(badId, [TOOL]).diameter).toBe(99); // falls back to inline
});

test("editing one shared tool drives every referencing op (edit once)", () => {
  const doc = new CADDocument({ width: 100, height: 100 }, "mm");
  doc.add(new CircleEntity({ x: 25, y: 25 }, 5, "e1"));
  doc.add(new CircleEntity({ x: 70, y: 70 }, 5, "e2"));
  doc.tools.push({ ...TOOL });
  // Two profile ops sharing one tool (profile cuts emit the feedrate).
  doc.operations.push(baseOp({ id: "a", entityIds: ["e1"], toolId: "tool-em-6" }));
  doc.operations.push(baseOp({ id: "b", entityIds: ["e2"], toolId: "tool-em-6" }));

  // Change the shared tool's feed once; both ops' G-code must reflect it.
  doc.tools[0].feedrate = 1234;
  const g = generateGCode(doc.operations, doc);
  expect(g).toContain("F1234");
  expect(g).not.toContain("F900");
});

test("serialize embeds only referenced tools (forked/orphan tools are pruned)", () => {
  const doc = new CADDocument({ width: 100, height: 100 }, "mm");
  doc.add(new RectEntity({ x: 10, y: 10 }, { x: 40, y: 40 }, "e1"));
  doc.tools.push({ ...TOOL });
  doc.tools.push({ ...TOOL, id: "tool-orphan", name: "Unused" });
  doc.operations.push(baseOp({ entityIds: ["e1"], toolId: "tool-em-6" }));

  const file = serializeDoc(doc, "Prune");
  const ids = (file.tools as ToolDef[]).map((t) => t.id);
  expect(ids).toEqual(["tool-em-6"]); // orphan dropped
});
