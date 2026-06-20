import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { CircleEntity } from "../src/model/entities";
import { serializeDoc, parseRcam, applyFile } from "../src/io/fileio";
import type { CAMOperation } from "../src/cam/types";

// Per-operation CAM fields must survive a save/load round-trip (they're part of
// the .rcam format). Covers the fields added for the toolpath-quality work.
test("operation finishPass + peckDepth round-trip through save/load", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  const a = doc.add(new CircleEntity({ x: 30, y: 30 }, 3));
  const op: CAMOperation = {
    id: "op1", name: "Profile", type: "profile", entityIds: [a.id], side: "outside",
    toolType: "end-mill", toolNumber: 1, diameter: 6, feedrate: 900, plungeRate: 250,
    spindleSpeed: 18000, safeZ: 5, depth: -10, stepdown: 2, stepover: 0.4,
    finishPass: true, finishAllowance: 0.3,
  };
  const drill: CAMOperation = {
    id: "op2", name: "Drill", type: "drill", entityIds: [a.id], side: "outside",
    toolType: "drill", toolNumber: 2, diameter: 5, feedrate: 200, plungeRate: 120,
    spindleSpeed: 6000, safeZ: 5, depth: -10, stepdown: 3, stepover: 0.4,
    peckDepth: 2,
  };
  const chamfer: CAMOperation = {
    id: "op3", name: "Chamfer", type: "chamfer", entityIds: [a.id], side: "outside",
    toolType: "v-bit", vAngle: 60, toolNumber: 3, diameter: 6, feedrate: 900, plungeRate: 250,
    spindleSpeed: 18000, safeZ: 5, depth: -3, stepdown: 3, stepover: 0.4,
    chamferWidth: 3, chamferSide: "outside",
  };
  doc.operations.push(op, drill, chamfer);

  const reloaded = new CADDocument({ width: 1, height: 1 });
  applyFile(reloaded, parseRcam(JSON.stringify(serializeDoc(doc, "t"))));

  expect(reloaded.operations.find((o) => o.id === "op1")?.finishPass).toBe(true);
  expect(reloaded.operations.find((o) => o.id === "op1")?.finishAllowance).toBe(0.3);
  expect(reloaded.operations.find((o) => o.id === "op2")?.peckDepth).toBe(2);
  const ch = reloaded.operations.find((o) => o.id === "op3");
  expect(ch?.type).toBe("chamfer");
  expect(ch?.chamferWidth).toBe(3);
  expect(ch?.chamferSide).toBe("outside");
});
