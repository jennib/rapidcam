import { describe, it, expect } from "vitest";
import { vcarveRegion, type VCarveParams } from "../src/cam/vcarve";
import type { Vec2 } from "../src/core/vec2";

// A CCW square [0..s] x [0..s].
const square = (s: number): Vec2[] => [
  { x: 0, y: 0 },
  { x: s, y: 0 },
  { x: s, y: s },
  { x: 0, y: s },
];

// 90° V-bit: tan(45°) = 1, so depth(r) = r — the cleanest case to assert on.
const P90 = (over: Partial<VCarveParams> = {}): VCarveParams => ({
  vAngle: 90,
  maxDepth: 0,
  stepMM: 1,
  ...over,
});

describe("vcarveRegion — offset peeling", () => {
  it("produces shallow→deep passes that converge on the spine", () => {
    const passes = vcarveRegion(square(20), [], P90());
    expect(passes.length).toBeGreaterThan(0);

    // 90° bit ⇒ depth magnitude equals the radial inset (i·step).
    expect(passes[0].depth).toBeCloseTo(-1, 6);
    expect(passes[1].depth).toBeCloseTo(-2, 6);

    // Depth strictly deepens until the region is consumed (no clamp here).
    for (let i = 1; i < passes.length; i++)
      expect(passes[i].depth).toBeLessThan(passes[i - 1].depth);

    // A 20×20 square peels to its centre at r→10; the last pass is near there.
    expect(Math.abs(passes[passes.length - 1].depth)).toBeGreaterThan(8);
  });

  it("clamps depth at maxDepth, then keeps peeling at the floor", () => {
    const passes = vcarveRegion(square(20), [], P90({ maxDepth: 3 }));
    expect(passes.length).toBeGreaterThan(3);

    for (const p of passes) expect(Math.abs(p.depth)).toBeLessThanOrEqual(3 + 1e-9);

    // Beyond r=3 every remaining pass sits exactly on the floor.
    const clamped = passes.filter((p) => Math.abs(p.depth + 3) < 1e-9);
    expect(clamped.length).toBeGreaterThan(0);
  });

  it("scales depth by the V-angle (60° is deeper than 90° at the same inset)", () => {
    const d90 = vcarveRegion(square(20), [], P90({ vAngle: 90 }))[0].depth;
    const d60 = vcarveRegion(square(20), [], P90({ vAngle: 60 }))[0].depth;
    // tan(30°) ≈ 0.577 ⇒ depth(r) = r/0.577 ≈ 1.732·r, deeper than the 90° cut.
    expect(Math.abs(d60)).toBeGreaterThan(Math.abs(d90));
    expect(Math.abs(d60)).toBeCloseTo(1 / Math.tan((30 * Math.PI) / 180), 4);
  });

  it("carves a region with a hole (counter) as two converging rings", () => {
    const outer = square(20);
    const hole: Vec2[] = [
      // CW 4×4 hole centred in the square
      { x: 8, y: 8 },
      { x: 8, y: 12 },
      { x: 12, y: 12 },
      { x: 12, y: 8 },
    ];
    const passes = vcarveRegion(outer, [hole], P90({ stepMM: 0.5 }));
    expect(passes.length).toBeGreaterThan(0);
    // Early passes must show the outer ring AND the (growing) hole ring distinctly.
    expect(passes[0].loops.length).toBeGreaterThanOrEqual(2);
  });

  it("accepts a single hole ring via the Vec2[] overload", () => {
    const hole: Vec2[] = [
      { x: 8, y: 8 },
      { x: 8, y: 12 },
      { x: 12, y: 12 },
      { x: 12, y: 8 },
    ];
    const a = vcarveRegion(square(20), hole, P90({ stepMM: 0.5 }));
    const b = vcarveRegion(square(20), [hole], P90({ stepMM: 0.5 }));
    expect(a.length).toBe(b.length);
  });

  it("folds a flat tip into the depth: the flat radius rides the surface", () => {
    // 90° bit with a 2mm flat (tipR = 1): depth(r) = max(0, r − 1).
    const passes = vcarveRegion(square(20), [], P90({ tipDiameter: 2 }));
    expect(passes.length).toBeGreaterThan(0);

    // Radii inside the flat only score the surface, so the peel starts at r=2.
    expect(passes[0].depth).toBeCloseTo(-1, 6); // r=2 → max(0, 2−1) = 1
    expect(passes[1].depth).toBeCloseTo(-2, 6); // r=3 → 2

    // At the spine the flat-tip carve bottoms out shallower than the sharp one
    // (the flat radius is subtracted from every cut depth).
    const sharp = vcarveRegion(square(20), [], P90());
    const deepest = (ps: typeof passes) => Math.min(...ps.map((p) => p.depth));
    expect(deepest(passes)).toBeGreaterThan(deepest(sharp)); // less negative = shallower
    expect(deepest(sharp) - deepest(passes)).toBeCloseTo(-1, 6); // exactly tipR shallower
  });

  it("treats tipDiameter 0 as a perfectly sharp bit (no change)", () => {
    const sharp = vcarveRegion(square(20), [], P90());
    const flat0 = vcarveRegion(square(20), [], P90({ tipDiameter: 0 }));
    expect(flat0.map((p) => p.depth)).toEqual(sharp.map((p) => p.depth));
  });

  // A fixed pitch skips straight past anything thinner than 2·step: the feature
  // is gone from the very first inset, so no contour runs along it and the bit
  // never visits it. That silently dropped whole letters and letter strokes from
  // small carved text. The pitch is now capped per region.

  it("carves a region thinner than the requested pitch instead of skipping it", () => {
    // 0.6mm-wide bar: bottoms out at r=0.3, inside the very first 1mm inset.
    const bar: Vec2[] = [
      { x: 0, y: 0 },
      { x: 0.6, y: 0 },
      { x: 0.6, y: 10 },
      { x: 0, y: 10 },
    ];
    const passes = vcarveRegion(bar, [], P90({ stepMM: 1 }));
    expect(passes.length).toBeGreaterThanOrEqual(8);
    // 90° bit ⇒ depth = radius, and the bar's half-width is its deepest point.
    // The spine lands a few µm shy — that is Clipper's collapse resolution.
    const deepest = Math.abs(passes[passes.length - 1].depth);
    expect(deepest).toBeGreaterThan(0.29);
    for (const p of passes) expect(Math.abs(p.depth)).toBeLessThanOrEqual(0.3 + 1e-6);
  });

  it("visits a thin arm hanging off a stem thick enough to survive the pitch", () => {
    // "T" on its side: a 1.2mm stem (survives a 0.4 inset) with a 0.7mm arm
    // (does not). The stem kept the region alive, so nothing flagged the arm —
    // it just never got cut.
    const tee: Vec2[] = [
      { x: 0, y: 0 },
      { x: 1.2, y: 0 },
      { x: 1.2, y: 4 },
      { x: 5, y: 4 },
      { x: 5, y: 4.7 },
      { x: 1.2, y: 4.7 },
      { x: 1.2, y: 10 },
      { x: 0, y: 10 },
    ];
    const passes = vcarveRegion(tee, [], P90({ stepMM: 0.4 }));
    const cutX = passes.flatMap((p) => p.loops.flat()).map((pt) => pt.x);
    expect(cutX.length).toBeGreaterThan(0); // positive control: something is cut
    // Reaching past the stem means rings actually run down the arm.
    expect(Math.max(...cutX)).toBeGreaterThan(4);
  });

  it("cuts the spine at its true depth, not a whole step short of it", () => {
    // 20×20 peeled on a 1mm pitch used to stop at r=9 — a full step shy of the
    // r=10 centre, leaving the ridge 1mm proud.
    const passes = vcarveRegion(square(20), [], P90({ stepMM: 1 }));
    const deepest = Math.abs(passes[passes.length - 1].depth);
    expect(deepest).toBeGreaterThan(9.9);
    expect(deepest).toBeLessThanOrEqual(10 + 1e-6); // never *past* the spine
  });

  it("leaves the requested pitch in charge of a region deep enough for it", () => {
    // 20×20 bottoms out at r=10, far deeper than 8 rings of 0.4 — so the pitch
    // is untouched and the ring count is the old one (plus the spine ring).
    const passes = vcarveRegion(square(20), [], P90({ stepMM: 0.4 }));
    expect(passes[0].depth).toBeCloseTo(-0.4, 6);
    expect(passes[1].depth).toBeCloseTo(-0.8, 6);
    expect(passes.length).toBe(25); // r = 0.4 … 9.6, then the spine at 10
  });

  it("keeps a bottomed-out floor on the requested stepover, not the fine pitch", () => {
    // The fine pitch samples the V flank; below maxDepth the rings are clearing
    // a flat floor and must not multiply just because the flank got denser.
    const bar: Vec2[] = [
      { x: 0, y: 0 },
      { x: 0.6, y: 0 },
      { x: 0.6, y: 10 },
      { x: 0, y: 10 },
    ];
    const passes = vcarveRegion(bar, [], P90({ stepMM: 0.4, maxDepth: 0.1 }));
    const floor = passes.filter((p) => Math.abs(p.depth + 0.1) < 1e-9);
    expect(floor.length).toBeGreaterThan(0); // positive control: it does bottom out
    expect(floor.length).toBeLessThanOrEqual(2); // one floor ring + the spine
  });

  it("returns nothing for degenerate inputs", () => {
    expect(
      vcarveRegion(
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ],
        [],
        P90(),
      ),
    ).toEqual([]); // <3 verts
    expect(vcarveRegion(square(20), [], P90({ stepMM: 0 }))).toEqual([]); // no step
    expect(vcarveRegion(square(20), [], P90({ vAngle: 0 }))).toEqual([]); // flat bit
  });
});
