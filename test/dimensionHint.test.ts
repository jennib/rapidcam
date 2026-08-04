import { describe, it, expect } from "vitest";
import { dimensionHint, type Phase } from "../src/tools/dimensionTool";

describe("dimensionHint (phase-aware Dimension tool guidance)", () => {
  it("restores the default hint at the start (phase 'first')", () => {
    expect(dimensionHint("first")).toBeNull();
  });

  it("tells the user to click in OPEN SPACE while placing", () => {
    for (const phase of ["placeLinear", "placeCircle", "placeAngle"] as Phase[]) {
      expect(dimensionHint(phase)).toMatch(/open space/i);
    }
  });

  it("guides the intermediate picks", () => {
    expect(dimensionHint("second")).toMatch(/second point/i);
    // The angle-from-horizontal gesture has no second thing to click, so the
    // hint is the only place it can be discovered.
    expect(dimensionHint("second")).toMatch(/angle from horizontal/i);
  });
});
