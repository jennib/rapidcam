import { test, expect } from "vitest";
import {
  FINISH_STEPOVER_BAND,
  FINISH_STEPOVER_FRACTION,
  cuspHeight,
  cuspReadout,
  spacingForCusp,
} from "../src/cam/scallop";
import type { ToolShape } from "../src/cam/toolProfile";

const ball = (diameter: number): ToolShape => ({ toolType: "ball-nose", diameter });
const vbit = (diameter: number, vAngle: number, tipDiameter = 0): ToolShape => ({
  toolType: "v-bit",
  diameter,
  vAngle,
  tipDiameter,
});

// --- the law itself ---------------------------------------------------------

test("ball-nose cusp matches the closed form R - sqrt(R^2 - (s/2)^2)", () => {
  const R = 1.5; // a ⌀3 ball
  for (const s of [0.05, 0.1, 0.3, 0.6, 1.2, 2.4]) {
    const closed = R - Math.sqrt(R * R - (s / 2) ** 2);
    expect(cuspHeight(ball(2 * R), s)).toBeCloseTo(closed, 12);
  }
});

test("at a fixed percentage the cusp scales with the bit — 15µm on a ⌀6, 2.5µm on a ⌀1", () => {
  // The reason the calculator exists: one percentage, six times the ridge.
  // Positive control on the pair — both must be the stated size, not merely
  // different from each other.
  expect(cuspHeight(ball(6), 6 * FINISH_STEPOVER_FRACTION) * 1000).toBeCloseTo(15.0, 1);
  expect(cuspHeight(ball(1), 1 * FINISH_STEPOVER_FRACTION) * 1000).toBeCloseTo(2.5, 1);
  // ...because cusp ≈ s²/8R = f²·d/4 for a small stepover: linear in diameter.
  const f = FINISH_STEPOVER_FRACTION;
  expect(cuspHeight(ball(6), 6 * f)).toBeCloseTo((f * f * 6) / 4, 4);
});

test("V-bit cusp is the cone's own flank height at half the spacing", () => {
  // 90° included → half-angle 45° → tan 1 → the cusp is exactly half the spacing.
  expect(cuspHeight(vbit(6, 90), 0.5)).toBeCloseTo(0.25, 12);
  // 60° included → half-angle 30° → tan(30°); the flank climbs faster, so the
  // same spacing leaves a TALLER ridge.
  expect(cuspHeight(vbit(6, 60), 0.5)).toBeCloseTo(0.25 / Math.tan(Math.PI / 6), 12);
  // A flat tip cuts flat out to its own edge before the cone starts.
  expect(cuspHeight(vbit(6, 90, 1), 0.5)).toBe(0);
});

test("a flat end mill leaves no cusp at any spacing up to its diameter", () => {
  const mill: ToolShape = { toolType: "end-mill", diameter: 6 };
  expect(cuspHeight(mill, 0.6)).toBe(0);
  expect(cuspHeight(mill, 6)).toBe(0);
  // Past the diameter the passes stop touching — see below.
  expect(cuspHeight(mill, 6.5)).toBe(Infinity);
});

test("spacing wider than the tool is not a tall cusp, it is no cusp", () => {
  // What stands between passes that never meet is uncut stock at full height,
  // and a finite number would misdescribe it as a surface finish.
  expect(cuspHeight(ball(3), 3.5)).toBe(Infinity);
  expect(cuspReadout(ball(3), 3.5).overlapping).toBe(false);
  // Positive control: one step inside the diameter it IS a cusp, and a real one.
  expect(cuspReadout(ball(3), 2.9).overlapping).toBe(true);
  expect(cuspHeight(ball(3), 2.9)).toBeGreaterThan(0);
});

test("no spacing, no cusp", () => {
  expect(cuspHeight(ball(3), 0)).toBe(0);
  expect(cuspHeight(ball(3), -1)).toBe(0);
  expect(spacingForCusp(ball(3), 0)).toBe(0);
});

// --- the two directions cannot drift ----------------------------------------

test("cusp → spacing → cusp is the identity", () => {
  // This is the guard that matters: `spacingForCusp` inverts through
  // `ToolProfile.reach`, which exists for the dilation footprint rather than for
  // this. If the two ever describe different tools, the calculator would quietly
  // hand back a stepover that leaves a different surface than it promised.
  for (const tool of [ball(6), ball(1), vbit(6, 60), vbit(6, 90, 0.5)]) {
    for (const cusp of [0.001, 0.005, 0.02, 0.1, 0.4]) {
      const s = spacingForCusp(tool, cusp);
      expect(s).toBeGreaterThan(0);
      expect(cuspHeight(tool, s)).toBeCloseTo(cusp, 9);
    }
  }
});

test("spacing → cusp → spacing is the identity too", () => {
  const tool = ball(6);
  for (const s of [0.1, 0.48, 0.6, 1.2, 3]) {
    expect(spacingForCusp(tool, cuspHeight(tool, s))).toBeCloseTo(s, 9);
  }
});

test("a cusp taller than the ball's radius cannot buy more than the diameter", () => {
  // Past the equator there is no more flank to climb, so the answer saturates
  // rather than running off to a spacing the tool cannot span.
  expect(spacingForCusp(ball(3), 10)).toBe(3);
  expect(spacingForCusp(ball(3), 1.5)).toBeCloseTo(3, 12);
});

// --- the sanity check -------------------------------------------------------

test("the shipped default sits inside the band it is checked against", () => {
  const [lo, hi] = FINISH_STEPOVER_BAND;
  expect(FINISH_STEPOVER_FRACTION).toBeGreaterThanOrEqual(lo);
  expect(FINISH_STEPOVER_FRACTION).toBeLessThanOrEqual(hi);
  const r = cuspReadout(ball(6), 6 * FINISH_STEPOVER_FRACTION);
  expect(r.inBand).toBe(true);
  expect(r.fraction).toBeCloseTo(FINISH_STEPOVER_FRACTION, 12);
  expect(r.suggested).toBeCloseTo(0.6, 12);
});

test("out-of-band stepovers are called out in both directions", () => {
  expect(cuspReadout(ball(6), 0.3).inBand).toBe(false); // 5% — needlessly slow
  expect(cuspReadout(ball(6), 1.2).inBand).toBe(false); // 20% — coarse
  expect(cuspReadout(ball(6), 0.48).inBand).toBe(true); // 8%, the low edge
  expect(cuspReadout(ball(6), 0.72).inBand).toBe(true); // 12%, the high edge
});

test("a tool with no diameter reports no fraction rather than a NaN", () => {
  const r = cuspReadout({ toolType: "ball-nose", diameter: 0 }, 0.3);
  expect(r.fraction).toBe(0);
  expect(r.inBand).toBe(false);
  expect(r.suggested).toBe(0);
});

// --- the tapered ball-nose (a cone with a ball tip) -------------------------

const tapered = (diameter: number, tipDiameter: number, vAngle: number): ToolShape => ({
  toolType: "tapered-ball-nose",
  diameter,
  tipDiameter,
  vAngle,
});

test("a tapered ball-nose's cusp tracks the ball tip, not the major diameter", () => {
  // ⌀6 body, ⌀1 ball tip, 6° included taper. Inside the tip radius the cusp is
  // the ⌀1 ball's. The mutation — computing it as a plain ⌀6 ball — would
  // silently understate the ridge and overstate the safe stepover.
  const t = tapered(6, 1, 6);
  const spacing = 0.5; // s/2 = 0.25, inside the 0.5mm tip radius
  const tipR = 0.5;
  const ballTipCusp = tipR - Math.sqrt(tipR * tipR - 0.25 * 0.25);
  expect(cuspHeight(t, spacing)).toBeCloseTo(ballTipCusp, 12);
  expect(cuspHeight(t, spacing)).not.toBeCloseTo(cuspHeight(ball(6), spacing), 12);
});

test("cuspReadout quotes the tip diameter for the band, not the body", () => {
  // The suggested stepover must scale with the BALL (⌀1), or the 0.6mm default
  // for a ⌀6 would leave a huge ridge on the small tip.
  const r = cuspReadout(tapered(6, 1, 6), 0.1); // 10% of the ⌀1 tip
  expect(r.fraction).toBeCloseTo(0.1, 12);
  expect(r.suggested).toBeCloseTo(0.1, 12); // 10% of ⌀1, not ⌀6
  expect(r.inBand).toBe(true);
});
