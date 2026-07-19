/**
 * Machinability pre-flight: geometry a too-large tool cannot reach must warn,
 * exact-fit clamped tools must pass clean. The validation matrix mirrors the
 * design numbers (gear 20T/m2: root gap ≈ 2.23mm, ~8-13mm² per tooth space).
 */
import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { PolylineEntity } from "../src/model/entities";
import { type CAMOperation, DEFAULTS } from "../src/cam/types";
import { checkMachinability } from "../src/cam/machinability";
import { buildLintContext, lintGCode } from "../src/cam/lint";
import { generateGCode } from "../src/cam/gcode";
import { GENERATORS, runGenerator } from "../src/generators/index";

/** Mill op literal over `entityIds` with an explicit tool diameter. */
function op(
  entityIds: string[],
  diameter: number,
  over: Partial<CAMOperation> = {},
): CAMOperation {
  return {
    ...DEFAULTS,
    id: "cam-mach-1",
    name: "Test op",
    type: "profile",
    entityIds,
    side: "outside",
    diameter,
    ...over,
  };
}

function gearDoc(bore = 0): { doc: CADDocument; ids: string[] } {
  const doc = new CADDocument({ width: 300, height: 300 });
  const res = runGenerator(doc, GENERATORS["spur-gear"], { teeth: 20, module: 2, bore });
  return { doc, ids: [...res.group.entityIds] };
}

test("gear outline with a 6mm tool flags all 20 tooth spaces", () => {
  const { doc, ids } = gearDoc();
  doc.operations.push(op(ids, 6));
  const findings = checkMachinability(doc);
  expect(findings).toHaveLength(1);
  expect(findings[0].code).toBe("unreachable-features");
  expect(findings[0].severity).toBe("warning");
  expect(findings[0].message).toContain("⌀6 mm");
  // ≥20 regions covering the 20 tooth spaces (the round∩miter intersection can
  // split a space into two pieces at the root land), tens of mm² in total.
  const count = Number(/(\d+) feature region/.exec(findings[0].message)![1]);
  expect(count).toBeGreaterThanOrEqual(20);
  expect(count).toBeLessThanOrEqual(30);
  const area = Number(/≈([\d.]+) mm²/.exec(findings[0].message)![1]);
  expect(area).toBeGreaterThan(50);
});

test("gear with its clamped exact-fit tool passes clean (knife-edge case)", () => {
  const { doc, ids } = gearDoc();
  // The generator's own clamp: ⌀ = root gap exactly. MORPH_EPS must make this
  // deterministic, not clipper-noise-flaky.
  doc.operations.push(op(ids, 2.227));
  expect(checkMachinability(doc)).toHaveLength(0);
});

test("plain rectangle with a 6mm tool is clean (miter closing is an identity)", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const res = runGenerator(doc, GENERATORS["box-joint"], { fingers: 6, width: 120 });
  // 6 fingers → 20mm slots, all wider than the tool.
  doc.operations.push(op([...res.group.entityIds], 6));
  expect(checkMachinability(doc)).toHaveLength(0);
});

test("boxJoint at 25 fingers (4.8mm slots) flags with a 6mm tool", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const res = runGenerator(doc, GENERATORS["box-joint"], { fingers: 25 });
  doc.operations.push(op([...res.group.entityIds], 6));
  const findings = checkMachinability(doc);
  expect(findings).toHaveLength(1);
  // 12 slots swallowed (~28.8mm² each).
  expect(findings[0].message).toMatch(/12 feature regions/);
});

test("inside profile the tool can't enter at all → whole-feature finding", () => {
  const { doc, ids } = gearDoc(6); // 6mm bore circle is entity #2
  doc.operations.push(op([ids[1]], 6, { side: "inside", name: "Bore" }));
  const findings = checkMachinability(doc);
  expect(findings).toHaveLength(1);
  expect(findings[0].message).toContain("no part of its geometry is reachable");
  expect(findings[0].message).toContain("toolpath will be empty");
});

test("region-seeded pocket too narrow for the tool → whole-feature finding", () => {
  const doc = new CADDocument({ width: 500, height: 500 });
  runGenerator(doc, GENERATORS["finger-box"], {}, { createOps: true });
  // The suggested pocket op carries seeded regions and a clamped ⌀3 tool —
  // clean as suggested; force the default 6mm tool onto it and it must flag.
  const pocket = doc.operations.find((o) => o.type === "pocket")!;
  expect(checkMachinability(doc)).toHaveLength(0); // suggested clamps pass
  pocket.diameter = 6;
  const findings = checkMachinability(doc);
  expect(findings).toHaveLength(1);
  expect(findings[0].message).toContain("no part of its geometry is reachable");
});

test("a library tool overrides the inline diameter (resolveOpTool path)", () => {
  const { doc, ids } = gearDoc();
  doc.tools.push({
    id: "tool-big",
    name: "6mm end mill",
    toolType: "end-mill",
    diameter: 6,
    feedrate: 1000,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
  });
  // Inline diameter says 2 (would pass); the assigned tool says 6 (must flag).
  doc.operations.push(op(ids, 2, { toolId: "tool-big" }));
  const findings = checkMachinability(doc);
  expect(findings).toHaveLength(1);
  expect(findings[0].message).toContain("⌀6 mm");
});

test("laser docs and non-profile/pocket ops are skipped", () => {
  const { doc, ids } = gearDoc();
  doc.operations.push(op(ids, 6));
  doc.machineKind = "laser";
  expect(checkMachinability(doc)).toHaveLength(0);
  doc.machineKind = "mill";
  doc.operations[0].type = "engrave";
  expect(checkMachinability(doc)).toHaveLength(0);
});

test("degenerate / unmatched geometry is skipped quietly", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  doc.operations.push(op(["not-a-real-id"], 6));
  expect(checkMachinability(doc)).toHaveLength(0);
});

test("a small narrow slot flags (dual-morphology closes the false-negative class)", () => {
  // 60×40 rect with a 0.8mm-wide, 4mm-deep slot in the top edge: ~3.2mm² of
  // genuinely unreachable material — under the old r²-scaled threshold (4.5 at
  // r=3) this slipped through; the intersection gate must catch it.
  const doc = new CADDocument({ width: 200, height: 200 });
  const slotted = new PolylineEntity(
    [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 40 },
      { x: 30.4, y: 40 },
      { x: 30.4, y: 36 },
      { x: 29.6, y: 36 },
      { x: 29.6, y: 40 },
      { x: 0, y: 40 },
    ],
    true,
  );
  doc.add(slotted);
  doc.operations.push(op([slotted.id], 6));
  const findings = checkMachinability(doc);
  expect(findings).toHaveLength(1);
  expect(findings[0].message).toMatch(/1 feature region /);
  expect(findings[0].message).toMatch(/≈3\.\d mm²/);
});

test("box side-wall corner steps stay clean (round side kills miter's false seal)", () => {
  const doc = new CADDocument({ width: 500, height: 500 });
  const res = runGenerator(doc, GENERATORS["finger-box"], {});
  doc.operations.push(op([...res.group.entityIds].slice(0, 5), 6));
  expect(checkMachinability(doc)).toHaveLength(0);
});

test("findings carry the offending entity ids for canvas highlight", () => {
  const { doc, ids } = gearDoc();
  doc.operations.push(op(ids, 6));
  const [finding] = checkMachinability(doc);
  expect(finding.entityIds).toEqual([ids[0]]); // the gear body loop

  const pdoc = new CADDocument({ width: 500, height: 500 });
  const pres = runGenerator(pdoc, GENERATORS["finger-box"], {}, { createOps: true });
  const pocket = pdoc.operations.find((o) => o.type === "pocket")!;
  pocket.diameter = 6;
  const [pf] = checkMachinability(pdoc);
  expect(pf.entityIds).toBeDefined();
  // The dead groove regions name their bounding loops — grooves included.
  const grooveIds = pres.group.entityIds.slice(5);
  expect(pf.entityIds!.some((id) => grooveIds.includes(id))).toBe(true);
});

test("findings flow through lintGCode via buildLintContext; doc-less contexts skip", () => {
  const { doc, ids } = gearDoc();
  doc.operations.push(op(ids, 6));
  const gcode = generateGCode(doc.operations, doc);

  const withDoc = lintGCode(gcode, buildLintContext(doc));
  expect(withDoc.some((f) => f.code === "unreachable-features")).toBe(true);

  const ctx = buildLintContext(doc);
  delete ctx.doc;
  const without = lintGCode(gcode, ctx);
  expect(without.some((f) => f.code === "unreachable-features")).toBe(false);
});
