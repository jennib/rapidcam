import { describe, it, expect } from "vitest";
import { dimensionHint, type Phase } from "../src/tools/dimensionTool";

describe("dimensionHint (phase-aware Dimension tool guidance)", () => {
  it("restores the default hint at the start (phase 'first')", () => {
    expect(dimensionHint("first")).toBeNull();
  });

  it("tells the user to click in OPEN SPACE while placing", () => {
    // Circle and angle placement still need open space: a click on geometry
    // there is still consumed as a pick.
    for (const phase of ["placeCircle", "placeAngle"] as Phase[]) {
      expect(dimensionHint(phase)).toMatch(/open space/i);
    }
  });

  it("does NOT send the user hunting for open space on a linear placement", () => {
    // A bare click places a linear dimension ANYWHERE — re-targeting onto a
    // second edge takes Shift — so "find open space" would be wrong advice, and
    // the Shift gesture is otherwise undiscoverable.
    const hint = dimensionHint("placeLinear") ?? "";
    expect(hint).not.toMatch(/open space/i);
    expect(hint).toMatch(/place/i);
    expect(hint).toMatch(/shift/i);
  });

  it("guides the intermediate picks", () => {
    expect(dimensionHint("second")).toMatch(/second point/i);
    // The angle-from-horizontal gesture has no second thing to click, so the
    // hint is the only place it can be discovered.
    expect(dimensionHint("second")).toMatch(/angle from horizontal/i);
  });
});
