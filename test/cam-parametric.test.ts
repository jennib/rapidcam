import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { makeVariable, evaluateAll, evaluateOperations } from "../src/model/variables";
import { CircleEntity } from "../src/model/entities";
import { serializeDoc, parseRcam, applyFile } from "../src/io/fileio";
import type { CAMOperation } from "../src/cam/types";

test("evaluateOperations resolves expressions and applies clamping/transformations", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.stockThickness = 12;
  doc.addVariable(makeVariable("cutD", "6", "mm"));
  doc.addVariable(makeVariable("feedVal", "1200", "mm"));
  doc.addVariable(makeVariable("stepVal", "2.5", "mm"));

  const circle = doc.add(new CircleEntity({ x: 30, y: 30 }, 10));

  const op: CAMOperation = {
    id: "op1",
    name: "Profile Cut",
    type: "profile",
    entityIds: [circle.id],
    side: "outside",
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 6,
    feedrate: 800,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -5,
    stepdown: 1,
    stepover: 0.4,
    paramExprs: {
      depth: "-stock",
      feedrate: "feedVal * 1.5",
      stepdown: "stepVal",
      toolNumber: "2.8", // should be rounded to 3
    },
  };

  doc.operations.push(op);

  const changed = evaluateAll(doc.variables, [], doc, doc.operations);
  expect(changed).toBe(true);

  expect(op.depth).toBe(-12); // -stock thickness (12)
  expect(op.feedrate).toBe(1800); // 1200 * 1.5
  expect(op.stepdown).toBe(2.5);
  expect(op.toolNumber).toBe(3); // rounded integer
});

test("depth is always strictly negative even if expression evaluates positive", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.addVariable(makeVariable("d", "8", "mm"));

  const op: CAMOperation = {
    id: "op1",
    name: "Profile",
    type: "profile",
    entityIds: [],
    side: "outside",
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 6,
    feedrate: 500,
    plungeRate: 200,
    spindleSpeed: 12000,
    safeZ: 5,
    depth: -2,
    stepdown: 1,
    stepover: 0.4,
    paramExprs: {
      depth: "d", // positive 8
    },
  };

  const changed = evaluateOperations([op], doc);
  expect(changed).toBe(true);
  expect(op.depth).toBe(-8);
});

test("evaluateOperations returns false when values do not change", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.addVariable(makeVariable("feed", "1000", "mm"));

  const op: CAMOperation = {
    id: "op1",
    name: "Profile",
    type: "profile",
    entityIds: [],
    side: "outside",
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 6,
    feedrate: 1000,
    plungeRate: 200,
    spindleSpeed: 12000,
    safeZ: 5,
    depth: -5,
    stepdown: 1,
    stepover: 0.4,
    paramExprs: {
      feedrate: "feed",
    },
  };

  const changed1 = evaluateOperations([op], doc);
  expect(changed1).toBe(false); // was already 1000
});

test("renameVariableRefs renames variable identifiers inside CAM paramExprs", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.addVariable(makeVariable("oldFeed", "900", "mm"));

  const op: CAMOperation = {
    id: "op1",
    name: "Profile",
    type: "profile",
    entityIds: [],
    side: "outside",
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 6,
    feedrate: 900,
    plungeRate: 200,
    spindleSpeed: 12000,
    safeZ: 5,
    depth: -5,
    stepdown: 1,
    stepover: 0.4,
    paramExprs: {
      feedrate: "oldFeed * 2",
      depth: "-oldFeed / 100",
    },
  };
  doc.operations.push(op);

  doc.renameVariableRefs("oldFeed", "newFeed");

  expect(op.paramExprs?.feedrate).toBe("newFeed * 2");
  expect(op.paramExprs?.depth).toBe("-newFeed / 100");
});

test("paramExprs round-trips through serializeDoc and applyFile", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.addVariable(makeVariable("matThickness", "15", "mm"));

  const op: CAMOperation = {
    id: "op1",
    name: "Pocket",
    type: "pocket",
    entityIds: [],
    side: "inside",
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 4,
    feedrate: 1500,
    plungeRate: 400,
    spindleSpeed: 20000,
    safeZ: 5,
    depth: -15,
    stepdown: 3,
    stepover: 0.45,
    paramExprs: {
      depth: "-matThickness",
      feedrate: "1500",
      stepover: "0.45",
    },
  };
  doc.operations.push(op);

  const serialized = serializeDoc(doc, "test-save");
  const reloaded = new CADDocument({ width: 10, height: 10 });
  applyFile(reloaded, parseRcam(JSON.stringify(serialized)));

  const loadedOp = reloaded.operations.find((o) => o.id === "op1");
  expect(loadedOp).toBeDefined();
  expect(loadedOp?.paramExprs).toEqual({
    depth: "-matThickness",
    feedrate: "1500",
    stepover: "0.45",
  });
  expect(loadedOp?.depth).toBe(-15);
});

test("snapshot and restore creates deep copy of paramExprs", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  const op: CAMOperation = {
    id: "op1",
    name: "Op",
    type: "profile",
    entityIds: [],
    side: "outside",
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 6,
    feedrate: 800,
    plungeRate: 200,
    spindleSpeed: 10000,
    safeZ: 5,
    depth: -10,
    stepdown: 2,
    stepover: 0.4,
    paramExprs: {
      depth: "-10",
      feedrate: "800",
    },
  };
  doc.operations.push(op);

  const snap = doc.snapshot();

  // Mutate live
  op.paramExprs!.depth = "-20";
  op.paramExprs!.feedrate = "1200";

  doc.restore(snap);

  const restoredOp = doc.operations.find((o) => o.id === "op1");
  expect(restoredOp?.paramExprs?.depth).toBe("-10");
  expect(restoredOp?.paramExprs?.feedrate).toBe("800");
});
