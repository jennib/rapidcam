import { describe, it, expect } from "vitest";
import { vcarveRegion, type VCarveParams } from "../src/cam/vcarve";
import type { Vec2 } from "../src/core/vec2";

// A CCW square [0..s] x [0..s].
const square = (s: number): Vec2[] => [
  { x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s },
];

// 90° V-bit: tan(45°) = 1, so depth(r) = r — the cleanest case to assert on.
const P90 = (over: Partial<VCarveParams> = {}): VCarveParams => ({
  vAngle: 90, maxDepth: 0, stepMM: 1, ...over,
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
    const hole: Vec2[] = [ // CW 4×4 hole centred in the square
      { x: 8, y: 8 }, { x: 8, y: 12 }, { x: 12, y: 12 }, { x: 12, y: 8 },
    ];
    const passes = vcarveRegion(outer, [hole], P90({ stepMM: 0.5 }));
    expect(passes.length).toBeGreaterThan(0);
    // Early passes must show the outer ring AND the (growing) hole ring distinctly.
    expect(passes[0].loops.length).toBeGreaterThanOrEqual(2);
  });

  it("accepts a single hole ring via the Vec2[] overload", () => {
    const hole: Vec2[] = [
      { x: 8, y: 8 }, { x: 8, y: 12 }, { x: 12, y: 12 }, { x: 12, y: 8 },
    ];
    const a = vcarveRegion(square(20), hole, P90({ stepMM: 0.5 }));
    const b = vcarveRegion(square(20), [hole], P90({ stepMM: 0.5 }));
    expect(a.length).toBe(b.length);
  });

  it("returns nothing for degenerate inputs", () => {
    expect(vcarveRegion([{ x: 0, y: 0 }, { x: 1, y: 0 }], [], P90())).toEqual([]); // <3 verts
    expect(vcarveRegion(square(20), [], P90({ stepMM: 0 }))).toEqual([]);          // no step
    expect(vcarveRegion(square(20), [], P90({ vAngle: 0 }))).toEqual([]);          // flat bit
  });
});
