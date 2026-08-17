/**
 * The finish pass's stock model: a finish op knows what the relief-rough ops
 * ahead of it already cut, so it steps into leftover stock instead of re-cutting
 * air — and takes the leftover in `stepdown` bites instead of one full-depth
 * plunge where the rough tool never reached.
 *
 * The positive control is the file-wide "blank when empty" rule: with no prior
 * rough op the floor is the uncut blank, and the emitter reduces to its old
 * behaviour (guarded by the existing relief G-code/preview tests).
 */
import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { RasterImageEntity } from "../src/model/entities";
import { generateGCode } from "../src/cam/gcode";
import { registerEmbeddedImage, getImageGrid } from "../src/core/imageManager";
import { rasterField } from "../src/cam/rasterEngrave";
import { reliefEncodingFor } from "../src/cam/reliefEncoding";
import { reliefStockFloor } from "../src/cam/rest";
import type { CAMOperation } from "../src/cam/types";

let counter = 0;
function registerGrid(rowsTopDown: number[][]): string {
  const w = rowsTopDown[0].length,
    h = rowsTopDown.length;
  const id = `img-stock-${counter++}`;
  registerEmbeddedImage({
    id,
    name: id,
    width: w,
    height: h,
    data: btoa(String.fromCharCode(...rowsTopDown.flat())),
  });
  return id;
}

/** Count G1 lines without materialising a match array (see reliefGcode.test.ts). */
function countG1(g: string): number {
  let n = g.startsWith("G1 ") ? 1 : 0;
  for (let i = g.indexOf("\nG1 "); i !== -1; i = g.indexOf("\nG1 ", i + 1)) n++;
  return n;
}

function roughOp(entityIds: string[], over: Partial<CAMOperation> = {}): CAMOperation {
  return {
    id: "rr1",
    name: "rough",
    type: "relief-rough",
    entityIds,
    side: "outside",
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 4,
    feedrate: 1500,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -4,
    stepdown: 1,
    stepover: 0.5, // pitch = stepover x diameter = 2mm
    finishAllowance: 0.5,
    ...over,
  };
}

function reliefOp(entityIds: string[], over: Partial<CAMOperation> = {}): CAMOperation {
  return {
    id: "r1",
    name: "relief",
    type: "engrave",
    entityIds,
    side: "outside",
    toolType: "ball-nose",
    toolNumber: 2,
    diameter: 2,
    feedrate: 1500,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -4,
    stepdown: 1,
    stepover: 0.4,
    rasterLineInterval: 1,
    rasterDotPitch: 1,
    ...over,
  };
}

/** A doc holding the image at a known mm size, plus the image entity itself. */
function imageDoc(id: string, widthMM: number, heightMM: number) {
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, widthMM, heightMM, 0));
  const ent = doc.entities.find((e) => e.type === "image") as RasterImageEntity;
  return { doc, ent };
}

test("reliefStockFloor: no prior rough op → the uncut blank, on the finish grid", () => {
  const id = registerGrid([
    [0, 0],
    [0, 0],
  ]);
  const { ent } = imageDoc(id, 4, 4);
  const enc = reliefEncodingFor(ent, reliefOp([ent.id]));
  const grid = getImageGrid(ent.imageId)!;
  const field = rasterField(grid, enc.field(1, 1));
  const floor = reliefStockFloor(field, grid, enc, [], 4);
  expect(floor.cols).toBe(field.cols);
  expect(floor.rows.length).toBe(field.rows.length);
  for (const row of floor.rows) for (const v of row.levels) expect(v).toBe(0);
});

test("reliefStockFloor: a full-depth cell floors at the allowance, not a stepdown multiple", () => {
  const id = registerGrid([
    [0, 0],
    [0, 0],
  ]);
  const { ent } = imageDoc(id, 4, 4);
  const enc = reliefEncodingFor(ent, reliefOp([ent.id]));
  const grid = getImageGrid(ent.imageId)!;
  const field = rasterField(grid, enc.field(1, 1));
  // Uniform black → the ⌀4 rough leaves the whole field at −(4 − 0.5) = −3.5 mm,
  // the clamped final plane, not −3 mm (the nearest stepdown multiple).
  const floor = reliefStockFloor(field, grid, enc, [roughOp([ent.id])], 4);
  for (const row of floor.rows) for (const v of row.levels) expect(v).toBeCloseTo(0.875, 6);
});

test("paired relief: a rough that did its job leaves the finish a single pass", () => {
  const id = registerGrid([
    [0, 0],
    [0, 0],
  ]);
  const { doc, ent } = imageDoc(id, 4, 4);
  const g = generateGCode([roughOp([ent.id]), reliefOp([ent.id])], doc);
  // 0.5 mm allowance everywhere → the finish is one 0.5 mm bite, not a 4 mm staircase.
  expect(g).toMatch(/deepest remaining 0\.5mm/);
  expect(g).toMatch(/1 pass of 1mm/);
});

test("paired relief: a channel the rough tool could not enter is stepped, not bitten whole", () => {
  // 12 mm wide, 4 mm deep: a 4 mm channel (byte 0 = full depth) in a field of
  // surface (byte 255 = no cut). A ⌀8 flat (4 mm radius) cannot enter a 4 mm
  // channel, so the channel keeps its full depth and the ⌀2 finish steps into it.
  const id = registerGrid([
    [255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255],
    [255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255],
    [255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255],
    [255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255],
  ]);
  const { doc, ent } = imageDoc(id, 12, 8);
  const rough = roughOp([ent.id], { diameter: 8, stepover: 0.5 }); // pitch 4 mm
  const g = generateGCode([rough, reliefOp([ent.id])], doc);
  expect(g).toMatch(/deepest remaining 4mm/);
  expect(g).toMatch(/4 passes of 1mm/);
  // The staircase really is one: the channel is reached through −1/−2/−3/−4, not
  // by a single 4 mm plunge.
  const negZs = new Set(
    [...g.matchAll(/G1 .* Z(-?[\d.]+)/g)].map((m) => +m[1]).filter((z) => z < -0.5),
  );
  expect(negZs.size).toBeGreaterThanOrEqual(4);
});

test("the stock model cuts feed: the finish no longer re-traces ground the rough cleared", () => {
  // Same surface + channel field as the test above: the surface cells are air the
  // old finish re-walked on every pass, and the stock model now skips.
  const id = registerGrid([
    [255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255],
    [255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255],
    [255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255],
    [255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255],
  ]);
  const { doc, ent } = imageDoc(id, 12, 8);
  const rough = roughOp([ent.id], { diameter: 8, stepover: 0.5 });
  const fin = reliefOp([ent.id]);
  const before = generateGCode([fin], doc);
  const after = generateGCode([rough, fin], doc);
  const cut = after.indexOf("Manual tool change to T2");
  const afterFinish = cut >= 0 ? after.slice(cut) : after;
  expect(countG1(afterFinish)).toBeLessThan(countG1(before));
});
