import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { makeVariable } from "../src/model/variables";
import {
  GENERATORS,
  type Generator,
  isFeatureStale,
  regenerateStaleFeatures,
  resolveFeatureParams,
  runGenerator,
} from "../src/generators/index";
import { applyFile, serializeDoc } from "../src/io/fileio";

/** One clamped param (width, [10,500]) → a circle of that diameter. Minimal
 *  enough to exercise expression resolution + the probe-run clamp comparison
 *  without pulling in a real generator's geometry. */
const testGen: Generator = {
  id: "test-expr-gen",
  name: "Test Expr Gen",
  build(s) {
    const w = s.param("width", 50, { min: 10, max: 500 });
    return [s.circle({ x: 0, y: 0 }, w / 2)];
  },
};

test("runGenerator stores paramExprs alongside the resolved cached value", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  doc.addVariable(makeVariable("boxW", "60", "mm"));
  GENERATORS[testGen.id] = testGen;
  try {
    const res = runGenerator(doc, testGen, { width: 120 }, { paramExprs: { width: "boxW * 2" } });
    expect(res.feature.paramExprs).toEqual({ width: "boxW * 2" });
    expect(res.feature.params.width).toBe(120);
  } finally {
    delete GENERATORS[testGen.id];
  }
});

test("regenerateStaleFeatures follows a variable change, then is idempotent", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  doc.addVariable(makeVariable("boxW", "60", "mm"));
  GENERATORS[testGen.id] = testGen;
  try {
    const res = runGenerator(doc, testGen, { width: 120 }, { paramExprs: { width: "boxW * 2" } });
    const entityId = res.group.entityIds[0];

    // Simulate evaluateAll() having refreshed the variable's cached value.
    doc.variables[0].value = 80;

    expect(regenerateStaleFeatures(doc)).toBe(true);
    const f = doc.features.find((x) => x.id === res.feature.id)!;
    expect(f.params.width).toBe(160);
    // Id-stable: the same entity was reconciled in place, not replaced.
    expect(doc.entities.some((e) => e.id === entityId)).toBe(true);

    // Nothing changed since the last regen — must not regenerate again.
    expect(regenerateStaleFeatures(doc)).toBe(false);
  } finally {
    delete GENERATORS[testGen.id];
  }
});

test("an expr resolving below a param's min clamps once and does not stay stale", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  doc.addVariable(makeVariable("smallW", "4", "mm")); // below the 10 min
  GENERATORS[testGen.id] = testGen;
  try {
    const res = runGenerator(doc, testGen, { width: 100 });
    // As if the dialog just pointed this param at an out-of-range expression.
    res.feature.paramExprs = { width: "smallW" };

    expect(regenerateStaleFeatures(doc)).toBe(true);
    const f = doc.features.find((x) => x.id === res.feature.id)!;
    expect(f.params.width).toBe(10); // Sketch.param's clamp won

    // The clamped cache now matches what a rebuild produces — clean.
    expect(regenerateStaleFeatures(doc)).toBe(false);
  } finally {
    delete GENERATORS[testGen.id];
  }
});

test("a broken expression (unknown variable) falls back to the cached value and is not stale", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  GENERATORS[testGen.id] = testGen;
  try {
    const res = runGenerator(doc, testGen, { width: 50 });
    res.feature.paramExprs = { width: "noSuchVar * 2" };

    expect(resolveFeatureParams(doc, res.feature).width).toBe(50);
    expect(isFeatureStale(doc, res.feature)).toBe(false);
    expect(regenerateStaleFeatures(doc)).toBe(false);
  } finally {
    delete GENERATORS[testGen.id];
  }
});

test("renameVariableRefs rewrites feature paramExprs", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  doc.addVariable(makeVariable("boxW", "60", "mm"));
  GENERATORS[testGen.id] = testGen;
  try {
    const res = runGenerator(doc, testGen, { width: 120 }, { paramExprs: { width: "boxW * 2" } });
    doc.renameVariableRefs("boxW", "bw");
    expect(res.feature.paramExprs!.width).toBe("bw * 2");
  } finally {
    delete GENERATORS[testGen.id];
  }
});

test("features preserve paramExprs across a serialize -> applyFile round-trip", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  doc.addVariable(makeVariable("boxW", "60", "mm"));
  GENERATORS[testGen.id] = testGen;
  try {
    const res = runGenerator(doc, testGen, { width: 120 }, { paramExprs: { width: "boxW * 2" } });

    const file = serializeDoc(doc, "expr-test");
    const reloaded = new CADDocument({ width: 300, height: 300 });
    applyFile(reloaded, file);

    const f = reloaded.features.find((x) => x.id === res.feature.id)!;
    expect(f.paramExprs).toEqual({ width: "boxW * 2" });
    expect(f.params.width).toBe(120);
  } finally {
    delete GENERATORS[testGen.id];
  }
});

test("snapshot/restore does not alias paramExprs", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  doc.addVariable(makeVariable("boxW", "60", "mm"));
  GENERATORS[testGen.id] = testGen;
  try {
    const res = runGenerator(doc, testGen, { width: 120 }, { paramExprs: { width: "boxW * 2" } });

    const s = doc.snapshot();
    res.feature.paramExprs!.width = "boxW * 3"; // mutate the live object post-snapshot
    doc.restore(s);

    const f = doc.features.find((x) => x.id === res.feature.id)!;
    expect(f.paramExprs!.width).toBe("boxW * 2"); // restored value, unaffected by the mutation
  } finally {
    delete GENERATORS[testGen.id];
  }
});
