/**
 * Stepover ↔ cusp height: sizing a finish pass by the SURFACE IT LEAVES rather
 * than by a fraction someone remembered.
 *
 * Two adjacent passes of a shaped bit cannot meet flush. Between them stands a
 * ridge — the **cusp**, or **scallop**; the two words are the same measurement —
 * whose height is the tool's own flank height at half the spacing:
 *
 *     cusp = height(spacing / 2)
 *
 * For a ball-nose that is the textbook `R − √(R² − (s/2)²)`, but nothing here
 * types that law out again. {@link ToolProfile.height} already owns it, because
 * the gouge correction needs the identical curve — and a cusp computed from a
 * second copy of the flank arithmetic would be free to disagree with the depths
 * the program actually cuts. Reading it off the profile makes that impossible,
 * and gets the V-bit (`d / tan(½θ)`) and the flat end mill (0 out to its own
 * edge) for nothing.
 *
 * ## The inverse is already there too
 *
 * {@link ToolProfile.reach} solves `height(d) = h` for `d` — it exists to bound
 * the dilation footprint, but that is exactly the inversion this calculator
 * needs. So `spacingForCusp` is `2 · reach(cusp)`, and the round trip through
 * the pair is the identity (guarded in `test/scallop.test.ts`). One law, read
 * forwards for a readout and backwards for a calculator.
 *
 * ## What the numbers mean in practice
 *
 * Vectric's stated rule of thumb for a 3-D finish pass is **8–12% of the cutter
 * diameter**, which is where {@link FINISH_STEPOVER_FRACTION} comes from and
 * what {@link cuspReadout} sanity-checks against. The rule is a good default and
 * a bad answer, because for a small stepover the cusp works out at
 *
 *     cusp ≈ s² / 8R  =  f²·d / 4
 *
 * — **linear in the tool diameter**. So one percentage is six different
 * surfaces across the bits in a drawer: 10% leaves 15 µm on a ⌀6 ball and 2.5 µm
 * on a ⌀1, and the user wanted a finish, not a percentage. Hence the calculator —
 * hold the cusp, let the stepover follow the bit, which is how the CAM packages
 * that expose both fields (PowerMill, Mastercam) link them.
 */

import { toolProfile, type ToolShape } from "./toolProfile";

/**
 * Default finish stepover as a fraction of cutter diameter — the middle of the
 * 8–12% band below. The relief dialog seeds the stepover with this, so a
 * ⌀6 ball starts at 0.6 mm and a ⌀1 at 0.1 mm rather than both at some fixed
 * pitch that is a needlessly long cut for one and a rough surface on the other.
 */
export const FINISH_STEPOVER_FRACTION = 0.1;

/** Vectric's 3-D finish-pass range, as a fraction of cutter diameter. */
export const FINISH_STEPOVER_BAND: readonly [number, number] = [0.08, 0.12];

/**
 * The cusp left standing between two passes `spacing` mm apart, mm.
 *
 * `Infinity` when the spacing is wider than the tool: the passes never touch,
 * so what stands between them is not a cusp at all but full-height uncut stock,
 * and no finite number describes it (its height is whatever the cut is deep).
 * Callers must say that out loud rather than print a big number.
 */
export function cuspHeight(tool: ToolShape, spacing: number): number {
  if (!(spacing > 0)) return 0;
  return toolProfile(tool).height(spacing / 2);
}

/**
 * The widest pass spacing whose cusp is no taller than `cusp` mm.
 *
 * Saturates at the tool diameter — past the equator a ball-nose has no more
 * flank to climb, so asking for a cusp taller than its radius cannot buy any
 * more spacing. A flat end mill has no flank at all and so answers "the whole
 * diameter" to every cusp, which is the right answer for a flat floor.
 */
export function spacingForCusp(tool: ToolShape, cusp: number): number {
  if (!(cusp > 0)) return 0;
  return 2 * toolProfile(tool).reach(cusp);
}

/** Everything a UI or a G-code comment needs to say about a chosen stepover. */
export interface CuspReadout {
  /** Cusp height, mm (`Infinity` when the passes don't overlap). */
  cusp: number;
  /** Stepover as a fraction of the cutter diameter. */
  fraction: number;
  /** Do adjacent passes touch at all? False = full-height ridges left standing. */
  overlapping: boolean;
  /** Within Vectric's 8–12% rule of thumb for a 3-D finish. */
  inBand: boolean;
  /** The stepover {@link FINISH_STEPOVER_FRACTION} would have chosen, mm. */
  suggested: number;
}

/**
 * The judgement about a stepover, in one place. The dialog and the posted
 * program both report it, and this project's standing defect is one fact
 * written twice — so "is this stepover sane" is decided here or nowhere.
 */
export function cuspReadout(tool: ToolShape, spacing: number): CuspReadout {
  // The cusp between two finish passes is carved by the TIP. For a ball-nose the
  // tip IS the diameter; for a tapered ball-nose the tip is the ball (`tipDiameter`),
  // not the major diameter the fraction/band would otherwise quote. Using the major
  // here would suggest a stepover that leaves a huge ridge on the small tip.
  const d = Math.max(
    0,
    tool.toolType === "tapered-ball-nose" ? (tool.tipDiameter ?? tool.diameter) : tool.diameter,
  );
  const cusp = cuspHeight(tool, spacing);
  return {
    cusp,
    fraction: d > 0 ? spacing / d : 0,
    overlapping: Number.isFinite(cusp),
    inBand:
      d > 0 &&
      spacing >= d * FINISH_STEPOVER_BAND[0] &&
      spacing <= d * FINISH_STEPOVER_BAND[1],
    suggested: d * FINISH_STEPOVER_FRACTION,
  };
}
