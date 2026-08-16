/**
 * The heightfield rasteriser.
 *
 * Every assertion here is on a shape whose height is known in closed form, and
 * the field was rendered to ASCII and read by eye before any of them were
 * written (`npx tsx scripts/stl-probe.ts`) — which is how the pinhole guarded
 * below was found in the first place, with the numeric tests all passing.
 */
import { describe, expect, test } from "vitest";
import { stlHeightfield } from "../src/cam/stlHeightfield";
import { parseSTL } from "../src/io/stlImport";
import { binarySTL, hemisphere, sliverPlate, steppedBlock, type Tri } from "./stlFixtures";

const field = (tris: Tri[], opts = {}) => stlHeightfield(parseSTL(binarySTL(tris)), opts);
const at = (hf: ReturnType<typeof field>, col: number, row: number) =>
  hf.gray[row * hf.width + col];
/** Decode a cell back to a model height in mm. */
const zAt = (hf: ReturnType<typeof field>, col: number, row: number) =>
  (at(hf, col, row) / 255) * (hf.zMaxMM - hf.zMinMM) + hf.zMinMM;

describe("the defining invariant: a hemisphere reads sqrt(R^2 - r^2)", () => {
  test("at every cell, to within one cell", () => {
    const R = 10;
    const hf = field(hemisphere(R, 64, 128), { cellMM: 0.25 });
    const cw = hf.widthMM / hf.width;
    const chh = hf.heightMM / hf.height;
    let worst = 0;
    let checked = 0;
    for (let r = 0; r < hf.height; r++) {
      const y = hf.heightMM / 2 - (r + 0.5) * chh;
      for (let c = 0; c < hf.width; c++) {
        const x = -hf.widthMM / 2 + (c + 0.5) * cw;
        const rad = Math.hypot(x, y);
        if (rad > R - 0.5) continue; // the rim cell straddles the silhouette
        worst = Math.max(worst, Math.abs(Math.sqrt(R * R - rad * rad) - zAt(hf, c, r)));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(4000); // the loop actually ran
    expect(worst).toBeLessThanOrEqual(cw);
  });

  test("the max wins over the flat bottom disc directly beneath it", () => {
    // The fixture closes the dome with a disc at z=0 under every point of it. A
    // rasteriser keeping the last triangle it saw, or the nearest, reads 0 here.
    const hf = field(hemisphere(10, 32, 64), { cellMM: 0.5 });
    const mid = { c: Math.floor(hf.width / 2), r: Math.floor(hf.height / 2) };
    expect(zAt(hf, mid.c, mid.r)).toBeGreaterThan(9.5);
    expect(at(hf, mid.c, mid.r)).toBe(255); // the top of the model is the top byte
  });
});

describe("no gaps in a surface the model covers", () => {
  test("a stepped block rasterises with no uncovered cell", () => {
    // Cell centres land exactly on the diagonal two triangles share, and a plain
    // `w < 0` test drops them from BOTH — a full-depth pinhole through a flat
    // face. This grid produced two of them.
    expect(field(steppedBlock(30, 30, 3, 2), { cellMM: 0.8 }).emptyCells).toBe(0);
  });

  test("...at every cell size across a sweep", () => {
    // Whether a cell centre lands exactly on a shared diagonal depends on how the
    // extent divides by the cell size, so a single size is a lottery ticket: of
    // 0.8/1/1.25/2/3 only 0.8 reproduces it. Sweep, so the guard keeps catching
    // the bug if the fixture is ever adjusted.
    const bad: number[] = [];
    for (let cellMM = 0.4; cellMM <= 3.0001; cellMM += 0.05)
      if (field(steppedBlock(30, 30, 3, 2), { cellMM }).emptyCells > 0) bad.push(cellMM);
    expect(bad).toEqual([]);
  });

  test("every cell of a closed block is a real sample, not just non-empty", () => {
    // Positive control for the above: `emptyCells` counts what no triangle
    // covered, so assert the heights are the three real treads and nothing else.
    const hf = field(steppedBlock(30, 30, 3, 2), { cellMM: 0.8 });
    const heights = new Set(Array.from(hf.gray, (g) => Math.round((g / 255) * 6)));
    expect([...heights].sort((a, b) => a - b)).toEqual([2, 4, 6]);
  });

  test("a plate tessellated into slivers has no gap either", () => {
    // Long thin facets are what real STLs are full of, and were assumed to be the
    // demanding case for the edge tolerance. (They are not — see EDGE_EPS — but
    // the integration check is still the one that would catch a regression.)
    for (const thin of [0.02, 0.002, 0.0002])
      for (const cellMM of [0.25, 0.4, 0.5, 0.7, 1])
        expect(field(sliverPlate(100, thin, 400), { cellMM }).emptyCells).toBe(0);
  });

  test("a shape that genuinely does not fill its bounding box still reports empties", () => {
    // Positive control the other way: emptyCells === 0 above is a property of a
    // rectangular model, not a counter that is always zero.
    expect(field(hemisphere(10, 32, 64), { cellMM: 0.5 }).emptyCells).toBeGreaterThan(0);
  });
});

describe("orientation: rotated into view, never mirrored", () => {
  /** A base plate with one tall pillar at the model's low-X, low-Y corner. */
  const pillar = (): Tri[] => [
    ...steppedBlock(20, 20, 1, 1), // 20×20 plate, 1 tall
    ...steppedBlock(5, 5, 1, 10), // 5×5 pillar at x,y ∈ [0,5], 10 tall
  ];

  test("row 0 is the TOP of the image (maximum Y)", () => {
    // Four steps rising toward +Y: the tall end must land on the first rows.
    const hf = field(steppedBlock(20, 20, 4, 3), { cellMM: 1 });
    expect(at(hf, 10, 0)).toBe(255);
    expect(at(hf, 10, hf.height - 1)).toBeLessThan(at(hf, 10, 0));
    expect(zAt(hf, 10, hf.height - 1)).toBeCloseTo(3, 1); // the lowest tread
  });

  test("column 0 is the model's minimum X — the image is not mirrored", () => {
    const hf = field(pillar(), { cellMM: 0.5 });
    // Pillar at low X / low Y ⇒ bottom-LEFT of the image.
    expect(zAt(hf, 2, hf.height - 3)).toBeCloseTo(10, 1);
    expect(zAt(hf, hf.width - 3, hf.height - 3)).toBeCloseTo(1, 1);
    expect(zAt(hf, 2, 2)).toBeCloseTo(1, 1);
  });

  test("+Y up looks down the Y axis and keeps the height range of that axis", () => {
    const hf = field(hemisphere(10, 32, 64), { up: "+Y", cellMM: 0.5 });
    expect(hf.widthMM).toBeCloseTo(20, 3); // X across
    expect(hf.heightMM).toBeCloseTo(10, 3); // Z up the page
    expect(hf.zMinMM).toBeCloseTo(-10, 3);
    expect(hf.zMaxMM).toBeCloseTo(10, 3);
  });

  test("-Z up carves the underside: the flat disc becomes the top surface", () => {
    const hf = field(hemisphere(10, 32, 64), { up: "-Z", cellMM: 0.5 });
    expect(hf.zMinMM).toBeCloseTo(-10, 3);
    expect(hf.zMaxMM).toBeCloseTo(0, 3);
    // Seen from below, the flat disc is the whole silhouette at one height.
    const mid = Math.floor(hf.width / 2);
    expect(at(hf, mid, Math.floor(hf.height / 2))).toBe(255);
  });
});

describe("the encoding", () => {
  test("model top = 255 = no cut; base = 0 = full depth", () => {
    const hf = field(steppedBlock(20, 20, 2, 5), { cellMM: 1 });
    expect(hf.zMinMM).toBeCloseTo(0, 6);
    expect(hf.zMaxMM).toBeCloseTo(10, 6);
    expect(Math.max(...hf.gray)).toBe(255);
    expect(zAt(hf, 10, 0)).toBeCloseTo(10, 6);
  });

  test("unmodelled cells encode as the base plane, i.e. full depth", () => {
    const hf = field(hemisphere(10, 32, 64), { cellMM: 0.5 });
    expect(at(hf, 0, 0)).toBe(0); // a bbox corner the dome never reaches
  });

  test("zMin/zMax come from the mesh, so resolution does not move the meaning", () => {
    const coarse = field(hemisphere(10, 32, 64), { cellMM: 1 });
    const fine = field(hemisphere(10, 32, 64), { cellMM: 0.2 });
    expect(fine.zMinMM).toBeCloseTo(coarse.zMinMM, 9);
    expect(fine.zMaxMM).toBeCloseTo(coarse.zMaxMM, 9);
  });

  test("scale converts model units to mm throughout", () => {
    const mm = field(steppedBlock(2, 2, 2, 0.5), { cellMM: 0.2 });
    const inch = field(steppedBlock(2, 2, 2, 0.5), { cellMM: 0.2 * 25.4, scale: 25.4 });
    expect(inch.widthMM).toBeCloseTo(mm.widthMM * 25.4, 6);
    expect(inch.zMaxMM).toBeCloseTo(mm.zMaxMM * 25.4, 6);
    // Same shape, bigger. Within one byte, because a tread landing exactly on a
    // rounding boundary (127.5) can fall either way once the scale factor makes
    // the ratio inexact — that is the 8-bit quantum, not a change of shape.
    let worst = 0;
    for (let i = 0; i < mm.gray.length; i++)
      worst = Math.max(worst, Math.abs(mm.gray[i] - inch.gray[i]));
    expect(worst).toBeLessThanOrEqual(1);
    expect(mm.gray.length).toBe(inch.gray.length);
  });

  test("a flat model has no relief: everything is the top surface", () => {
    const hf = field(steppedBlock(20, 20, 1, 0), { cellMM: 1 });
    expect(hf.zMaxMM).toBe(hf.zMinMM);
    expect(Array.from(hf.gray).every((g) => g === 255)).toBe(true);
  });
});

describe("the grid spans the model's bounding box exactly", () => {
  test("widthMM is the model's true width, not a rounded-up multiple of a pitch", () => {
    const hf = field(steppedBlock(37.3, 11.7, 3, 2), { cellMM: 0.5 });
    expect(hf.widthMM).toBeCloseTo(37.3, 4);
    expect(hf.heightMM).toBeCloseTo(11.7, 4);
  });

  test("the longest edge is capped, and the aspect ratio survives the cap", () => {
    const hf = field(steppedBlock(400, 100, 3, 2), { cellMM: 0.05, maxEdge: 200 });
    expect(Math.max(hf.width, hf.height)).toBeLessThanOrEqual(200);
    expect(hf.width / hf.height).toBeCloseTo(4, 1);
    expect(hf.widthMM).toBeCloseTo(400, 4); // the extent is unchanged by the cap
  });

  test("an empty mesh yields a 1x1 'no cut' field rather than throwing", () => {
    const hf = field([]);
    expect(hf.width).toBe(1);
    expect(hf.gray[0]).toBe(255);
    expect(hf.zMaxMM).toBe(0);
  });
});
