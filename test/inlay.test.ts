import { describe, expect, test } from "vitest";
import {
  DEFAULT_INLAY_FIT,
  enclosingContour,
  inlayContours,
  inlayParams,
  inlayRegions,
  mirrorX,
  radialClearance,
} from "../src/cam/inlay";
import { vcarveRegion, type VCarveParams } from "../src/cam/vcarve";
import type { Vec2 } from "../src/core/vec2";

/**
 * A 90° V-bit is used throughout because tan(45°) = 1 exactly, so every depth
 * converts to a radial offset of the same number and the arithmetic below can
 * be read without a calculator. The relations under test are not special to
 * 90°; `radialClearance` is checked separately at another angle.
 */
const V90: VCarveParams = { vAngle: 90, maxDepth: 0, stepMM: 0.25 };

/** A square of side `s` centred on the origin, wound CCW. */
function square(s: number): Vec2[] {
  const h = s / 2;
  return [
    { x: -h, y: -h },
    { x: h, y: -h },
    { x: h, y: h },
    { x: -h, y: h },
  ];
}

/** Half-width (max |x|) of a ring — for a centred square, its half-side. */
function halfWidth(ring: Vec2[]): number {
  return Math.max(...ring.map((p) => Math.abs(p.x)));
}

describe("the fit — measured, not asserted", () => {
  /**
   * THE ASSERTION THE WHOLE FEATURE RESTS ON.
   *
   * Both sides come off the same bit, so both flanks have the same slope. What
   * makes the plug fit is that it is NARROWER than the pocket by the same
   * amount at every depth. Here that amount must be exactly
   * `glueGap · tan(½·vAngle)` — with a 90° bit, exactly the glue gap.
   *
   * Measured off the generated toolpaths, not computed from the formula the
   * code uses, so a sign error in `startDepth` cannot pass.
   */
  test("the plug is narrower than the pocket by glueGap·tan(half) at EVERY depth", () => {
    const design = square(20); // half-width 10
    const fit = { pocketDepth: 3, glueGap: 0.5, sawAllowance: 1 };

    const female = vcarveRegion(design, [], inlayParams(V90, "female", fit));
    const maleRegion = inlayRegions([design], "male", 10)[0];
    const male = vcarveRegion(maleRegion.outer, maleRegion.holes, inlayParams(V90, "male", fit));

    // Pocket wall at depth d: inset by d (tan45 = 1) → half-width 10 − d.
    for (const p of female) {
      const d = Math.abs(p.depth);
      if (d >= 3 - 1e-6) continue; // at the floor it is clamped, not on the flank
      expect(halfWidth(p.loops[0]), `pocket wall at depth ${d}`).toBeCloseTo(10 - d, 2);
    }

    // Plug flank at depth d: outset by (d − gap) → half-width 10 + d − 0.5.
    // The plug's own ring is the SMALLER of the two (the other is the boundary
    // rectangle closing in from outside).
    let checked = 0;
    for (const p of male) {
      const d = Math.abs(p.depth);
      if (d <= fit.glueGap + 1e-6 || d >= 3 + 1 - 1e-6) continue;
      const plugRing = p.loops.reduce((a, b) => (halfWidth(a) < halfWidth(b) ? a : b));
      expect(halfWidth(plugRing), `plug flank at depth ${d}`).toBeCloseTo(10 + d - 0.5, 2);
      checked++;
    }
    // Guards against the loop above passing by never running — the failure mode
    // that makes a "0 of 0 checked" test look green.
    expect(checked, "the male must actually produce flank passes").toBeGreaterThan(4);
  });

  test("zero glue gap makes the two surfaces identical — the control", () => {
    // With no clearance the plug is the exact negative of the pocket, which is
    // why a real inlay needs a gap at all. This pins that the gap is doing the
    // work, not some other asymmetry between the two paths.
    const design = square(20);
    const fit = { pocketDepth: 3, glueGap: 0, sawAllowance: 0 };

    const female = vcarveRegion(design, [], inlayParams(V90, "female", fit));
    const maleRegion = inlayRegions([design], "male", 10)[0];
    const male = vcarveRegion(maleRegion.outer, maleRegion.holes, inlayParams(V90, "male", fit));

    const atDepth = (passes: typeof female, d: number) =>
      passes.find((p) => Math.abs(Math.abs(p.depth) - d) < 1e-6);

    const f = atDepth(female, 1.5);
    const m = atDepth(male, 1.5);
    expect(f && m, "both sides must reach 1.5mm").toBeTruthy();
    // Pocket 10 − 1.5 = 8.5 in; plug 10 + 1.5 = 11.5 out. Mirror images about
    // the design edge: equal and opposite offsets of 1.5.
    expect(10 - halfWidth(f!.loops[0])).toBeCloseTo(1.5, 2);
    const plug = m!.loops.reduce((a, b) => (halfWidth(a) < halfWidth(b) ? a : b));
    expect(halfWidth(plug) - 10).toBeCloseTo(1.5, 2);
  });

  test("the male runs deeper than the pocket by the saw allowance", () => {
    const design = square(20);
    const fit = { pocketDepth: 3, glueGap: 0.5, sawAllowance: 1.5 };
    const maleRegion = inlayRegions([design], "male", 10)[0];
    const male = vcarveRegion(maleRegion.outer, maleRegion.holes, inlayParams(V90, "male", fit));
    const deepest = Math.max(...male.map((p) => Math.abs(p.depth)));

    expect(deepest).toBeCloseTo(4.5, 2); // 3 + 1.5 — stock to saw through
  });
});

describe("the region the male carves", () => {
  test("a generated boundary turns the design into HOLES — the complement, free", () => {
    // This is the whole reason no complement code exists: even-odd nesting in
    // groupContoursIntoRegions already does it.
    const regions = inlayRegions([square(20)], "male", 5);

    expect(regions).toHaveLength(1);
    expect(halfWidth(regions[0].outer)).toBeCloseTo(15, 6); // 10 + 5 margin
    expect(regions[0].holes).toHaveLength(1);
    expect(halfWidth(regions[0].holes[0])).toBeCloseTo(10, 6);
  });

  test("the female is just the design — no boundary, no mirror", () => {
    const regions = inlayRegions([square(20)], "female", 5);
    expect(regions).toHaveLength(1);
    expect(halfWidth(regions[0].outer)).toBeCloseTo(10, 6);
    expect(regions[0].holes).toHaveLength(0);
  });

  test("a boundary the user drew is used instead of a generated one", () => {
    // The Vectric habit: draw a rectangle round the design. Honour it exactly
    // rather than inventing a second one outside it.
    const user = square(40); // half-width 20, nothing like the 5mm margin
    const regions = inlayRegions([square(20), user], "male", 5);

    expect(regions).toHaveLength(1);
    expect(halfWidth(regions[0].outer)).toBeCloseTo(20, 6);
  });

  test("enclosingContour finds a ring only when it encloses everything", () => {
    expect(enclosingContour([square(20), square(40)])).not.toBeNull();
    // Two overlapping-but-not-nested rings: neither encloses the other.
    const offset = square(20).map((p) => ({ x: p.x + 30, y: p.y }));
    expect(enclosingContour([square(20), offset])).toBeNull();
  });
});

describe("the mirror", () => {
  test("mirroring preserves winding, or every solid becomes a hole", () => {
    // A reflection alone reverses orientation. If the ring order were not also
    // reversed, groupContoursIntoRegions would still work (it uses containment,
    // not winding) but Clipper's inset would carve the wrong side.
    const tri: Vec2[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ];
    const area = (r: Vec2[]) =>
      r.reduce((s, p, i) => {
        const q = r[(i + 1) % r.length];
        return s + (p.x * q.y - q.x * p.y);
      }, 0) / 2;

    expect(area(tri)).toBeGreaterThan(0);
    expect(area(mirrorX([tri])[0])).toBeGreaterThan(0);
  });

  test("the male is mirrored and the female is not", () => {
    // An asymmetric design, so the mirror is detectable at all.
    const wedge: Vec2[] = [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 0, y: 10 },
    ];
    const f = inlayContours([wedge], "female", 5);
    const m = inlayContours([wedge], "male", 5);

    expect(f[0].map((p) => p.x)).toEqual([0, 30, 0]);

    // The wedge has TWO vertices sharing one x and one lone vertex opposite —
    // so "the apex" is only well defined as *the x that occurs once*. In the
    // original that lone vertex is at max x; a mirror must move it to min x.
    // (An earlier version of this test asked for "the point at max x" and got
    // whichever of the two duplicates came first.)
    const loneExtreme = (ring: Vec2[]): "min" | "max" => {
      const xs = ring.map((p) => Math.round(p.x * 1e6) / 1e6);
      const lone = xs.find((x) => xs.filter((y) => y === x).length === 1);
      expect(lone, "the wedge must have exactly one lone x").toBeDefined();
      return lone === Math.max(...xs) ? "max" : "min";
    };

    const ring = m.reduce((a, b) => (a.length <= b.length ? a : b));
    expect(loneExtreme(f[0])).toBe("max");
    expect(loneExtreme(ring), "the male must be mirrored").toBe("min");
  });
});

describe("radialClearance", () => {
  test("is linear in the gap and scales with the bit angle", () => {
    expect(radialClearance(0.5, 90)).toBeCloseTo(0.5, 6); // tan45 = 1
    expect(radialClearance(0.5, 60)).toBeCloseTo(0.5 * Math.tan(Math.PI / 6), 6);
    expect(radialClearance(1.0, 90)).toBeCloseTo(1.0, 6);
    expect(radialClearance(-1, 90)).toBe(0); // a negative gap is not a press fit
  });

  test("a shallower bit gives LESS clearance for the same gap", () => {
    // Worth pinning: users think in glue gap, but the fit they feel is the
    // radial number, and a 30° bit gives a quarter of what a 90° bit does.
    expect(radialClearance(1, 30)).toBeLessThan(radialClearance(1, 90));
  });
});

describe("defaults", () => {
  test("the shipped fit is a sane starting point", () => {
    expect(DEFAULT_INLAY_FIT.glueGap).toBeGreaterThan(0);
    expect(DEFAULT_INLAY_FIT.sawAllowance).toBeGreaterThan(0);
    expect(DEFAULT_INLAY_FIT.pocketDepth).toBeGreaterThan(DEFAULT_INLAY_FIT.glueGap);
  });
});
