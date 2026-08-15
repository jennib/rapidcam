import { expect, test } from "vitest";
import { checkMachinability } from "../src/cam/machinability";
import { buildLintContext, lintGCode } from "../src/cam/lint";
import { generateGCode } from "../src/cam/gcode";
import type { CAMOperation } from "../src/cam/types";
import { CADDocument } from "../src/model/document";
import { type CornerType, RectEntity } from "../src/model/entities";

/**
 * A corner the tool cannot physically cut must be reported, not cut wrong.
 *
 * An INVERTED corner is a concave arc, so a cove smaller than the tool radius
 * simply cannot be produced: the cutter rounds it off at its own radius and the
 * program posts clean. That is the silent-wrong-output class this project cares
 * most about, and it is one dropdown away now that `cornerType` exists.
 *
 * The same is true the other way round for an INSIDE cut: the rounded corners
 * of a hole are concave from the tool's side, so a corner tighter than the tool
 * cannot be reached either.
 *
 * `checkMachinability` already models both — it compares the nominal outline
 * against its morphological closing (outside) or opening (inside) by the tool
 * radius. These tests confirm that a SHAPED RECTANGLE actually reaches it,
 * which it only does because `collectClosedLoops` reads `outlinePoints()`.
 */

function doc(type: CornerType, radius: number, side: "outside" | "inside", diameter: number) {
  const d = new CADDocument({ width: 300, height: 200 }, "mm");
  const rect = d.add(new RectEntity({ x: 20, y: 20 }, { x: 120, y: 90 }));
  rect.cornerRadii = [radius, radius, radius, radius];
  rect.cornerType = type;
  const op: CAMOperation = {
    id: "op",
    name: "cut",
    type: "profile",
    side,
    entityIds: [rect.id],
    toolType: "end-mill",
    toolNumber: 1,
    diameter,
    feedrate: 1000,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -2,
    stepdown: 2,
    stepover: 0.4,
  };
  d.operations.push(op);
  return d;
}

test("a cove smaller than the tool is reported on an outside cut", () => {
  // 2mm cove, 8mm cutter: the cutter's own radius is 4mm, so it can only ever
  // leave a 4mm round there. Cutting it silently would put the part 2mm out of
  // shape at every corner.
  const findings = checkMachinability(doc("inverted", 2, "outside", 8));
  expect(findings.length).toBeGreaterThan(0);
  expect(findings[0].message.length).toBeGreaterThan(0);
});

test("a cove the tool fits is NOT reported — the positive control", () => {
  // Same shape, same op, a tool that fits. Without this the test above passes
  // for a check that flags every rectangle.
  expect(checkMachinability(doc("inverted", 10, "outside", 8))).toEqual([]);
});

test("a rounded corner tighter than the tool is reported on an INSIDE cut", () => {
  // Cutting the rectangle as a hole: its rounded corners are concave from the
  // tool's side, so the same limit applies in the other direction.
  const findings = checkMachinability(doc("round", 2, "inside", 8));
  expect(findings.length).toBeGreaterThan(0);
});

test("the same rounded corner on an OUTSIDE cut is fine — it is convex there", () => {
  // The asymmetry is the point: a 2mm outside round is cut by the tool's flank,
  // no matter how big the tool is.
  expect(checkMachinability(doc("round", 2, "outside", 8))).toEqual([]);
});

test("a plain square rectangle is unaffected either way", () => {
  expect(checkMachinability(doc("round", 0, "outside", 8))).toEqual([]);
  expect(checkMachinability(doc("round", 0, "inside", 8))).toEqual([]);
});

test("the finding names the radius, the tool, and what to do", () => {
  // A pre-flight warning nobody can act on is noise. This one has to say which
  // radius, which tool, and what tool WOULD work.
  const [f] = checkMachinability(doc("inverted", 2, "outside", 8));
  expect(f.code).toBe("corner-tighter-than-tool");
  expect(f.severity).toBe("warning");
  expect(f.message).toContain("R2 mm");
  expect(f.message).toContain("⌀8 mm");
  expect(f.message).toContain("⌀4 mm or smaller"); // 2 × the corner radius
  expect(f.entityIds?.length).toBe(1); // so the canvas can highlight it
});

test("an exact fit is allowed — the tool that just makes it is not a warning", () => {
  // R4 cove, ⌀8 tool: the cutter's radius IS the corner radius, so it cuts it
  // exactly. Warning here would flag every correctly-chosen tool.
  expect(checkMachinability(doc("inverted", 4, "outside", 8))).toEqual([]);
  expect(checkMachinability(doc("inverted", 3.999, "outside", 8))).toHaveLength(1);
});

test("a radius already clamped away by a small rectangle is not reported", () => {
  // effectiveCornerRadii, not the stored value: a 40mm rectangle asked for 30mm
  // corners is DRAWN with 20mm ones, and 20mm is what the tool has to cut.
  const d = new CADDocument({ width: 300, height: 200 }, "mm");
  const rect = d.add(new RectEntity({ x: 0, y: 0 }, { x: 40, y: 40 }));
  rect.cornerRadii = [30, 30, 30, 30]; // clamps to 20
  rect.cornerType = "inverted";
  d.operations.push({
    id: "op", name: "cut", type: "profile", side: "outside", entityIds: [rect.id],
    toolType: "end-mill", toolNumber: 1, diameter: 8, feedrate: 1000, plungeRate: 300,
    spindleSpeed: 18000, safeZ: 5, depth: -2, stepdown: 2, stepover: 0.4,
  });
  expect(checkMachinability(d)).toEqual([]);
});

test("it reaches the real pre-flight path, not just this unit call", () => {
  // lintGCode is what the Apollo dialog runs; a check nobody calls is a check
  // that does not exist.
  const d = doc("inverted", 2, "outside", 8);
  const findings = lintGCode(generateGCode(d.operations, d), buildLintContext(d, {}));
  expect(findings.some((f) => f.code === "corner-tighter-than-tool")).toBe(true);
});
