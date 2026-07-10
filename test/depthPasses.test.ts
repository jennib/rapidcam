import { test, expect } from "vitest";
import { depthPasses } from "../src/cam/postprocessors/base";
import type { CAMOperation } from "../src/cam/types";

// Minimal op factory — depthPasses only reads `depth` and `stepdown`.
function op(depth: number, stepdown: number): CAMOperation {
  return {
    id: "t",
    name: "t",
    type: "profile",
    entityIds: [],
    side: "outside",
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 3,
    feedrate: 1000,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
    depth,
    stepdown,
    stepover: 0.4,
  };
}

test("depthPasses: normal stepdown splits into ceil(depth/stepdown) passes ending at depth", () => {
  expect(depthPasses(op(-6, 1.5))).toEqual([-1.5, -3, -4.5, -6]);
  // A stepdown larger than the depth collapses to a single full-depth pass.
  expect(depthPasses(op(-2, 5))).toEqual([-2]);
});

test("depthPasses: zero stepdown does not hang — falls back to a single full-depth pass", () => {
  // Regression: `total / 0` was Infinity, making the pass count Infinity and the
  // generation loop spin forever. Must now terminate with one full-depth pass.
  expect(depthPasses(op(-6, 0))).toEqual([-6]);
});

test("depthPasses: negative stepdown never cuts above the surface", () => {
  // Previously produced a positive Z (a cut above the stock). Every returned Z
  // must be <= 0 and reach the full depth.
  const passes = depthPasses(op(-6, -2));
  expect(passes.every((z) => z <= 0)).toBe(true);
  expect(passes.at(-1)).toBe(-6);
});
