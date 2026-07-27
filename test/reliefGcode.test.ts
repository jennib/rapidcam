import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { RasterImageEntity } from "../src/model/entities";
import { generateGCode } from "../src/cam/gcode";
import { registerEmbeddedImage } from "../src/core/imageManager";
import type { CAMOperation } from "../src/cam/types";

/** Count line-start "G1 " occurrences WITHOUT materialising a match array —
 *  `g.match(/^G1 /gm)` allocates 150k+ strings purely to read `.length`, which
 *  is real memory pressure when vitest runs files in parallel workers. */
function countG1(g: string): number {
  let n = g.startsWith("G1 ") ? 1 : 0;
  for (let i = g.indexOf("\nG1 "); i !== -1; i = g.indexOf("\nG1 ", i + 1)) n++;
  return n;
}

let counter = 0;
function registerGrid(rowsTopDown: number[][]): string {
  const w = rowsTopDown[0].length,
    h = rowsTopDown.length;
  const id = `img-rl-${counter++}`;
  registerEmbeddedImage({
    id,
    name: id,
    width: w,
    height: h,
    data: btoa(String.fromCharCode(...rowsTopDown.flat())),
  });
  return id;
}

function reliefOp(entityIds: string[], over: Partial<CAMOperation> = {}): CAMOperation {
  return {
    id: "r1",
    name: "relief",
    type: "engrave",
    entityIds,
    side: "outside",
    toolType: "ball-nose",
    toolNumber: 1,
    diameter: 2,
    feedrate: 1500,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -2,
    stepdown: 2,
    stepover: 0.4,
    rasterLineInterval: 2,
    rasterDotPitch: 2,
    ...over,
  };
}

// Pull (X, Y, Z) from every G1 move that commands a Z.
const zMoves = (g: string) =>
  [...g.matchAll(/G1 X(-?[\d.]+) Y(-?[\d.]+) Z(-?[\d.]+)/g)].map((m) => ({
    x: +m[1],
    y: +m[2],
    z: +m[3],
  }));

test("relief: a black top-left pixel carves deepest at top-left in world (Y-up, depth)", () => {
  // 2×2: top row [black, white], bottom row [white, white].
  const id = registerGrid([
    [0, 255],
    [255, 255],
  ]);
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.add(new RasterImageEntity(id, { x: 10, y: 20 }, 4, 4, 0));
  const g = generateGCode([reliefOp([doc.entities.find((e) => e.type === "image")!.id])], doc);

  const moves = zMoves(g);
  const deepest = moves.reduce((a, b) => (b.z < a.z ? b : a));
  expect(deepest.z).toBeCloseTo(-2, 6); // black dot reaches full depth
  expect(deepest.x).toBeCloseTo(11, 6); // left column (dot centre at 10 + 0.5·2)
  expect(deepest.y).toBeCloseTo(23, 6); // TOP band (20 + 1.5·2) — image row 0 is up
  // Nothing is cut deeper than the relief depth; white stays at the surface.
  for (const m of moves) expect(m.z).toBeGreaterThanOrEqual(-2 - 1e-6);
  expect(moves.some((m) => Math.abs(m.z) < 1e-9)).toBe(true);
});

test("relief: the tone curve (gamma) reshapes mid-tone depth, leaving black at full depth", () => {
  const id = registerGrid([
    [128, 128],
    [128, 128],
  ]); // mid-grey (needs ≥2 dots/row for a ride move)
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, 4, 4, 0));
  const idd = doc.entities.find((e) => e.type === "image")!.id;
  const depthAt = (gamma?: number) => {
    const g = generateGCode(
      [
        reliefOp([idd], {
          depth: -4,
          stepdown: 4,
          rasterLineInterval: 2,
          rasterDotPitch: 2,
          reliefGamma: gamma,
        }),
      ],
      doc,
    );
    return -Math.min(...zMoves(g).map((m) => m.z)); // carved depth of the mid-grey dot
  };
  const linear = depthAt(undefined);
  expect(depthAt(2)).toBeLessThan(linear); // gamma>1 makes the mid-tone shallower
  expect(depthAt(0.5)).toBeGreaterThan(linear); // gamma<1 deepens it

  // Black still reaches full depth regardless of gamma.
  const black = registerGrid([
    [0, 0],
    [0, 0],
  ]);
  const doc2 = new CADDocument({ width: 100, height: 100 });
  doc2.add(new RasterImageEntity(black, { x: 0, y: 0 }, 4, 4, 0));
  const gb = generateGCode(
    [
      reliefOp([doc2.entities.find((e) => e.type === "image")!.id], {
        depth: -4,
        stepdown: 4,
        rasterLineInterval: 2,
        rasterDotPitch: 2,
        reliefGamma: 2,
      }),
    ],
    doc2,
  );
  expect(Math.min(...zMoves(gb).map((m) => m.z))).toBeCloseTo(-4, 6);
});

test("relief: requires a depth-shaping bit (ball-nose / V-bit)", () => {
  const id = registerGrid([[0]]);
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, 10, 10, 0));
  const imgId = doc.entities.find((e) => e.type === "image")!.id;
  expect(generateGCode([reliefOp([imgId], { toolType: "end-mill" })], doc)).toMatch(
    /needs a ball-nose or V-bit/,
  );
  expect(zMoves(generateGCode([reliefOp([imgId], { toolType: "end-mill" })], doc))).toEqual([]);
  // V-bit is accepted, but flagged as an engraving-like result (not a smooth relief).
  const vg = generateGCode([reliefOp([imgId], { toolType: "v-bit" })], doc);
  expect(zMoves(vg).length).toBeGreaterThan(0);
  expect(vg).toMatch(/V-bit carves an engraving-like relief/);
  // A ball-nose gets no such note.
  expect(generateGCode([reliefOp([imgId], { toolType: "ball-nose" })], doc)).not.toMatch(
    /engraving-like/,
  );
});

test("relief: reaches depth over stepdown passes (never one deep plunge)", () => {
  const id = registerGrid([[0, 0]]); // a solid-black 1-row image
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, 6, 2, 0));
  // depth 3, stepdown 1 → 3 passes; the floor deepens 1mm at a time.
  const g = generateGCode(
    [
      reliefOp([doc.entities.find((e) => e.type === "image")!.id], {
        depth: -3,
        stepdown: 1,
        rasterLineInterval: 2,
        rasterDotPitch: 2,
      }),
    ],
    doc,
  );
  // The depth floor deepens one stepdown per pass (so virgin-material engagement
  // per pass is ≤ stepdown — prior passes already cleared the material above).
  const floors = [...new Set(zMoves(g).map((m) => m.z))].sort((a, b) => a - b);
  expect(floors).toEqual([-3, -2, -1]);
  // Three distinct passes (each starts with a safe-Z retract + plunge).
  const passStarts = [...g.matchAll(/G0 Z[\d.]+\nG0 X[^\n]+\nG1 Z(-?[\d.]+) F/g)].length;
  expect(passStarts).toBe(3);
});

test("relief: missing pixels are reported, not silently dropped", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.add(new RasterImageEntity("img-missing", { x: 0, y: 0 }, 10, 10, 0));
  expect(
    generateGCode([reliefOp([doc.entities.find((e) => e.type === "image")!.id])], doc),
  ).toMatch(/pixels not loaded/);
});

test("relief: a rotated image carves along its tilted rows (no longer refused)", () => {
  const id = registerGrid([[0, 0]]); // dark row
  const axis = new CADDocument({ width: 100, height: 100 });
  axis.add(new RasterImageEntity(id, { x: 10, y: 10 }, 10, 10, 0));
  const ga = generateGCode([reliefOp([axis.entities.find((e) => e.type === "image")!.id])], axis);

  const rot = new CADDocument({ width: 100, height: 100 });
  rot.add(new RasterImageEntity(id, { x: 10, y: 10 }, 10, 10, Math.PI / 2)); // 90°
  const gr = generateGCode([reliefOp([rot.entities.find((e) => e.type === "image")!.id])], rot);

  expect(gr).not.toMatch(/rotated/); // not skipped
  expect(gr).toMatch(/Z-/); // still carves depth
  expect(gr).not.toBe(ga); // rotation changed the coordinates
});

// --- output-size checkpoint -------------------------------------------------
test("output size: a solid relief merges each row to its endpoints (not one move per dot)", () => {
  const id = registerGrid([[0, 0, 0, 0]]); // solid; physical size drives the dot grid
  const doc = new CADDocument({ width: 200, height: 200 });
  doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, 50, 40, 0));
  // 0.2mm stepover/dot → 250×200 dots; depth 2 / stepdown 2 → 1 pass.
  const g = generateGCode(
    [
      reliefOp([doc.entities.find((e) => e.type === "image")!.id], {
        depth: -2,
        stepdown: 2,
        rasterLineInterval: 0.2,
        rasterDotPitch: 0.2,
      }),
    ],
    doc,
  );
  const moves = zMoves(g).length;
  // Equal-depth dots collapse: ~2 segments per row (×200 rows), not 250×200.
  expect(moves).toBeLessThan(200 * 6);
  expect(moves).toBeGreaterThan(200); // but every row is represented
});

test("a large relief generates without overflowing the stack (no spread-push)", () => {
  // ~290k moves — large enough that `lines.push(...reliefBody)` would overflow.
  const bytes = Uint8Array.from({ length: 400 * 300 }, (_, i) => (i * 37) % 256);
  let bin = "";
  const C = 0x8000; // chunk: String.fromCharCode(...) also has an arg limit
  for (let i = 0; i < bytes.length; i += C) bin += String.fromCharCode(...bytes.subarray(i, i + C));
  registerEmbeddedImage({ id: "img-big", name: "big", width: 400, height: 300, data: btoa(bin) });

  // 60×45mm rather than 80×60: moves scale with area, and this still emits ~205k
  // — comfortably past the ~125k spread limit the guard is about — while costing
  // ~100MB of heap instead of 188MB. That allocation, times vitest's parallel
  // workers, is what made this and unrelated tests time out on a loaded machine.
  const doc = new CADDocument({ width: 200, height: 200 });
  doc.add(new RasterImageEntity("img-big", { x: 0, y: 0 }, 60, 45, 0));
  const id = doc.entities.find((e) => e.type === "image")!.id;
  let g = "";
  expect(() => {
    g = generateGCode(
      [
        reliefOp([id], {
          depth: -3,
          stepdown: 1.5,
          rasterLineInterval: 0.15,
          rasterDotPitch: 0.15,
        }),
      ],
      doc,
    );
  }).not.toThrow();
  expect(countG1(g)).toBeGreaterThan(150_000);
  // Generating ~290k moves is genuinely heavy (~2.4s alone). It used to carry a
  // per-test `30_000` override for that; the suite-wide testTimeout in
  // vite.config.ts now covers it, so the magic number lives in one place.
});

test("output size: a gradient relief stays bounded by the dot grid × passes", () => {
  const grad = Array.from({ length: 256 }, (_, x) => x);
  const id = registerGrid([grad]); // 256×1, tiled vertically by resampling
  const doc = new CADDocument({ width: 200, height: 200 });
  doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, 50, 40, 0));
  const g = generateGCode(
    [
      reliefOp([doc.entities.find((e) => e.type === "image")!.id], {
        depth: -3,
        stepdown: 1.5,
        rasterLineInterval: 0.2,
        rasterDotPitch: 0.2,
      }),
    ],
    doc,
  );
  const cols = 250,
    rows = 200,
    passes = 2;
  const moves = zMoves(g).length;
  expect(moves).toBeLessThanOrEqual(cols * rows * passes); // bounded, not unbounded
  expect(moves).toBeGreaterThan(rows); // it does vary with tone
});
