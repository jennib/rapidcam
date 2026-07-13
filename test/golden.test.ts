/**
 * Golden output tripwire for the Stock-model refactor (Phase 1). Each generator
 * path is captured by a byte-hash of a representative program. Phase 1 routes the
 * CAM/preview/bounds code through `doc.stock` / `stockFootprint` instead of reading
 * `doc.canvas` / `doc.stockThickness` directly; because the stock fills the frame
 * at the origin, the output MUST stay byte-identical. If a hash changes here, a
 * refactor step altered behavior — stop and diff before touching the hash.
 */
import { test, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CADDocument } from "../src/model/document";
import { CircleEntity, RectEntity } from "../src/model/entities";
import { generateGCode } from "../src/cam/gcode";
import { generateRotaryProgram } from "../src/cam/klein";
import { applyFile } from "../src/io/fileio";
import type { RcamFile } from "../src/io/fileio";
import type { CAMOperation } from "../src/cam/types";

const here = dirname(fileURLToPath(import.meta.url));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function profileOp(
  id: string,
  entityIds: string[],
  opts: Partial<CAMOperation> = {},
): CAMOperation {
  return {
    id,
    name: id,
    type: "profile",
    side: "outside",
    entityIds,
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 6,
    feedrate: 1000,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -3,
    stepdown: 1.5,
    stepover: 0.4,
    ...opts,
  };
}

// Flat mill — the reference Enclosure Lid (pocket regions + tabbed/leaded profile).
function enclosureGcode(): string {
  const file = JSON.parse(
    readFileSync(join(here, "fixtures", "enclosure-lid.rcam"), "utf8"),
  ) as RcamFile;
  const doc = new CADDocument({ width: 10, height: 10 });
  applyFile(doc, file);
  return generateGCode(doc.operations, doc);
}

// Rotary wrap — the wrapped / inverse-time (G93) path.
function rotaryGcode(): string {
  const doc = new CADDocument({ width: 200, height: Math.PI * 100 });
  doc.machineKind = "mill-rotary";
  doc.rotary = { axisWord: "A", diameter: 100, wrapAxis: "y" };
  const c = doc.add(new CircleEntity({ x: 100, y: 80 }, 25));
  doc.operations = [profileOp("op1", [c.id], { depth: -4, stepdown: 2 })];
  return generateRotaryProgram(doc).program;
}

// Non-default origin (center / center / bed) — exercises resolveOrigin's non-zero
// ox/oy branches and the stock thickness in zOffset, which the front-left-top
// goldens leave at 0. This is the doc that actually covers the resolveOrigin repoint.
function centerBedGcode(): string {
  const doc = new CADDocument({ width: 120, height: 90 });
  doc.stockThickness = 8;
  doc.origin = { x: "center", y: "center", z: "bed" };
  const c = doc.add(new CircleEntity({ x: 60, y: 45 }, 20));
  doc.operations = [profileOp("op1", [c.id], { side: "inside", depth: -8, stepdown: 4 })];
  return generateGCode(doc.operations, doc);
}

// Laser — the fixed-Z beam generator path.
function laserGcode(): string {
  const doc = new CADDocument({ width: 100, height: 80 });
  doc.machineKind = "laser";
  const r = doc.add(new RectEntity({ x: 10, y: 10 }, { x: 90, y: 70 }));
  doc.operations = [profileOp("op1", [r.id], { laserPower: 80, laserPasses: 2 })];
  return generateGCode(doc.operations, doc);
}

// Baseline captured 2026-07-08 before repointing any consumer at doc.stock.
// `rotary` re-baselined 2026-07-10: the rotary banner gained a gSender-parseable
// "Cylinder Dia:" token + a surface-zero note (klein.ts rotaryBanner). Banner-only
// change — the wrapped motion is unchanged; see the klein.test.ts token test.
// ALL re-baselined 2026-07-12 for two deliberate output changes:
//   1. comments are transliterated to ASCII (⌀→"dia ", ×→x, °→deg, …) via
//      toAsciiGcode — motion words were already ASCII, so rotary/laser/centerBed
//      differ in comments only;
//   2. tabbed passes re-issue the cutting feed after each tab lift/descend
//      (previously the lap silently continued at plungeRate) — this adds F words
//      to `enclosure`'s motion; the behavior is pinned by test/tab-feed.test.ts.
const GOLDEN = {
  enclosure: "9bf1734f6f723146914d9fdcc1b67795c652b4e510522f02f1714488e5fbe1fb",
  rotary: "381bf3d14ac438600f9d28cd47bbc99fdf714d507c4fe2171f272c0310c76344",
  laser: "f3e5f9507f27537af3aed24b87a86529e246937d36e48327912626e00a29c51a",
  centerBed: "fed6641e9377ccfe0b60fc74211753cda30ebbaae5f2b0e0531f89918d906326",
};

test("golden: flat-mill (Enclosure Lid) G-code is byte-stable", () => {
  expect(sha(enclosureGcode())).toBe(GOLDEN.enclosure);
});
test("golden: rotary wrap G-code is byte-stable", () => {
  expect(sha(rotaryGcode())).toBe(GOLDEN.rotary);
});
test("golden: laser G-code is byte-stable", () => {
  expect(sha(laserGcode())).toBe(GOLDEN.laser);
});
test("golden: center/bed-origin G-code is byte-stable", () => {
  expect(sha(centerBedGcode())).toBe(GOLDEN.centerBed);
});
