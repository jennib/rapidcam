import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateGCode } from "../src/cam/gcode";
import { groupContoursIntoRegions } from "../src/cam/vcarve";
import { textToContours } from "../src/cam/textOutlines";
import { loadFromFile } from "../src/core/fontManager";
import { CADDocument } from "../src/model/document";
import { TextEntity } from "../src/model/entities";
import type { CAMOperation } from "../src/cam/types";

// V-carve's headline use case is text — which exercises font glyph extraction
// and nesting letter counters (the hole in "o"/"e"/"a") as holes. A rectangle
// never touches that path, so verify it directly with a real font.

let fontId: string;

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const bytes = readFileSync(join(here, "..", "public", "fonts", "roboto-regular.woff"));
  const fakeFile = {
    name: "roboto.woff",
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as File;
  ({ id: fontId } = await loadFromFile(fakeFile));
});

const vcarveOp = (entityIds: string[]): CAMOperation => ({
  id: "v1",
  name: "carve",
  type: "vcarve",
  entityIds,
  side: "outside",
  toolType: "v-bit",
  toolNumber: 1,
  diameter: 12,
  vAngle: 60,
  feedrate: 1000,
  plungeRate: 300,
  spindleSpeed: 18000,
  safeZ: 5,
  depth: -3,
  stepdown: 1.5,
  stepover: 0.4,
  vStep: 0.4,
});

const cutDepths = (g: string): number[] =>
  [...g.matchAll(/G1 Z(-?\d+(?:\.\d+)?)/g)].map((m) => parseFloat(m[1]));

describe("v-carve of text", () => {
  it("nests a letter counter as a hole", () => {
    // A lowercase "o" is one solid ring with one interior counter.
    const contours = textToContours(new TextEntity("o", fontId, 20, { x: 10, y: 10 }, 0));
    expect(contours.length).toBeGreaterThanOrEqual(2); // outer + counter
    const regions = groupContoursIntoRegions(contours.map((c) => c.points));
    expect(regions.length).toBe(1);
    expect(regions[0].holes.length).toBe(1); // the counter is carved as a hole
  });

  it("generates a varying-depth carve for a word with counters", () => {
    const doc = new CADDocument({ width: 120, height: 60 }, "mm");
    const t = doc.add(new TextEntity("Go", fontId, 24, { x: 10, y: 15 }, 0));
    const out = generateGCode([vcarveOp([t.id])], doc);

    expect(out).toContain('; --- V-Carve "carve"');
    const depths = cutDepths(out);
    expect(depths.length).toBeGreaterThan(0);
    // More than one distinct depth = genuinely variable-depth (a carve, not a
    // constant-depth engrave). Thin glyph strokes have fewer peel levels than a
    // large area, so the bar is "varies", not a fixed count.
    expect(new Set(depths).size).toBeGreaterThan(1);
    for (const z of depths) expect(z).toBeGreaterThanOrEqual(-3 - 1e-6); // clamped at |depth|
  });

  it("carves every glyph of small text, at varying depth", () => {
    // ~9mm text has strokes under 1mm wide. On the old fixed 0.4mm peel pitch
    // the first inset wiped them out before a single contour was generated:
    // "NAME" came out as three part-letters at one constant depth, with the "A"
    // (which bottoms out at r=0.38) missing altogether.
    const doc = new CADDocument({ width: 90, height: 50 }, "mm");
    const t = doc.add(new TextEntity("NAME", fontId, 8.9, { x: 34, y: 19.4 }, 0));
    const out = generateGCode([vcarveOp([t.id])], doc);

    const depths = cutDepths(out);
    expect(depths.length).toBeGreaterThan(0);
    expect(new Set(depths).size).toBeGreaterThan(1); // a carve, not a groove

    // Every letter must be cut. Bucket the cut moves by X against the glyph
    // columns: the "A" and the "E" crossbars are the parts that used to vanish.
    const xs = [...out.matchAll(/^G[01] X(-?\d+(?:\.\d+)?)/gm)].map((m) => parseFloat(m[1]));
    for (const [letter, lo, hi] of [
      ["N", 34.7, 39.6],
      ["A", 40.5, 46.2],
      ["M", 46.9, 53.3],
      ["E", 54.7, 58.8],
    ] as const) {
      const inCol = xs.filter((x) => x >= lo && x <= hi);
      expect(inCol.length, `no cut moves over "${letter}"`).toBeGreaterThan(0);
      // ...and across its full width, so a stem alone can't satisfy this.
      expect(
        Math.max(...inCol) - Math.min(...inCol),
        `"${letter}" cut only partly`,
      ).toBeGreaterThan((hi - lo) * 0.6);
    }
  });

  it("emits nothing cuttable when the font is missing (no silent miscut)", () => {
    const doc = new CADDocument({ width: 120, height: 60 }, "mm");
    const t = doc.add(new TextEntity("Go", "no-such-font", 24, { x: 10, y: 15 }, 0));
    const out = generateGCode([vcarveOp([t.id])], doc);
    expect(out).toMatch(/font not loaded or no glyphs/);
    expect(cutDepths(out)).toEqual([]);
  });
});
