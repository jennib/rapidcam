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

function profileOp(id: string, entityIds: string[], opts: Partial<CAMOperation> = {}): CAMOperation {
  return {
    id, name: id, type: "profile", side: "outside", entityIds,
    toolType: "end-mill", toolNumber: 1, diameter: 6,
    feedrate: 1000, plungeRate: 300, spindleSpeed: 18000,
    safeZ: 5, depth: -3, stepdown: 1.5, stepover: 0.4, ...opts,
  };
}

// Flat mill — the reference Enclosure Lid (pocket regions + tabbed/leaded profile).
function enclosureGcode(): string {
  const file = JSON.parse(readFileSync(join(here, "fixtures", "enclosure-lid.rcam"), "utf8")) as RcamFile;
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

// Laser — the fixed-Z beam generator path.
function laserGcode(): string {
  const doc = new CADDocument({ width: 100, height: 80 });
  doc.machineKind = "laser";
  const r = doc.add(new RectEntity({ x: 10, y: 10 }, { x: 90, y: 70 }));
  doc.operations = [profileOp("op1", [r.id], { laserPower: 80, laserPasses: 2 })];
  return generateGCode(doc.operations, doc);
}

// Baseline captured 2026-07-08 before repointing any consumer at doc.stock.
const GOLDEN = {
  enclosure: "85f1724a4b9f293747ecc9baad964c66f11db46caff21c11ddf101997e06b938",
  rotary: "bf90f91c331927a4bcf232e2dc3b864ae358a2c0895ff8e6cf6e290bb5fbd213",
  laser: "3fa20c36c4f7380c21ea923b6c73ef959e8b47e49b0c1499a540456d25e6ff5e",
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
