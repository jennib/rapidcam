import { describe, it, expect } from "vitest";
import { type SnapPoint } from "../src/model/entities";
import { resolveShiftedSnap } from "../src/tools/lineTool";

describe("Ortho / Shift snap resolution test", () => {
  it("preserves snap point when Shift is held and snap matches ortho-snapped point", () => {
    const stockSnap: SnapPoint = {
      pos: { x: 50, y: 138.9 },
      kind: "pointOnLine",
      entityId: "__stock__",
      edgeKey: "mid_l",
    };

    const orthoWorld = { x: 50, y: 138.9 };

    // When shift is held, resolveShiftedSnap should keep stockSnap since pos matches orthoWorld
    const resolved = resolveShiftedSnap(stockSnap, orthoWorld);
    expect(resolved).toEqual(stockSnap);
  });

  it("discards snap point when Shift is held if snap position is far from ortho-snapped point", () => {
    const offAxisSnap: SnapPoint = {
      pos: { x: 50, y: 180 }, // 41.1mm off horizontal line
      kind: "pointOnLine",
      entityId: "__stock__",
      edgeKey: "mid_l",
    };

    const orthoWorld = { x: 50, y: 138.9 };

    const resolved = resolveShiftedSnap(offAxisSnap, orthoWorld);
    expect(resolved).toBeNull();
  });
});
