/**
 * Snap markers have to be AutoCAD's, because a CAD user reads them without
 * looking at any label — which is why getting one wrong is worse than drawing
 * nothing at all.
 *
 * Found by driving the app and comparing: RapidCAM drew a DIAMOND for "a point
 * somewhere along this line", and drew the actual QUADRANT as a square,
 * indistinguishable from an endpoint. In AutoCAD a diamond means quadrant. So
 * someone reaching for the top of a circle, seeing a diamond, got a point on
 * the rim near the top instead — and the marker told them it was the quadrant.
 *
 * The renderer switches on `SNAP_GLYPHS` rather than on the kind, so this test
 * pins the convention without needing a canvas.
 */
import { describe, expect, it } from "vitest";
import { SNAP_GLYPHS } from "../src/input/snapping";
import type { SnapKind } from "../src/model/entities";

describe("snap markers follow AutoCAD's object-snap shapes", () => {
  it("draws each kind the shape a CAD user expects", () => {
    expect(SNAP_GLYPHS.endpoint).toBe("square");
    expect(SNAP_GLYPHS.midpoint).toBe("triangle");
    expect(SNAP_GLYPHS.center).toBe("circle");
    expect(SNAP_GLYPHS.quadrant).toBe("diamond");
    expect(SNAP_GLYPHS.intersection).toBe("cross");
    expect(SNAP_GLYPHS.nearest).toBe("hourglass");
  });

  it("never gives the diamond to anything but the quadrant", () => {
    // The specific confusion this fixes. A diamond is quadrant, full stop; any
    // other kind wearing it sends a CAD user to the wrong point.
    const diamonds = (Object.keys(SNAP_GLYPHS) as SnapKind[]).filter(
      (k) => SNAP_GLYPHS[k] === "diamond",
    );
    expect(diamonds).toEqual(["quadrant"]);
  });

  it("keeps the square for the two kinds that really are an endpoint", () => {
    // A polyline vertex is an endpoint as far as the eye cares, so it shares the
    // square. Nothing else may — a square is the strongest "this exact point"
    // signal there is, and a quadrant wearing it was the bug.
    const squares = (Object.keys(SNAP_GLYPHS) as SnapKind[]).filter(
      (k) => SNAP_GLYPHS[k] === "square",
    );
    expect(squares.sort()).toEqual(["endpoint", "vertex"]);
  });

  it("gives every kind a marker", () => {
    // A kind with no entry would fall through the renderer's switch to the
    // square — silently claiming to be an endpoint. `Record<SnapKind, …>` makes
    // that a compile error; this catches an entry left undefined at runtime.
    const kinds: SnapKind[] = [
      "endpoint",
      "midpoint",
      "center",
      "quadrant",
      "vertex",
      "intersection",
      "pointOnLine",
      "nearest",
    ];
    for (const k of kinds) expect(SNAP_GLYPHS[k], `no marker for "${k}"`).toBeTruthy();
    expect(Object.keys(SNAP_GLYPHS).sort()).toEqual([...kinds].sort());
  });

  it("draws 'along this line' the same as 'nearest' — they are one idea", () => {
    expect(SNAP_GLYPHS.pointOnLine).toBe(SNAP_GLYPHS.nearest);
  });
});
