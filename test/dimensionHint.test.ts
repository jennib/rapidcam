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
    // A bare click places a linear dimension ANYWHERE, so "find open space"
    // would be wrong advice.
    const hint = dimensionHint("placeLinear") ?? "";
    expect(hint).not.toMatch(/open space/i);
    expect(hint).toMatch(/place/i);
    // Both operands are picked in phase "second" now, so there is no
    // Shift-to-re-target gesture left to advertise. A hint naming a gesture
    // that no longer exists is worse than no hint.
    expect(hint).not.toMatch(/shift/i);
  });

  it("guides the intermediate picks", () => {
    const hint = dimensionHint("second") ?? "";
    // A click here can land ANYWHERE on the second object, which is the whole
    // point of the pick — saying "the second point" would undersell it.
    expect(hint).toMatch(/second object/i);
    // The gesture a click here can mean that is not "the other end", and is
    // discoverable nowhere else: clicking open space dimensions the first pick
    // on its own (a line's or an edge's own length).
    expect(hint).toMatch(/open space/i);
  });

  it("advertises Tab while placing — a line's angle has no gesture of its own", () => {
    // The angle from horizontal is measured against an axis that is not
    // selectable geometry, so there is nothing to click for it. Tab during
    // placement is the whole discovery path.
    expect(dimensionHint("placeLinear")).toMatch(/tab/i);
    expect(dimensionHint("placeLinear")).toMatch(/angle from horizontal/i);
  });
});
