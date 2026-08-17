/**
 * Rest machining a relief: cut only what the previous, bigger tool left.
 *
 * The load-bearing claim is that leftover is a difference of morphological
 * OPENINGS and not of tool-contact (tip) fields. Every negative assertion below
 * about the wall band is paired with a positive control on the slot in the SAME
 * field, because "the mask is empty here" also passes when the mask is empty
 * everywhere — which is the shape of failure this file exists to catch.
 */
import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { RasterImageEntity } from "../src/model/entities";
import { generateGCode } from "../src/cam/gcode";
import { registerEmbeddedImage } from "../src/core/imageManager";
import { rasterField } from "../src/cam/rasterEngrave";
import { toolSweptFloor, toolTipField } from "../src/cam/toolProfile";
import { reliefRest } from "../src/cam/rest";
import type { CAMOperation } from "../src/cam/types";

let counter = 0;
function registerGrid(rowsTopDown: number[][]): string {
  const w = rowsTopDown[0].length,
    h = rowsTopDown.length;
  const id = `img-rest-${counter++}`;
  registerEmbeddedImage({
    id,
    name: id,
    width: w,
    height: h,
    data: btoa(String.fromCharCode(...rowsTopDown.flat())),
  });
  return id;
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
    diameter: 2,
    feedrate: 1500,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -10,
    stepdown: 2,
    stepover: 0.5, // pitch = stepover x diameter
    finishAllowance: 0,
    ...over,
  };
}

/**
 * A 60mm x ~12mm plate 10mm deep carrying BOTH cases at once, which is the point:
 * a 5mm slot a ⌀3 enters and a ⌀6 cannot, and a wide step down that a ⌀6 clears
 * to the wall with its flank even though its tip never gets near it.
 *
 * Byte 255 = model top = no cut; byte 0 = full depth.
 */
function slotAndStepField(cellMM: number) {
  const W = 240,
    H = 48,
    MM = 60;
  const data = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const mx = (x / W) * MM;
      const z = mx > 12 && mx < 17 ? 0 : mx > 26 ? 3 : 10; // height above base, mm
      data[y * W + x] = z / 10;
    }
  return rasterField(
    { width: W, height: H, data },
    {
      widthMM: MM,
      heightMM: (MM * H) / W,
      lineIntervalMM: cellMM,
      dotPitchMM: cellMM,
      gamma: 1,
      tone: "encoded",
      whiteThreshold: 1.01,
    },
  );
}

/** Column index of a millimetre position in a field of the given cell size. */
const colAt = (mm: number, cellMM: number) => Math.floor(mm / cellMM);

// ---------------------------------------------------------------------------
// The morphology itself
// ---------------------------------------------------------------------------

test("a tool's swept floor is its opening: idempotent, and never below its tip field", () => {
  const cell = 1.2;
  const field = slotAndStepField(cell);
  const tool = { toolType: "end-mill" as const, diameter: 6 };
  const tip = toolTipField(field, tool, 10);
  const floor = toolSweptFloor(field, tool, 10);
  // Opening it again changes nothing — the defining property of an opening, and
  // the cheapest way to catch a sweep that is not actually idempotent.
  const twice = toolSweptFloor(floor, tool, 10);

  let deeperThanTip = 0;
  let movedOnSecondPass = 0;
  for (let r = 0; r < field.rows.length; r++)
    for (let c = 0; c < field.cols; c++) {
      const t = tip.rows[r].levels[c];
      const f = floor.rows[r].levels[c];
      if (f < t - 1e-6) throw new Error(`swept floor above the tip field at ${r},${c}`);
      if (f > t + 1e-6) deeperThanTip++;
      if (Math.abs(twice.rows[r].levels[c] - f) > 1e-6) movedOnSecondPass++;
    }
  expect(movedOnSecondPass).toBe(0);
  // Positive control: the two fields DO differ, so the check above is not passing
  // because a degenerate sweep returned the input.
  expect(deeperThanTip).toBeGreaterThan(0);
});

test("a smaller tool's floor is never above a bigger tool's, and is somewhere below it", () => {
  const cell = 1.2;
  const field = slotAndStepField(cell);
  const big = toolSweptFloor(field, { toolType: "end-mill", diameter: 6 }, 10);
  const small = toolSweptFloor(field, { toolType: "end-mill", diameter: 3 }, 10);
  let strictly = 0;
  for (let r = 0; r < field.rows.length; r++)
    for (let c = 0; c < field.cols; c++) {
      const b = big.rows[r].levels[c];
      const s = small.rows[r].levels[c];
      if (s < b - 1e-6) throw new Error(`⌀3 left MORE than ⌀6 at ${r},${c}: ${s} < ${b}`);
      if (s > b + 1e-6) strictly++;
    }
  expect(strictly).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// The mask
// ---------------------------------------------------------------------------

test("the mask covers the slot the big tool cannot enter", () => {
  const cell = 1.2;
  const field = slotAndStepField(cell);
  const rest = reliefRest(field, roughOp([], { diameter: 3, restToolDiameter: 6 }), 10, 2);
  expect(rest.kind).toBe("mask");
  if (rest.kind !== "mask") return;

  const mid = field.rows.length >> 1;
  // Inside the 5mm slot (12..17mm).
  expect(rest.keep(mid, colAt(14.5, cell))).toBe(true);
  // Deepest leftover is the slot's full depth less the allowance it was given.
  expect(rest.maxLeftoverMM).toBeGreaterThan(9.5);
  expect(rest.maxLeftoverMM).toBeLessThanOrEqual(10);
});

test("the mask does NOT claim the band along a wall the big tool's flank swept", () => {
  const cell = 1.2;
  const field = slotAndStepField(cell);
  const op = roughOp([], { diameter: 3, restToolDiameter: 6 });
  const rest = reliefRest(field, op, 10, 2);
  expect(rest.kind).toBe("mask");
  if (rest.kind !== "mask") return;
  const mid = field.rows.length >> 1;

  // The step's wall is at 26mm; a ⌀6 tip cannot come within 3mm of it, so a
  // tip-field difference reports standing stock across 26..29mm. The flank swept
  // it, so the shipped mask must not.
  const tipBig = toolTipField(field, { toolType: "end-mill", diameter: 6 }, 10);
  const tipSmall = toolTipField(field, { toolType: "end-mill", diameter: 3 }, 10);
  let naiveWallCells = 0;
  for (let mm = 26.5; mm < 29; mm += cell) {
    const c = colAt(mm, cell);
    expect(rest.keep(mid, c)).toBe(false);
    if ((tipSmall.rows[mid].levels[c] - tipBig.rows[mid].levels[c]) * 10 > 2) naiveWallCells++;
  }
  // The positive control for the assertion above: the rejected metric really
  // does fire here, so `keep === false` is a decision and not an empty mask.
  expect(naiveWallCells).toBeGreaterThan(0);
  // And the same mask is non-empty elsewhere in this very field.
  expect(rest.keep(mid, colAt(14.5, cell))).toBe(true);
});

test("the mask is grown by exactly one cell past the stock it found", () => {
  const cell = 1.2;
  const field = slotAndStepField(cell);
  const rest = reliefRest(field, roughOp([], { diameter: 3, restToolDiameter: 6 }), 10, 2);
  expect(rest.kind).toBe("mask");
  if (rest.kind !== "mask") return;
  const mid = field.rows.length >> 1;

  // The undilated answer, recomputed from the same exported pieces.
  const big = toolSweptFloor(field, { toolType: "end-mill", diameter: 6 }, 10);
  const small = toolSweptFloor(field, { toolType: "end-mill", diameter: 3 }, 10);
  const span = (hit: (c: number) => boolean) => {
    let lo = -1,
      hi = -1;
    for (let c = 0; c < field.cols; c++)
      if (hit(c)) {
        if (lo < 0) lo = c;
        hi = c;
      }
    return { lo, hi };
  };
  const raw = span((c) => (small.rows[mid].levels[c] - big.rows[mid].levels[c]) * 10 > 2);
  const grown = span((c) => rest.keep(mid, c));
  expect(raw.lo).toBeGreaterThan(0); // positive control: there IS a raw region
  expect(grown.lo).toBe(raw.lo - 1);
  expect(grown.hi).toBe(raw.hi + 1);
});

test("a flat field has nothing to rest machine, whatever the tools", () => {
  const flat = rasterField(
    { width: 64, height: 64, data: new Float32Array(64 * 64).fill(0.5) },
    { widthMM: 40, heightMM: 40, lineIntervalMM: 1.2, dotPitchMM: 1.2, gamma: 1, tone: "encoded" },
  );
  for (const toolType of ["end-mill", "ball-nose", "v-bit"] as const)
    expect(reliefRest(flat, roughOp([], { diameter: 3, toolType, restToolDiameter: 6 }), 10, 2).kind).toBe(
      "clear",
    );
});

test("reliefRest refuses a previous tool that is not larger, and is off at 0", () => {
  const field = slotAndStepField(1.2);
  expect(reliefRest(field, roughOp([], { diameter: 3 }), 10, 2).kind).toBe("off");
  expect(reliefRest(field, roughOp([], { diameter: 6, restToolDiameter: 6 }), 10, 2).kind).toBe(
    "not-larger",
  );
  expect(reliefRest(field, roughOp([], { diameter: 6, restToolDiameter: 3 }), 10, 2).kind).toBe(
    "not-larger",
  );
});

test("a bigger threshold masks strictly fewer cells", () => {
  // Three slots of DIFFERENT depths, all too narrow for the ⌀6. A fixture with
  // one leftover depth cannot tell a threshold that works from one that is
  // ignored — the first draft of this test used the slot-and-step field and
  // passed identically at every threshold below the slot's own depth.
  const W = 240,
    H = 24,
    MM = 60;
  const data = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const mx = (x / W) * MM;
      let z = 10;
      if (mx > 8 && mx < 13) z = 8; // 2mm deep
      else if (mx > 24 && mx < 29) z = 5; // 5mm deep
      else if (mx > 40 && mx < 45) z = 1; // 9mm deep
      data[y * W + x] = z / 10;
    }
  const field = rasterField(
    { width: W, height: H, data },
    {
      widthMM: MM,
      heightMM: (MM * H) / W,
      lineIntervalMM: 1.2,
      dotPitchMM: 1.2,
      gamma: 1,
      tone: "encoded",
      whiteThreshold: 1.01,
    },
  );
  const op = roughOp([], { diameter: 3, restToolDiameter: 6 });
  const cellsAt = (stepdown: number) => {
    const r = reliefRest(field, op, 10, stepdown);
    return r.kind === "mask" ? r.cells : 0;
  };
  const all = cellsAt(1); // all three slots qualify
  const two = cellsAt(3); // the 2mm one drops out
  const one = cellsAt(6); // only the 9mm one is left
  const none = cellsAt(50); // deeper than the model — nothing can qualify
  expect(all).toBeGreaterThan(two);
  expect(two).toBeGreaterThan(one);
  expect(one).toBeGreaterThan(0);
  expect(none).toBe(0);
});

// ---------------------------------------------------------------------------
// The G-code, and the preview that has to agree with it
// ---------------------------------------------------------------------------

/**
 * A 24mm square carrying both answers, at 1mm per pixel:
 * a 12mm-wide pocket a ⌀8 clears outright, and a 3mm slot it cannot enter.
 *
 * Both must be present. With only the slot, the rest mask covers everything the
 * full pass cut and the two programs come out the same length — which is how the
 * first draft of this test passed a mask that did nothing.
 */
function slotAndPocketDoc(): { doc: CADDocument; id: string } {
  const rows = Array.from({ length: 24 }, (_, y) =>
    Array.from({ length: 24 }, (_, x) => {
      const inPocket = x >= 2 && x <= 13 && y >= 2 && y <= 13;
      const inSlot = x >= 18 && x <= 20;
      return inPocket || inSlot ? 0 : 255;
    }),
  );
  const id = registerGrid(rows);
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, 24, 24, 0));
  return { doc, id: doc.entities.find((e) => e.type === "image")!.id };
}

test("a rest pass posts a header, and strictly fewer cuts than roughing the lot", () => {
  const { doc, id } = slotAndPocketDoc();
  const full = generateGCode([roughOp([id], { diameter: 2 })], doc);
  const rest = generateGCode([roughOp([id], { diameter: 2, restToolDiameter: 8 })], doc);

  expect(rest).toMatch(/; rest machining after dia 8mm \(assumed flat\)/);
  const cuts = (g: string) => (g.match(/^G1 X/gm) ?? []).length;
  expect(cuts(rest)).toBeGreaterThan(0); // positive control: it still cuts
  expect(cuts(rest)).toBeLessThan(cuts(full));
});

test("the rest refusals reach the program as notes, not as silence", () => {
  const { doc, id } = slotAndPocketDoc();
  const notLarger = generateGCode([roughOp([id], { diameter: 6, restToolDiameter: 3 })], doc);
  expect(notLarger).toMatch(/needs a previous tool LARGER/);
  expect(notLarger).not.toMatch(/^G1 X/m);

  // A tool barely larger than this one leaves nothing it could not reach.
  const clear = generateGCode([roughOp([id], { diameter: 2, restToolDiameter: 2.01 })], doc);
  expect(clear).toMatch(/nothing to rest machine/);
  expect(clear).not.toMatch(/^G1 X/m);
});

test("rest machining is honoured on relief-rough only, not on a relief FINISH", () => {
  const { doc, id } = slotAndPocketDoc();
  // An `engrave` op on the same image is the finish pass; it has no rest concept,
  // and must not silently change when the field is set.
  const finish = (rest?: number): string =>
    generateGCode(
      [
        {
          ...roughOp([id]),
          type: "engrave",
          toolType: "ball-nose",
          diameter: 1,
          restToolDiameter: rest,
        } as CAMOperation,
      ],
      doc,
    );
  expect(finish(8)).toBe(finish(undefined));
});
