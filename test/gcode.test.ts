/**
 * G-code post-processor tests. Run with: npx tsx test/gcode.test.ts
 *
 * Focuses on LinuxCNC G5 coordinate math (the trickiest part — relative offsets
 * from endpoints, not absolute control points) and verifies GRBL falls back to G1.
 */

import { test, expect } from "vitest";
import { LinuxCNC } from "../src/cam/postprocessors/linuxcnc";
import { Grbl } from "../src/cam/postprocessors/grbl";
import { n } from "../src/cam/postprocessors/base";
import { getPostProcessor, generateGCode } from "../src/cam/gcode";
import type { CAMOperation } from "../src/cam/types";
import { CADDocument } from "../src/model/document";
import { ArcEntity, RectEntity, CircleEntity } from "../src/model/entities";

// Each numbered block below computes a boolean eagerly and registers it as a
// vitest assertion via check(). Run with `npx vitest run` (or `npx tsx` for the
// old script-style console output is no longer supported — assertions only).
function check(name: string, ok: boolean, detail = ""): void {
  test(name, () => { expect(ok, detail).toBe(true); });
}

const OP: CAMOperation = {
  id: "op1", name: "test", type: "engrave",
  entityIds: [], side: "outside",
  toolNumber: 1, diameter: 3,
  feedrate: 1000, plungeRate: 300, spindleSpeed: 18000,
  safeZ: 5, depth: -3, stepdown: 1.5,
};

// Sample bezier (from the Untitled.rcam fixture)
const p0 = { x: 48, y: 68 };
const p1 = { x: 96, y: 80 };
const p2 = { x: 80, y: 100 };
const p3 = { x: 100, y: 104 };

// 1) G5 relative offset math -----------------------------------------------
{
  console.log("\n1) G5 relative offset math");
  const pp = new LinuxCNC();
  const lines = pp.engraveBezier(p0, p1, p2, p3, OP, 0, 0, 0);
  const g5Lines = lines.filter(l => l.startsWith("G5 "));

  check("emits at least one G5 command", g5Lines.length > 0);

  const g5 = g5Lines[0];
  const I = n(p1.x - p0.x);  // 48  — offset from current pos (p0) to first handle (p1)
  const J = n(p1.y - p0.y);  // 12
  const P = n(p2.x - p3.x);  // -20 — offset from end point (p3) to second handle (p2)
  const Q = n(p2.y - p3.y);  // -4
  const ex = n(p3.x);        // 100 — end point in WCS
  const ey = n(p3.y);        // 104

  check(`I=${I} (p1.x − p0.x)`, g5.includes(`I${I}`),   g5);
  check(`J=${J} (p1.y − p0.y)`, g5.includes(`J${J}`),   g5);
  check(`P=${P} (p2.x − p3.x)`, g5.includes(`P${P}`),   g5);
  check(`Q=${Q} (p2.y − p3.y)`, g5.includes(`Q${Q}`),   g5);
  check(`X=${ex} (end point)`,   g5.includes(`X${ex}`),  g5);
  check(`Y=${ey} (end point)`,   g5.includes(`Y${ey}`),  g5);
}

// 2) Depth passes ---------------------------------------------------------------
{
  console.log("\n2) Depth passes  (depth=-3, stepdown=1.5 → two passes)");
  const pp = new LinuxCNC();
  const lines = pp.engraveBezier(p0, p1, p2, p3, OP, 0, 0, 0);
  const g5Lines   = lines.filter(l => l.startsWith("G5 "));
  const plunges   = lines.filter(l => l.startsWith("G1 Z"));

  check("two G5 commands (one per pass)", g5Lines.length === 2, `got ${g5Lines.length}`);
  check("first plunge to Z-1.5",  plunges[0]?.includes("Z-1.5"), plunges[0]);
  check("second plunge to Z-3",   plunges[1]?.includes("Z-3"),   plunges[1]);
}

// 3) Retract / rapid structure ------------------------------------------------
{
  console.log("\n3) Retract / rapid structure");
  const pp = new LinuxCNC();
  const lines = pp.engraveBezier(p0, p1, p2, p3, OP, 0, 0, 0);
  const safeRetract = `G0 Z${n(OP.safeZ)}`;

  check("first line is safeZ retract",   lines[0] === safeRetract, lines[0]);
  check("last line is safeZ retract",    lines[lines.length - 1] === safeRetract, lines[lines.length - 1]);

  const rapidToStart = `G0 X${n(p0.x)} Y${n(p0.y)}`;
  check("rapids to p0 before each plunge", lines.includes(rapidToStart), rapidToStart);
}

// 4) WCS origin offset --------------------------------------------------------
{
  console.log("\n4) WCS origin offset  (ox=50, oy=25)");
  const pp = new LinuxCNC();
  const OX = 50, OY = 25;
  const lines = pp.engraveBezier(p0, p1, p2, p3, OP, OX, OY, 0);
  const g5 = lines.find(l => l.startsWith("G5 "))!;

  // Endpoint coordinates are shifted; relative offsets I/J/P/Q are not.
  check(`X endpoint = p3.x − ox = ${n(p3.x - OX)}`, g5.includes(`X${n(p3.x - OX)}`), g5);
  check(`Y endpoint = p3.y − oy = ${n(p3.y - OY)}`, g5.includes(`Y${n(p3.y - OY)}`), g5);
  check(`I unaffected by origin (still ${n(p1.x - p0.x)})`, g5.includes(`I${n(p1.x - p0.x)}`), g5);
  check(`rapid to p0 uses offset X: ${n(p0.x - OX)}`, lines.includes(`G0 X${n(p0.x - OX)} Y${n(p0.y - OY)}`));
}

// 5) Z offset (bed origin) ----------------------------------------------------
{
  console.log("\n5) Z offset  (zOff = stock thickness = 10)");
  const pp = new LinuxCNC();
  const lines = pp.engraveBezier(p0, p1, p2, p3, OP, 0, 0, 10);

  // safeZ = 5, zOff = 10 → G0 Z15
  check("safeZ retract includes zOff", lines[0] === `G0 Z${n(OP.safeZ + 10)}`, lines[0]);
  // first cut depth = -1.5 + 10 = 8.5
  const plunge = lines.find(l => l.startsWith("G1 Z"));
  check("plunge depth includes zOff", plunge?.includes(`Z${n(-1.5 + 10)}`), plunge ?? "");
}

// 6) Single depth pass when stepdown >= |depth| --------------------------------
{
  console.log("\n6) Single depth pass");
  const op = { ...OP, depth: -1, stepdown: 2 };
  const pp = new LinuxCNC();
  const lines = pp.engraveBezier(p0, p1, p2, p3, op, 0, 0, 0);
  const g5Lines = lines.filter(l => l.startsWith("G5 "));
  const plunge  = lines.find(l => l.startsWith("G1 Z"));

  check("one G5 command",             g5Lines.length === 1, `got ${g5Lines.length}`);
  check("plunges to full depth -1",   plunge?.includes("Z-1"), plunge ?? "");
}

// 7) GRBL uses G1 lines, not G5 -----------------------------------------------
{
  console.log("\n7) GRBL post-processor");
  const pp = new Grbl();
  const lines = pp.engraveBezier(p0, p1, p2, p3, OP, 0, 0, 0);
  const hasG5     = lines.some(l => l.startsWith("G5 "));
  const hasG1cut  = lines.some(l => l.startsWith("G1 X"));
  const plunges   = lines.filter(l => l.startsWith("G1 Z"));

  check("GRBL emits no G5 commands",   !hasG5);
  check("GRBL emits G1 cutting moves", hasG1cut);
  check("GRBL produces 2 depth passes", plunges.length === 2, `got ${plunges.length}`);
}

// 8) getPostProcessor registry ------------------------------------------------
{
  console.log("\n8) getPostProcessor registry");
  check("'linuxcnc' returns LinuxCNC",  getPostProcessor("linuxcnc") instanceof LinuxCNC);
  check("'grbl' returns Grbl",          getPostProcessor("grbl")     instanceof Grbl);
  check("unknown name defaults to LinuxCNC", getPostProcessor("unknown") instanceof LinuxCNC);
}

// 9) Arcs must not silently vanish (regression: arc showed in 3D preview but
//    produced ZERO G-code with no warning). Engrave → real G3; profile → NOTE.
{
  console.log("\n9) Arc G-code generation");
  // A quarter arc centred at (50,50), r=20, from 0 to 90° (CCW).
  const run = (type: CAMOperation["type"]): string => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const arc = doc.add(new ArcEntity({ x: 50, y: 50 }, 20, 0, Math.PI / 2)) as ArcEntity;
    const op: CAMOperation = { ...OP, id: "arcop", type, toolType: "end-mill", stepover: 0.4, entityIds: [arc.id] };
    return generateGCode([op], doc);
  };

  const engraveOut = run("engrave");
  check("engraved arc emits a G3 move", engraveOut.split("\n").some(l => l.startsWith("G3 ")),
    engraveOut.split("\n").find(l => l.startsWith("G3 ")) ?? "(no G3)");

  const profileOut = run("profile");
  check("profiled arc emits an explanatory NOTE (not silent)", /NOTE: arc/.test(profileOut),
    profileOut.split("\n").find(l => l.includes("NOTE")) ?? "(no NOTE)");
}

// 10) Pocket: ramped entry + per-depth-level interleaving (rough then finish at
//     each level, descending) instead of straight plunges and all-rough-then-finish.
{
  console.log("\n10) Pocket ramp + pass ordering");
  const doc = new CADDocument({ width: 200, height: 200 });
  const rect = doc.add(new RectEntity({ x: 10, y: 10 }, { x: 70, y: 50 })) as RectEntity;
  // depth -3, stepdown 1.5 → two passes at Z-1.5 then Z-3.
  const op: CAMOperation = {
    ...OP, id: "pk", type: "pocket", toolType: "end-mill", stepover: 0.4,
    diameter: 3, depth: -3, stepdown: 1.5, entityIds: [rect.id], pocketStrategy: "raster",
  };
  const out = generateGCode([op], doc);
  const all = out.split("\n");

  // Ramped entry: a single G1 move that changes X/Y AND Z together (impossible
  // with the old straight-plunge code, which only ever moved Z alone).
  const hasRamp = all.some(l => /^G1 X-?[\d.]+ Y-?[\d.]+ Z-?[\d.]+/.test(l));
  check("pocket uses a ramped entry (combined XYZ feed move)", hasRamp,
    all.find(l => /^G1 X-?[\d.]+ Y-?[\d.]+ Z-?[\d.]+/.test(l)) ?? "(no ramp move)");

  // Reaches full depth.
  check("pocket reaches full depth Z-3", all.some(l => /Z-3(\b|\.0)/.test(l) || l.includes("Z-3")),
    "");

  // Pass ordering: finishing the shallow wall (Z-1.5) happens BEFORE clearing
  // the deep level (Z-3). The old code did all clearing first.
  const finishShallow = all.findIndex(l => l === "; finishing walls Z-1.5");
  const clearDeep     = all.findIndex(l => l === "; clearing pass Z-3");
  check("finish@Z-1.5 precedes clearing@Z-3 (interleaved by depth)",
    finishShallow >= 0 && clearDeep >= 0 && finishShallow < clearDeep,
    `finish@-1.5=${finishShallow}, clear@-3=${clearDeep}`);

  // No straight vertical plunge straight to full depth in one shot at the entry
  // (i.e., a `G1 Z-3` that isn't part of a ramp). Roughing entry should ramp.
  const straightToFull = all.some(l => /^G1 Z-3(\b|\.0| )/.test(l));
  check("no straight vertical plunge to full depth", !straightToFull,
    all.find(l => /^G1 Z-3/.test(l)) ?? "");
}

// 11) Pocket: contour-parallel (default) strategy on a pocket WITH an island —
//     concentric loops should wrap the island with far fewer lifts than raster.
{
  console.log("\n11) Pocket contour-parallel + island");
  const mkDoc = () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const rect = doc.add(new RectEntity({ x: 10, y: 10 }, { x: 90, y: 70 })) as RectEntity;
    const isl = doc.add(new CircleEntity({ x: 50, y: 40 }, 10)) as CircleEntity;
    return { doc, ids: [rect.id], islIds: [isl.id] };
  };
  const op = (strategy: "offset" | "raster", d: { ids: string[]; islIds: string[] }): CAMOperation => ({
    ...OP, id: "pk", type: "pocket", toolType: "end-mill", stepover: 0.4,
    diameter: 6, depth: -2, stepdown: 2, entityIds: d.ids, islandIds: d.islIds, pocketStrategy: strategy,
  });

  const a = mkDoc(); const offset = generateGCode([op("offset", a)], a.doc).split("\n");
  const b = mkDoc(); const raster = generateGCode([op("raster", b)], b.doc).split("\n");

  const lifts = (ls: string[]) => ls.filter(l => /^G0 Z5\b/.test(l)).length;

  check("contour-parallel header present", offset.some(l => l.includes("contour-parallel")),
    offset.find(l => l.includes("clearing pass")) ?? "");
  check("contour-parallel uses fewer lifts than raster on an island pocket",
    lifts(offset) < lifts(raster), `offset lifts=${lifts(offset)}, raster lifts=${lifts(raster)}`);
  check("contour-parallel reaches full depth Z-2", offset.some(l => l.includes("Z-2")), "");
  check("helical entry present (descending XYZ move)",
    offset.some(l => /^G1 X-?[\d.]+ Y-?[\d.]+ Z-?[\d.]+/.test(l)), "");
}

// 12) Finishing pass: profile gets one extra full-depth spring lap ------------
{
  console.log("\n12) Profile finishing pass");
  const doc = new CADDocument({ width: 200, height: 200 });
  const rect = doc.add(new RectEntity({ x: 10, y: 10 }, { x: 70, y: 50 })) as RectEntity;
  const base: CAMOperation = {
    ...OP, id: "pr", type: "profile", side: "outside", toolType: "end-mill",
    stepover: 0.4, diameter: 6, depth: -3, stepdown: 1.5, entityIds: [rect.id],
  };
  const fullDepthPlunges = (op: CAMOperation) =>
    generateGCode([op], doc).split("\n").filter(l => /^G1 Z-3\b/.test(l)).length;

  const without = fullDepthPlunges(base);
  const withFin = fullDepthPlunges({ ...base, finishPass: true });
  check("finishing pass adds exactly one extra full-depth lap",
    withFin === without + 1, `without=${without}, with=${withFin}`);
}

// 13) Finishing pass: pocket gets a full-depth wall lap -----------------------
{
  console.log("\n13) Pocket finishing pass");
  const doc = new CADDocument({ width: 200, height: 200 });
  const rect = doc.add(new RectEntity({ x: 10, y: 10 }, { x: 90, y: 70 })) as RectEntity;
  const op: CAMOperation = {
    ...OP, id: "pk", type: "pocket", toolType: "end-mill", stepover: 0.4,
    diameter: 6, depth: -2, stepdown: 2, entityIds: [rect.id],
    pocketStrategy: "offset", finishPass: true,
  };
  const out = generateGCode([op], doc);
  check("pocket finishing pass emits a full-depth wall lap",
    /finishing pass \(full-depth wall\)/.test(out), "");
}

// 14) Circular pocket: helical G2 entry + smooth G2 walls --------------------
{
  console.log("\n14) Circular pocket helical boring");
  const doc = new CADDocument({ width: 200, height: 200 });
  const circ = doc.add(new CircleEntity({ x: 100, y: 100 }, 20)) as CircleEntity;
  const op: CAMOperation = {
    ...OP, id: "cp", type: "pocket", toolType: "end-mill", stepover: 0.4,
    diameter: 6, depth: -3, stepdown: 1.5, entityIds: [circ.id],
  };
  const all = generateGCode([op], doc).split("\n");
  // Real helical interpolation = a G2 arc carrying a Z descent.
  check("circular pocket descends with a helical G2 (arc + Z)",
    all.some(l => /^G2 .*\bZ-/.test(l)),
    all.find(l => /^G2 /.test(l)) ?? "(no G2)");
  // Walls are smooth arcs, not a faceted polyline.
  check("circular pocket clears with G2 arcs", all.some(l => /^G2 /.test(l)), "");
  check("circular pocket reaches full depth Z-3", all.some(l => l.includes("Z-3")), "");
  // No straight vertical plunge to full depth at the start.
  check("no straight plunge to full depth", !all.some(l => /^G1 Z-3\b/.test(l)),
    all.find(l => /^G1 Z-3\b/.test(l)) ?? "");
}

// 15) Profile lead anchors mid-side only when a lead is configured -----------
{
  console.log("\n15) Lead mid-side placement");
  const doc = new CADDocument({ width: 200, height: 200 });
  const rect = doc.add(new RectEntity({ x: 10, y: 10 }, { x: 70, y: 50 })) as RectEntity;
  // Offset (outside, ⌀6 → +3) rect is 7..73 × 7..53; longest edges are the 66mm
  // horizontals, whose midpoint is X40 (Y7 or Y53).
  const base: CAMOperation = {
    ...OP, id: "pr", type: "profile", side: "outside", toolType: "end-mill",
    stepover: 0.4, diameter: 6, depth: -3, stepdown: 3, entityIds: [rect.id],
  };
  const noLead = generateGCode([base], doc);
  const withLead = generateGCode([{ ...base, leadIn: { type: "linear", length: 2 } }], doc);

  check("mid-side start (X40) used when a lead is configured",
    /X40 Y(7|53)\b/.test(withLead), withLead.split("\n").find(l => /X40/.test(l)) ?? "(no X40)");
  check("no mid-side start for a plain no-lead profile",
    !/X40 Y(7|53)\b/.test(noLead), noLead.split("\n").find(l => /X40/.test(l)) ?? "");
}

// 16) Finish allowance: roughing and finishing cut at different radii --------
{
  console.log("\n16) Finish allowance");
  const doc = new CADDocument({ width: 200, height: 200 });
  const circ = doc.add(new CircleEntity({ x: 100, y: 100 }, 10)) as CircleEntity;
  // Outside profile, ⌀6 → cutR = 13; allowance 0.5 → rough at 13.5, finish at 13.
  const op: CAMOperation = {
    ...OP, id: "pc", type: "profile", side: "outside", toolType: "end-mill",
    stepover: 0.4, diameter: 6, depth: -3, stepdown: 3, entityIds: [circ.id],
    finishPass: true, finishAllowance: 0.5,
  };
  const out = generateGCode([op], doc);
  check("roughing pass cuts at the allowance-offset radius (I-13.5)", /I-13\.5 J0/.test(out), "");
  check("finishing pass cuts at the true radius (I-13)", /I-13 J0/.test(out), "");
}

// 17) Chamfer: V-bit edge bevel, depth derived from width --------------------
{
  console.log("\n17) Chamfer (V-bevel)");
  const doc = new CADDocument({ width: 300, height: 300 });
  const rect = doc.add(new RectEntity({ x: 50, y: 50 }, { x: 150, y: 120 })) as RectEntity;
  const cham: CAMOperation = {
    ...OP, id: "ch", type: "chamfer", toolType: "v-bit", vAngle: 60,
    stepover: 0.4, entityIds: [rect.id], depth: -3, stepdown: 10,
    chamferWidth: 3, chamferSide: "on",
  };
  const out = generateGCode([cham], doc);
  // depth = 3 / tan(30°) ≈ 5.196
  check("chamfer derives depth from width (Z-5.196)", /Z-5\.196\b/.test(out),
    out.split("\n").find(l => /^G1 Z-/.test(l)) ?? "");
  check("chamfer traces the edge", out.split("\n").some(l => /^G1 X/.test(l)), "");

  const endmill = generateGCode([{ ...cham, toolType: "end-mill" }], doc);
  check("chamfer with a non-V-bit emits a NOTE", /chamfer requires a V-bit/.test(endmill), "");

  const outside = generateGCode([{ ...cham, chamferSide: "outside" }], doc);
  check("outside chamfer offsets the edge outward (X153)", /X153\b/.test(outside),
    outside.split("\n").find(l => /X15\d/.test(l)) ?? "(no X153)");

  // Sharpen inside corners: the bevel tapers up to the surface (Z0) at each of
  // the 4 rectangle corners (tip pulled up into the corner).
  const sharp = generateGCode([{ ...cham, sharpenCorners: true }], doc).split("\n");
  const liftMoves = sharp.filter(l => /^G1 X-?[\d.]+ Y-?[\d.]+ Z0\b/.test(l));
  check("sharpen-corners tapers to the surface at each inside corner (4)",
    liftMoves.length === 4, `got ${liftMoves.length}`);
  // The lift must land ON each corner vertex (not an offset miter point) — this
  // is what distinguishes the inside-corner taper from the earlier wrong version.
  const corners = ["X50 Y50", "X150 Y50", "X150 Y120", "X50 Y120"];
  check("each surface lift is at a corner vertex",
    corners.every(c => liftMoves.some(l => l.startsWith(`G1 ${c} Z0`))),
    liftMoves.join(" | "));
  check("plain chamfer has no mid-contour surface lifts",
    !out.split("\n").some(l => /^G1 X-?[\d.]+ Y-?[\d.]+ Z0\b/.test(l)), "");

  // Derived depth exceeding stock thickness is flagged. doc stock = 10mm;
  // a 30° V-bit at width 8 → depth 8/tan(15°) ≈ 29.9mm > 10.
  const deep = generateGCode([{ ...cham, vAngle: 30, chamferWidth: 8 }], doc);
  check("over-stock chamfer depth emits a NOTE",
    /NOTE: chamfer depth .* exceeds stock thickness/.test(deep), "");
  // A sane chamfer (depth < stock) does not.
  check("normal chamfer depth emits no over-stock NOTE",
    !/exceeds stock thickness/.test(out), "");
}

