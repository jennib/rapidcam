import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { CircleEntity, RasterImageEntity } from "../src/model/entities";
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
  const id = `img-rr-${counter++}`;
  registerEmbeddedImage({
    id,
    name: id,
    width: w,
    height: h,
    data: btoa(String.fromCharCode(...rowsTopDown.flat())),
  });
  return id;
}

// A flat-tool roughing op. stepover is a FRACTION of diameter → raster pitch = stepover·diameter.
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
    depth: -3,
    stepdown: 1,
    stepover: 0.5, // pitch = 1mm
    finishAllowance: 0.5,
    ...over,
  };
}

// The flat cutting plane reached by each run's entry — either a straight plunge
// (`G1 Z…`) or a descending ramp (`G1 X.. Y.. Z…`), both ending at the plane.
const planes = (g: string) =>
  [...g.matchAll(/G1 (?:X-?[\d.]+ Y-?[\d.]+ )?Z(-?[\d.]+) F/g)].map((m) => +m[1]);
// (plane, endX, endY) of each cut run: the entry (plunge or ramp) then the flat cut move.
const runs = (g: string) =>
  [...g.matchAll(/G1 (?:X-?[\d.]+ Y-?[\d.]+ )?Z(-?[\d.]+) F\d+\nG1 X(-?[\d.]+) Y(-?[\d.]+)/g)].map(
    (m) => ({ z: +m[1], x: +m[2], y: +m[3] }),
  );
const imgId = (doc: CADDocument) => doc.entities.find((e) => e.type === "image")!.id;

test("relief-rough: clears in flat Z-levels down to depth minus the finish allowance", () => {
  const id = registerGrid([[0, 0, 0, 0, 0, 0]]); // solid black, one row
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, 6, 2, 0));
  const g = generateGCode([roughOp([imgId(doc)])], doc); // depth -3, stepdown 1, allowance 0.5

  const distinct = [...new Set(planes(g))].sort((a, b) => a - b);
  // Planes step down by 1 and the last clamps to -(3−0.5) = -2.5, leaving 0.5mm.
  expect(distinct).toEqual([-2.5, -2, -1]);
  for (const z of planes(g)) expect(z).toBeGreaterThanOrEqual(-2.5 - 1e-9); // never into the allowance
});

test("relief-rough: nothing to rough when the allowance covers the whole depth", () => {
  const id = registerGrid([[0, 0]]);
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, 4, 2, 0));
  const g = generateGCode([roughOp([imgId(doc)], { depth: -1, finishAllowance: 1 })], doc);
  expect(g).toMatch(/nothing to rough/);
  expect(runs(g)).toEqual([]);
});

test("relief-rough: white (surface) areas are never cut", () => {
  const id = registerGrid([[255, 255, 255, 255]]); // all white
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, 8, 2, 0));
  const g = generateGCode([roughOp([imgId(doc)])], doc);
  expect(runs(g)).toEqual([]); // no material to remove
  expect(g).not.toMatch(/nothing to rough/); // it's a valid op, just empty here
});

test("relief-rough: only a greyscale image is roughed — other geometry is noted", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  const c = doc.add(new CircleEntity({ x: 50, y: 50 }, 10));
  const g = generateGCode([roughOp([c.id])], doc);
  expect(g).toMatch(/relief roughing targets a greyscale image/);
  expect(runs(g)).toEqual([]);
});

test("relief-rough: a black top-left pixel is cleared deepest at top-left in world (Y-up)", () => {
  // 2×2: black only top-left, over 20mm so the dark quadrant is 10×10mm — room
  // for a ⌀5 tool to get into. (At the old 4×4mm it was a 2mm-wide well and the
  // tool physically could not enter it without ploughing the surface either
  // side, which is what the footprint correction now refuses.)
  // diameter 5, stepover 0.4 → 2mm pitch → a 10×10 cell grid.
  const id = registerGrid([
    [0, 255],
    [255, 255],
  ]);
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.add(new RasterImageEntity(id, { x: 10, y: 20 }, 20, 20, 0));
  const g = generateGCode(
    [
      roughOp([imgId(doc)], {
        diameter: 5,
        stepover: 0.4,
        depth: -2,
        stepdown: 2,
        finishAllowance: 0.5,
      }),
    ],
    doc,
  );

  const rs = runs(g);
  expect(rs.length).toBeGreaterThan(0);
  for (const r of rs) {
    expect(r.z).toBeCloseTo(-1.5, 6); // one plane at -(2−0.5)
    expect(r.x).toBeLessThan(20); // LEFT half (image spans x 10…30)
    expect(r.y).toBeGreaterThan(30); // TOP half (y 20…40) — image row 0 is up
  }
  // The ⌀5 tool keeps a radius clear of the white: it never reaches the quadrant
  // boundary, and never the far side of it.
  expect(Math.max(...rs.map((r) => r.x))).toBeLessThanOrEqual(20 - 5 / 2);
  expect(Math.min(...rs.map((r) => r.y))).toBeGreaterThanOrEqual(30 + 5 / 2);
});

test("relief-rough: long runs enter with a descending ramp (not a straight plunge)", () => {
  const id = registerGrid([[0, 0, 0, 0, 0, 0, 0, 0]]); // wide solid run
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, 16, 2, 0));
  const g = generateGCode(
    [
      roughOp([imgId(doc)], {
        diameter: 2,
        stepover: 0.5,
        depth: -1,
        stepdown: 1,
        finishAllowance: 0,
      }),
    ],
    doc,
  );
  // The run is 15mm long, far longer than the ramp distance → a ramping G1 X Y Z entry.
  expect(g).toMatch(/G1 X-?[\d.]+ Y-?[\d.]+ Z-?[\d.]+ F/);
  // The ramp descends to the cutting plane and no move ever goes below it.
  for (const z of planes(g)) expect(z).toBeGreaterThanOrEqual(-1 - 1e-9);
});

test("relief-rough: a lone cell (too short to ramp) plunges straight", () => {
  // diameter 5 → 2mm pitch → 5 cells; the middle three are dark. A ⌀5 tool fits
  // only in the centre one — either edge of the dark band is a radius short —
  // so exactly one cell is cleared, which is the single-cell run this is about.
  const id = registerGrid([[255, 0, 0, 0, 255]]);
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, 10, 2, 0));
  const g = generateGCode(
    [
      roughOp([imgId(doc)], {
        diameter: 5,
        stepover: 0.4,
        depth: -1,
        stepdown: 1,
        finishAllowance: 0,
      }),
    ],
    doc,
  );
  expect(g).toMatch(/G1 Z-1(\.0+)? F/); // a bare vertical plunge exists
  expect(g).not.toMatch(/G1 X-?[\d.]+ Y-?[\d.]+ Z/); // no ramp move for a single cell
});

test("relief-rough: a realistic gradient roughs to a clean staircase leaving the allowance", () => {
  // 64×64: a solid-black core (a deep flat region) fading to white at the edge —
  // like a real relief with both a deep pocket and graded sides.
  const N = 64,
    px: number[] = [];
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const d = Math.hypot(x - N / 2, y - N / 2) / (N / 2); // 0 centre … 1 edge
      px.push(d < 0.3 ? 0 : Math.round(Math.min(255, ((d - 0.3) / 0.7) * 255)));
    }
  registerEmbeddedImage({
    id: "img-rr-grad",
    name: "g",
    width: N,
    height: N,
    data: btoa(String.fromCharCode(...px)),
  });
  const doc = new CADDocument({ width: 200, height: 200 });
  doc.add(new RasterImageEntity("img-rr-grad", { x: 20, y: 20 }, 60, 60, 0));
  const id = doc.entities.find((e) => e.type === "image")!.id;
  const g = generateGCode(
    [roughOp([id], { diameter: 3, stepover: 0.5, depth: -6, stepdown: 1.5, finishAllowance: 0.5 })],
    doc,
  );

  const distinct = [...new Set(planes(g))].sort((a, b) => a - b);
  // depth 6, allowance 0.5 → clear to −5.5 in 1.5mm steps: −1.5, −3, −4.5, −5.5 (last clamped).
  expect(distinct).toEqual([-5.5, -4.5, -3, -1.5]);
  for (const z of planes(g)) expect(z).toBeGreaterThanOrEqual(-5.5 - 1e-9); // never into the 0.5mm allowance
  // A dark-centre gradient: shallow planes clear a large area, deep planes a small one.
  const areaAt = (z: number) => runs(g).filter((r) => Math.abs(r.z - z) < 1e-6).length;
  expect(areaAt(-1.5)).toBeGreaterThan(areaAt(-5.5)); // shallowest clears more runs than the deepest
});

test("relief-rough: the roughing header labels the op", () => {
  const id = registerGrid([[0, 0]]);
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, 4, 2, 0));
  expect(generateGCode([roughOp([imgId(doc)])], doc)).toMatch(/Relief Roughing/);
});

// --- output-size checkpoint -------------------------------------------------
test("output size: a gradient roughing stays bounded by the cell grid × passes", () => {
  const grad = Array.from({ length: 256 }, (_, x) => x);
  const id = registerGrid([grad]);
  const doc = new CADDocument({ width: 200, height: 200 });
  doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, 50, 40, 0));
  // diameter 2, stepover 0.2 → 0.4mm pitch → 125×100 cells; depth 3 / stepdown 1 / allowance 0.5 → 3 passes.
  const g = generateGCode(
    [
      roughOp([imgId(doc)], {
        diameter: 2,
        stepover: 0.2,
        depth: -3,
        stepdown: 1,
        finishAllowance: 0.5,
      }),
    ],
    doc,
  );
  const cols = 125,
    rows = 100,
    passes = 3;
  const nRuns = runs(g).length;
  expect(nRuns).toBeLessThanOrEqual(cols * rows * passes); // bounded, not per-pixel unbounded
  expect(nRuns).toBeGreaterThan(rows); // it does clear real area
});

test("a large relief roughing generates without overflowing the stack", () => {
  // Sized to the assertion below (>1000 moves), not to the spread-push limit.
  // NOTE this test does NOT prove the ~125k spread overflow its title implies —
  // 1000 moves is three orders of magnitude short of it. The finish-relief test
  // in reliefGcode.test.ts carries that guard properly; this one covers that the
  // ROUGHING emit path runs and produces motion. It used to build a 400×300
  // image over 80×60mm to assert >1000, which cost real memory for nothing.
  // 6mm chequers, not the `(i*37)%256` noise this used to use: that swung the
  // full tonal range every few cells, which a ⌀1 end mill cannot rough without
  // ploughing its neighbours — so the footprint correction (correctly) left
  // nothing to cut and this dropped to zero moves. Squares six times the tool
  // diameter are broken up enough to make many runs per row and coarse enough
  // that the tool genuinely fits inside them.
  const bytes = Uint8Array.from({ length: 200 * 150 }, (_, i) =>
    (Math.floor((i % 200) / 30) + Math.floor(Math.floor(i / 200) / 30)) % 2 ? 255 : 0,
  );
  let bin = "";
  const C = 0x8000;
  for (let i = 0; i < bytes.length; i += C) bin += String.fromCharCode(...bytes.subarray(i, i + C));
  registerEmbeddedImage({
    id: "img-rr-big",
    name: "big",
    width: 200,
    height: 150,
    data: btoa(bin),
  });
  const doc = new CADDocument({ width: 200, height: 200 });
  doc.add(new RasterImageEntity("img-rr-big", { x: 0, y: 0 }, 40, 30, 0));
  const id = doc.entities.find((e) => e.type === "image")!.id;
  let g = "";
  expect(() => {
    g = generateGCode(
      [roughOp([id], { diameter: 1, stepover: 0.3, depth: -4, stepdown: 1, finishAllowance: 0.4 })],
      doc,
    );
  }).not.toThrow();
  expect(countG1(g)).toBeGreaterThan(1000);
});
