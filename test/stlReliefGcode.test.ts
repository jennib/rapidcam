/**
 * An imported STL, posted as real G-code, checked against the analytic solid.
 *
 * Everything else about this feature is tested a stage at a time — the parser,
 * the rasteriser, the encoding resolver — and every one of those can pass while
 * the wiring between them is wrong. This is the only test that starts from
 * triangles and finishes at commanded tool positions, and it compares them
 * against `√(R²−r²)` rather than against anything the pipeline computed, so it
 * cannot agree with a mistake by sharing it.
 *
 * ## The tolerance is derived, not tuned
 *
 * A height map SAMPLES the solid, so the program cannot reproduce it exactly and
 * the gap is quantifiable rather than mysterious:
 *
 * - **Level quantisation.** `depth/255` — the 8-bit decision, written down here
 *   so the figure has a test attached to it rather than only a plan entry.
 * - **Lateral sampling.** The field reads the dome at cell centres and averages
 *   those into dots, so at a point up to `(cell + dotPitch)/2` away from a
 *   sample the true surface has moved by `slope × that`.
 *
 * Near the rim a hemisphere's slope runs to infinity, so that second term does
 * too: no heightfield reproduces a vertical wall, which is exactly why Easel
 * tells users that models with a flat back work best. The analytic comparison is
 * therefore made over the dome's GENTLE region and the steep rim is asserted
 * separately (and weakly — only that it never cuts past the base).
 */
import { describe, expect, test } from "vitest";
import { generateGCode } from "../src/cam/gcode";
import { stlHeightfield } from "../src/cam/stlHeightfield";
import { ballHeight } from "../src/cam/toolProfile";
import { DEFAULTS, type CAMOperation } from "../src/cam/types";
import { registerHeightfield } from "../src/core/imageManager";
import { parseSTL } from "../src/io/stlImport";
import { CADDocument } from "../src/model/document";
import { RasterImageEntity } from "../src/model/entities";
import { binarySTL, hemisphere } from "./stlFixtures";

const R = 10; // dome radius = model height range = carve depth
const CELL = 0.1;
const TOOL_R = 1.5; // ⌀3 ball-nose

/** Build the doc exactly as the importer does, and post it. */
function postDome(): { gcode: string; depth: number } {
  const mesh = parseSTL(binarySTL(hemisphere(R, 96, 192)));
  const hf = stlHeightfield(mesh, { cellMM: CELL });
  const depth = hf.zMaxMM - hf.zMinMM;
  const id = registerHeightfield("dome", hf.width, hf.height, hf.gray, { zRangeMM: depth });

  // Stock at the origin with a left/front/top datum, so G-code coordinates are
  // document coordinates and Z0 is the stock top — no offset to undo below.
  const doc = new CADDocument({ width: 2 * R, height: 2 * R });
  doc.stockRect = { x: 0, y: 0, width: 2 * R, height: 2 * R };
  doc.stockThickness = 25;
  doc.origin = { x: "left", y: "front", z: "top" };
  const img = doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, hf.widthMM, hf.heightMM, 0));

  const op: CAMOperation = {
    id: "o1",
    name: "Relief finish",
    type: "engrave",
    entityIds: [img.id],
    side: "outside",
    toolType: "ball-nose",
    toolNumber: 1,
    diameter: TOOL_R * 2,
    feedrate: 1200,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -depth,
    stepdown: depth, // one pass, so every commanded Z is a final surface
    stepover: 0.4,
  };
  doc.operations.push(op);
  return { gcode: generateGCode(doc.operations, doc), depth };
}

/**
 * Modal parse of the cutting moves, sampled ALONG each segment.
 *
 * Endpoints alone are not the tool's path. The emitter merges equal-Z dots into
 * one straight move, so the whole flat cap over the dome's apex is a single G1
 * whose endpoint is somewhere past it — read only the endpoints and the apex
 * appears never to be visited at all. The tool traverses every point of a G1, so
 * every point of it has to satisfy the invariants below.
 */
function tipPositions(gcode: string, step = 0.05): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = [];
  let x = 0,
    y = 0,
    z = 0;
  for (const raw of gcode.split("\n")) {
    const line = raw.split(";")[0].trim();
    if (!line) continue;
    const g = /\bG([0-3])\b/.exec(line);
    const mx = /X(-?[\d.]+)/.exec(line);
    const my = /Y(-?[\d.]+)/.exec(line);
    const mz = /Z(-?[\d.]+)/.exec(line);
    const px = x,
      py = y,
      pz = z;
    if (mx) x = Number.parseFloat(mx[1]);
    if (my) y = Number.parseFloat(my[1]);
    if (mz) z = Number.parseFloat(mz[1]);
    if (g?.[1] !== "1") continue;
    const n = Math.max(1, Math.ceil(Math.hypot(x - px, y - py) / step));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      out.push({ x: px + (x - px) * t, y: py + (y - py) * t, z: pz + (z - pz) * t });
    }
  }
  return out;
}

/**
 * The exact drop-cutter answer for a ball on this dome: a ball of radius `Rt`
 * resting on a sphere of radius `R` has its CENTRE on a sphere of radius `R+Rt`,
 * so a tip at lateral radius `r` sits at `√((R+Rt)²−r²) − Rt`, and `−R` puts the
 * dome's apex at the stock top. This is what `toolContactField` approximates by
 * dilating a sampled grid, so it is the reference the posted program is graded
 * against — computed from the solid, never from anything the pipeline produced.
 */
function exactBallTip(r: number): number {
  const Rc = R + TOOL_R;
  return Math.sqrt(Rc * Rc - r * r) - TOOL_R - R;
}

/** Slope of that tip curve — the lateral-sampling term of the tolerance. */
function tipSlope(r: number): number {
  const Rc = R + TOOL_R;
  return r / Math.sqrt(Rc * Rc - r * r);
}

/**
 * The analytic surface in machine Z: the dome's top sits at the stock top, so a
 * point at radius r is `√(R²−r²) − R`, and anything outside the silhouette is the
 * base plane at `−R`.
 */
function trueSurface(x: number, y: number): number {
  const r = Math.hypot(x - R, y - R); // model centred in its own bounding box
  return r >= R ? -R : Math.sqrt(R * R - r * r) - R;
}

const posted = postDome();
const tips = tipPositions(posted.gcode);

describe("a hemisphere STL, posted as a relief", () => {
  test("the program actually cuts something", () => {
    expect(tips.length).toBeGreaterThan(5000);
    expect(posted.depth).toBeCloseTo(R, 6);
  });

  test("the model's top surface is not cut", () => {
    // The apex is byte 255. A photograph's 0.96 white threshold would blank the
    // whole near-white cap, and a gamma would bend it — this is that whole class
    // of bug, checked at the far end of the pipeline in emitted coordinates.
    const apex = tips.filter((p) => Math.hypot(p.x - R, p.y - R) < 0.3);
    expect(apex.length).toBeGreaterThan(20);
    for (const p of apex) expect(p.z).toBeGreaterThan(-0.1);
  });

  test("outside the model's silhouette it cuts to the base, and never past it", () => {
    // Clear of the dome by the tool radius AND a margin: `toolContactField`
    // measures to a cell's NEAR EDGE, so the tool's influence reaches about half
    // a pitch further than R + TOOL_R and the boundary itself is legitimately
    // fuzzy. Sampling exactly on it reads a tool already being lifted.
    const clear = R + TOOL_R + 0.5;
    const corner = tips.filter((p) => Math.hypot(p.x - R, p.y - R) > clear);
    expect(corner.length).toBeGreaterThan(100);
    for (const p of corner) expect(p.z).toBeCloseTo(-R, 3);
    // Nothing anywhere may cut past the model's base plane.
    for (const p of tips) expect(p.z).toBeGreaterThanOrEqual(-R - 1e-6);
  });

  test("the ball's flank never breaks through the analytic dome", () => {
    // The gouge test, against the solid rather than against the sampled field.
    // Restricted to the dome's gentle region — see the header on why the rim
    // cannot be held to this, and it is the reason relief-styled models are the
    // documented input for every tool in this school.
    const RGENTLE = 0.7 * R;
    const maxSlope = RGENTLE / Math.sqrt(R * R - RGENTLE * RGENTLE);
    const tol =
      posted.depth / 255 + // 8-bit level quantum
      maxSlope * (CELL + DEFAULTS.rasterLineInterval) + // lateral sampling
      1e-6;

    let worst = 0;
    let checked = 0;
    for (const p of tips) {
      if (Math.hypot(p.x - R, p.y - R) > RGENTLE) continue;
      checked++;
      // Sample the tool's own footprint: the body at lateral offset d sits
      // ballHeight(d) above the tip, and must clear the surface out there.
      for (let d = 0; d <= TOOL_R + 1e-9; d += TOOL_R / 6) {
        const lift = ballHeight(d, TOOL_R);
        if (!Number.isFinite(lift)) continue;
        for (let a = 0; a < 8; a++) {
          const th = (a / 8) * 2 * Math.PI;
          const s = trueSurface(p.x + d * Math.cos(th), p.y + d * Math.sin(th));
          worst = Math.max(worst, s - (p.z + lift)); // >0 means the body is through it
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
    expect(worst).toBeLessThanOrEqual(tol);
  });

  test("the tip traces the exact ball-on-sphere curve, biased to the safe side", () => {
    // The positive control the gouge test needs: a program that simply never
    // descended would pass that one. This grades the commanded tip against the
    // closed-form drop-cutter answer, two-sided.
    const RGENTLE = 0.7 * R;
    let worstHigh = 0; // riding above the curve: leaves material, safe
    let worstLow = 0; // dipping below it: cutting into the dome, the bug
    let checked = 0;
    for (const p of tips) {
      const r = Math.hypot(p.x - R, p.y - R);
      if (r > RGENTLE) continue;
      checked++;
      const d = p.z - exactBallTip(r);
      worstHigh = Math.max(worstHigh, d);
      worstLow = Math.min(worstLow, d);
    }
    expect(checked).toBeGreaterThan(2000);

    // Upper bound, derived: the 8-bit level quantum (and the dilation floors
    // levels DOWN, i.e. shallower), plus what the curve climbs across one
    // sample step in each axis.
    const tol = posted.depth / 255 + tipSlope(RGENTLE) * (CELL + DEFAULTS.rasterLineInterval);
    expect(worstHigh).toBeLessThanOrEqual(tol);

    // Lower bound: it may under-read the dome by at most the same sampling error
    // — but measured, it never goes below the curve at all. Assert the strong
    // fact, since that is the one that means "does not cut into the model".
    expect(worstLow).toBeGreaterThanOrEqual(-1e-6);
  });
});
