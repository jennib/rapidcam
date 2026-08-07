import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import {
  makeVariable,
  evaluateAll,
  evaluateOperations,
  clampOpParam,
  OP_PARAM_KEYS,
} from "../src/model/variables";
import { CircleEntity } from "../src/model/entities";
import { serializeDoc, parseRcam, applyFile } from "../src/io/fileio";
import type { CAMOperation } from "../src/cam/types";

/**
 * Drift guard for the shared CAM param table.
 *
 * `paramRow` clamps every committed value through `clampOpParam`, which returns
 * null for a key it doesn't know — so a dialog row whose key is missing from
 * OP_PARAMS is silently INERT: typing in it does nothing. That's invisible to a
 * typecheck (the key is a plain string), so scan the section sources and assert
 * every row is backed by the table.
 */
test("every CAM dialog paramRow key is backed by the shared param table", () => {
  const sectionsDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "ui",
    "camBar",
    "dialog",
    "sections",
  );
  const keys = new Set<string>();
  for (const f of readdirSync(sectionsDir).filter((n) => n.endsWith(".ts"))) {
    const src = readFileSync(join(sectionsDir, f), "utf8");
    for (const m of src.matchAll(/paramRow\(\s*doc,\s*state,\s*"([^"]+)"/g)) keys.add(m[1]);
  }
  // Sanity: the scan found rows at all (a regex that matches nothing would make
  // the subset assertion below vacuously pass).
  expect(keys.size).toBeGreaterThan(20);

  const missing = [...keys].filter((k) => !OP_PARAM_KEYS.includes(k));
  expect(missing, `paramRow keys with no OP_PARAMS entry (they would be inert)`).toEqual([]);
});

test("clampOpParam is the single source of truth for field bounds", () => {
  expect(clampOpParam("depth", 5)).toBe(-5); // always below the surface
  expect(clampOpParam("stepover", 3)).toBe(1);
  expect(clampOpParam("laserPower", -20)).toBe(0);
  expect(clampOpParam("toolNumber", 2.6)).toBe(3);
  // S0 is legitimate on a laser / manually-driven router, and the schema's
  // minimum is 0 — this floored at 1 while the dialog allowed 0.
  expect(clampOpParam("spindleSpeed", 0)).toBe(0);
  expect(clampOpParam("nonExistentField", 5)).toBeNull();
  expect(clampOpParam("depth", Number.NaN)).toBeNull();
});

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

  const changed = evaluateAll(
    doc.variables,
    [],
    doc.displayUnit,
    doc.stockThickness,
    doc.operations,
  );
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

  const changed = evaluateOperations([op], doc.variables, doc.stockThickness);
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

  const changed1 = evaluateOperations([op], doc.variables, doc.stockThickness);
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
