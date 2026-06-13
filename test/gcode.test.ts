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
import { ArcEntity, RectEntity } from "../src/model/entities";

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
    diameter: 3, depth: -3, stepdown: 1.5, entityIds: [rect.id],
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

