/**
 * Phase 2: CAM toolpaths follow patterns.
 *
 * An operation that references any member of a pattern is expanded to cover the
 * whole pattern at toolpath/preview time, so the cut tracks the instance count
 * as it grows or shrinks.
 */

import { describe, it, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { CircleEntity } from "../src/model/entities";
import { createLinearPattern, regenerateLinearPattern } from "../src/model/patternEngine";
import { expandOpPatternTargets, opPatternTargetCount } from "../src/cam/patternExpand";
import { generateGCode } from "../src/cam/gcode";
import type { CAMOperation } from "../src/cam/types";
import type { LinearPatternParams } from "../src/model/patterns";

function lin(countX: number): LinearPatternParams {
  return { countX, countY: 1, spacingX: 30, spacingY: 30 };
}
function drillOp(entityIds: string[]): CAMOperation {
  return {
    id: "op1", name: "Drill", type: "drill", entityIds, side: "outside",
    toolType: "drill", toolNumber: 1, diameter: 3, feedrate: 800, plungeRate: 250,
    spindleSpeed: 18000, safeZ: 5, depth: -5, stepdown: 2, stepover: 0.4,
  };
}
function freshDoc(): CADDocument {
  return new CADDocument({ width: 500, height: 500 });
}

describe("CAM ops follow patterns", () => {
  it("expands an op that references only the pattern source to all instances", () => {
    const doc = freshDoc();
    const src = doc.add(new CircleEntity({ x: 0, y: 0 }, 5));
    const pat = createLinearPattern(doc, [src.id], lin(3)); // 2 instances
    const resolved = expandOpPatternTargets(drillOp([src.id]), doc);
    expect([...resolved.entityIds].sort()).toEqual(
      [src.id, ...pat.instanceIds.flat()].sort(),
    );
  });

  it("follows the count when the pattern grows", () => {
    const doc = freshDoc();
    const src = doc.add(new CircleEntity({ x: 0, y: 0 }, 5));
    const pat = createLinearPattern(doc, [src.id], lin(3));
    const op = drillOp([src.id, ...pat.instanceIds.flat()]); // 3 holes
    expect(expandOpPatternTargets(op, doc).entityIds.length).toBe(3);

    regenerateLinearPattern(doc, pat, lin(6)); // count -> 6
    expect(expandOpPatternTargets(op, doc).entityIds.length).toBe(6); // automatically
  });

  it("follows the count when the pattern shrinks (op refs pruned on regen)", () => {
    const doc = freshDoc();
    const src = doc.add(new CircleEntity({ x: 0, y: 0 }, 5));
    const pat = createLinearPattern(doc, [src.id], lin(6)); // 5 instances
    const op = drillOp([src.id, ...pat.instanceIds.flat()]); // 6 holes
    doc.operations.push(op); // so pruneReferences can clean it on regen
    expect(expandOpPatternTargets(op, doc).entityIds.length).toBe(6);

    regenerateLinearPattern(doc, pat, lin(3)); // count -> 3; tail instances removed
    expect(expandOpPatternTargets(op, doc).entityIds.length).toBe(3); // dangling refs gone
  });

  it("generateGCode drills every instance and follows the count end to end", () => {
    const doc = freshDoc();
    const src = doc.add(new CircleEntity({ x: 0, y: 0 }, 5)); // origin left/front -> X = hole x
    const pat = createLinearPattern(doc, [src.id], lin(3)); // holes at x = 0, 30, 60
    doc.operations.push(drillOp([src.id])); // op references only the master

    const g3 = generateGCode(doc.operations, doc);
    expect(g3).not.toContain("X150"); // no 6th hole yet

    regenerateLinearPattern(doc, pat, lin(6)); // holes at x = 0..150
    const g6 = generateGCode(doc.operations, doc);
    expect(g6).toContain("X150"); // the new holes are drilled automatically
  });

  it("does not expand an op that opted out with followPattern:false", () => {
    const doc = freshDoc();
    const src = doc.add(new CircleEntity({ x: 0, y: 0 }, 5));
    createLinearPattern(doc, [src.id], lin(3));
    const op = { ...drillOp([src.id]), followPattern: false as const };
    expect(expandOpPatternTargets(op, doc)).toBe(op); // unchanged — cuts only the master
  });

  it("reports the pattern member count for the UI hint", () => {
    const doc = freshDoc();
    const src = doc.add(new CircleEntity({ x: 0, y: 0 }, 5));
    createLinearPattern(doc, [src.id], lin(3)); // source + 2 instances = 3 members
    expect(opPatternTargetCount(drillOp([src.id]), doc)).toBe(3);
    expect(opPatternTargetCount(drillOp(["nope"]), doc)).toBe(0);
  });

  it("leaves an op that references no pattern member unchanged", () => {
    const doc = freshDoc();
    const lone = doc.add(new CircleEntity({ x: 200, y: 200 }, 5));
    const src = doc.add(new CircleEntity({ x: 0, y: 0 }, 5));
    createLinearPattern(doc, [src.id], lin(3));
    const op = drillOp([lone.id]);
    expect(expandOpPatternTargets(op, doc)).toBe(op); // same reference, untouched
  });
});
