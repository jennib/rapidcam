/**
 * V-carve halftoning: reproducing tone as the WIDTH of parallel V-grooves.
 *
 * The geometry here is closed-form, so most of these tests are anchored to the
 * formula rather than to a golden output: a groove is `t + 2·d·tan(θ/2)` wide,
 * and the tone it prints is that width over the row pitch. Anything the code
 * says that the formula doesn't is a bug in the code.
 *
 * A 90° bit is used wherever the numbers matter, because `tan(45°) = 1` makes
 * the width exactly twice the depth — an arithmetic slip has nowhere to hide.
 */

import { test, expect, describe } from "vitest";
import {
  grooveWidth,
  usableDepth,
  halftonePlan,
  reliefSpacing,
  grooveOverlapRatio,
  isHalftone,
  OVERLAP_WARN_RATIO,
  HALFTONE_DOT_PITCH_MM,
} from "../src/cam/halftone";
import { rasterField, srgbToLinear } from "../src/cam/rasterEngrave";
import { CADDocument } from "../src/model/document";
import { RasterImageEntity } from "../src/model/entities";
import { generateGCode } from "../src/cam/gcode";
import { rasterizeStock } from "../src/cam/stockRasterizer";
import { registerEmbeddedImage } from "../src/core/imageManager";
import type { CAMOperation, ToolDef } from "../src/cam/types";

// ---------------------------------------------------------------------------
// Groove geometry

describe("groove width", () => {
  test("a sharp bit cuts 2·d·tan(θ/2) wide, at every angle and depth", () => {
    const wrong: string[] = [];
    for (const vAngle of [30, 60, 90, 120]) {
      for (const d of [0.25, 0.5, 1, 2, 3]) {
        const expected = 2 * d * Math.tan((vAngle / 2) * (Math.PI / 180));
        // A 50mm "bit" so the major diameter never caps the result here.
        const got = grooveWidth(d, { vAngle, diameter: 50 });
        if (Math.abs(got - expected) > 1e-9)
          wrong.push(`${vAngle}° at ${d}mm: ${got} ≠ ${expected}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("a 90° bit cuts exactly twice its depth (the arithmetic anchor)", () => {
    expect(grooveWidth(1, { vAngle: 90, diameter: 50 })).toBeCloseTo(2, 12);
    expect(grooveWidth(2.5, { vAngle: 90, diameter: 50 })).toBeCloseTo(5, 12);
  });

  test("a flat tip adds its own width to every groove", () => {
    const sharp = grooveWidth(1, { vAngle: 90, diameter: 50 });
    const flat = grooveWidth(1, { vAngle: 90, tipDiameter: 0.4, diameter: 50 });
    expect(flat - sharp).toBeCloseTo(0.4, 12);
  });

  test("the major diameter caps the groove, and usableDepth is where the cap bites", () => {
    const bit = { vAngle: 90, diameter: 6 };
    // 90° ⇒ width = 2d, so the ⌀6 flutes run out at 3mm.
    expect(usableDepth(bit)).toBeCloseTo(3, 12);
    expect(grooveWidth(3, bit)).toBeCloseTo(6, 12);
    // Past that the groove stops widening — darker tones flatten together.
    expect(grooveWidth(10, bit)).toBeCloseTo(6, 12);
  });

  test("a flat tip eats into the usable depth", () => {
    // The flat is already 1mm of the 6mm, so only 5mm of flare is left: 2.5mm deep.
    expect(usableDepth({ vAngle: 90, tipDiameter: 1, diameter: 6 })).toBeCloseTo(2.5, 12);
  });

  test("zero and negative depth cut nothing", () => {
    expect(grooveWidth(0, { vAngle: 90, diameter: 6 })).toBe(0);
    expect(grooveWidth(-1, { vAngle: 90, diameter: 6 })).toBe(0);
  });

  test("a degenerate included angle still yields finite geometry", () => {
    // Documents can carry anything; 0° and 180° are both non-bits, and neither
    // may produce NaN/Infinity in a row pitch that later divides an image size.
    for (const vAngle of [0, 180, 360, -30]) {
      const w = grooveWidth(1, { vAngle, diameter: 6 });
      expect(Number.isFinite(w)).toBe(true);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(usableDepth({ vAngle, diameter: 6 }))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The screen

describe("halftone plan", () => {
  const BIT = { vAngle: 90, diameter: 50 }; // sharp, wide: width = 2·depth

  test("rows are spaced at the widest groove, so the darkest tone is solid", () => {
    const plan = halftonePlan(BIT, 1);
    expect(plan.grooveWidth).toBeCloseTo(2, 12);
    expect(plan.rowPitch).toBeCloseTo(2, 12);
    expect(plan.maxCoverage).toBeCloseTo(1, 12);
  });

  test("a land widens the rows and costs peak blackness, in proportion", () => {
    const plan = halftonePlan(BIT, 1, 0.5);
    expect(plan.rowPitch).toBeCloseTo(2.5, 12);
    expect(plan.maxCoverage).toBeCloseTo(2 / 2.5, 12);
  });

  test("a negative land is clamped away rather than overlapping the darks", () => {
    expect(halftonePlan(BIT, 1, -5).rowPitch).toBeCloseTo(2, 12);
  });

  test("the along-row pitch does NOT inherit the row pitch", () => {
    // This is the trap the mode exists to avoid: rasterField defaults the dot
    // pitch to the line interval, which here is millimetres — quantising the one
    // axis that should keep the photograph's detail.
    const plan = halftonePlan(BIT, 1);
    expect(plan.dotPitch).toBeLessThanOrEqual(HALFTONE_DOT_PITCH_MM);
    expect(plan.dotPitch).toBeLessThan(plan.rowPitch / 4 + 1e-12);
  });

  test("a very fine screen pulls the dot pitch down with it", () => {
    // rowPitch 0.2mm ⇒ the 0.1mm default would be half the row spacing; the
    // quarter-pitch rule has to win.
    const plan = halftonePlan(BIT, 0.1);
    expect(plan.rowPitch).toBeCloseTo(0.2, 12);
    expect(plan.dotPitch).toBeCloseTo(0.05, 12);
  });

  test("an explicit dot pitch overrides the derived one", () => {
    expect(halftonePlan(BIT, 1, 0, 0.03).dotPitch).toBeCloseTo(0.03, 12);
  });

  test("a sharp bit reaches the highlights; a flat-tip bit cannot", () => {
    expect(halftonePlan(BIT, 1).minCoverage).toBe(0);
    // A 0.4mm flat on a 2mm screen: the lightest 20% of the range is unprintable.
    const flat = halftonePlan({ vAngle: 90, tipDiameter: 0.4, diameter: 50 }, 0.8);
    expect(flat.rowPitch).toBeCloseTo(2, 12);
    expect(flat.minCoverage).toBeCloseTo(0.2, 12);
  });

  test("cutting past the flutes is reported, not absorbed", () => {
    expect(halftonePlan({ vAngle: 90, diameter: 6 }, 2).capped).toBe(false);
    expect(halftonePlan({ vAngle: 90, diameter: 6 }, 4).capped).toBe(true);
  });

  test("coverage is linear in tone — the claim the whole mode rests on", () => {
    // A dot at darkness λ is cut to λ·maxDepth, so its groove is λ·wₘₐₓ wide and
    // covers λ of its row. If this stopped being linear the photo would band.
    const plan = halftonePlan(BIT, 2);
    const off: string[] = [];
    for (const level of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const coverage = grooveWidth(level * 2, BIT) / plan.rowPitch;
      if (Math.abs(coverage - level) > 1e-12) off.push(`level ${level} → ${coverage}`);
    }
    expect(off).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Which spacing an op gets

const OP_BASE: CAMOperation = {
  id: "h1",
  name: "halftone",
  type: "engrave",
  entityIds: [],
  side: "outside",
  toolType: "v-bit",
  toolNumber: 1,
  diameter: 50,
  vAngle: 90,
  feedrate: 1500,
  plungeRate: 300,
  spindleSpeed: 18000,
  safeZ: 5,
  depth: -1,
  stepdown: 1,
  stepover: 0.4,
  rasterLineInterval: 0.5,
};

describe("spacing resolution", () => {
  test("halftone derives the row pitch and ignores rasterLineInterval", () => {
    const s = reliefSpacing({ ...OP_BASE, halftone: true });
    expect(s.lineInterval).toBeCloseTo(2, 12); // 90° at 1mm — not the 0.5 field
    expect(s.plan).not.toBeNull();
  });

  test("an ordinary relief keeps the field it was given", () => {
    const s = reliefSpacing(OP_BASE);
    expect(s.lineInterval).toBeCloseTo(0.5, 12);
    expect(s.plan).toBeNull();
  });

  test("halftone with a ball-nose is refused — the width law is the V's", () => {
    const op = { ...OP_BASE, toolType: "ball-nose" as const, halftone: true };
    expect(isHalftone(op)).toBe(false);
    expect(reliefSpacing(op).lineInterval).toBeCloseTo(0.5, 12);
  });

  test("a halftone's grooves meet exactly — overlap ratio 1 by construction", () => {
    expect(grooveOverlapRatio({ ...OP_BASE, halftone: true })).toBeCloseTo(1, 12);
  });

  test("a plain V-bit relief at a relief stepover overlaps, and by how much", () => {
    // 2mm grooves on 0.5mm rows: each is re-cut by four of its neighbours.
    expect(grooveOverlapRatio(OP_BASE)).toBeCloseTo(4, 12);
    expect(grooveOverlapRatio(OP_BASE)).toBeGreaterThanOrEqual(OVERLAP_WARN_RATIO);
  });

  test("the overlap question doesn't apply to a ball-nose", () => {
    expect(grooveOverlapRatio({ ...OP_BASE, toolType: "ball-nose" })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// End to end: the posted program

let imgCounter = 0;
/** Register a greyscale image, rows given TOP-down, and return its image id. */
function registerGrid(rowsTopDown: number[][]): string {
  const id = `img-ht-${imgCounter++}`;
  registerEmbeddedImage({
    id,
    name: id,
    width: rowsTopDown[0].length,
    height: rowsTopDown.length,
    data: btoa(String.fromCharCode(...rowsTopDown.flat())),
  });
  return id;
}

/** A 20×20mm image of a vertical black/white split, placed at the origin. */
function splitDoc(): { doc: CADDocument; entId: string } {
  const id = registerGrid([
    [0, 255],
    [0, 255],
  ]);
  const doc = new CADDocument({ width: 200, height: 200 });
  doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, 20, 20, 0));
  return { doc, entId: doc.entities.find((e) => e.type === "image")!.id };
}

const rowYs = (g: string): number[] => {
  const ys = new Set<number>();
  for (const m of g.matchAll(/G1 X-?[\d.]+ Y(-?[\d.]+) Z/g)) ys.add(+m[1]);
  return [...ys].sort((a, b) => a - b);
};

describe("posted program", () => {
  test("rows land on the derived pitch, not on the stepover field", () => {
    const { doc, entId } = splitDoc();
    const g = generateGCode(
      [{ ...OP_BASE, entityIds: [entId], halftone: true, rasterDotPitch: 1 }],
      doc,
    );
    // 90° bit, 1mm deep ⇒ 2mm grooves ⇒ 2mm rows ⇒ 10 rows across a 20mm image.
    const ys = rowYs(g);
    expect(ys.length).toBe(10);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeCloseTo(2, 6);
    // Positive control: the program actually cuts (the black half reaches depth).
    expect(g).toMatch(/Z-1(\.0+)?\b/);
  });

  test("the same op without halftone rasters at the stepover instead", () => {
    const { doc, entId } = splitDoc();
    const g = generateGCode([{ ...OP_BASE, entityIds: [entId], rasterDotPitch: 1 }], doc);
    expect(rowYs(g).length).toBe(40); // 20mm / 0.5mm
  });

  test("halftoning a photo posts far less work than the overlapping relief", () => {
    const { doc, entId } = splitDoc();
    const count = (g: string) => (g.match(/^G1 /gm) ?? []).length;
    const plain = count(generateGCode([{ ...OP_BASE, entityIds: [entId] }], doc));
    const half = count(
      generateGCode([{ ...OP_BASE, entityIds: [entId], halftone: true }], doc),
    );
    expect(half).toBeGreaterThan(0); // control: it isn't cheap because it's empty
    expect(half).toBeLessThan(plain);
  });

  test("the halftone note states the screen; the ball-nose advice is gone", () => {
    const { doc, entId } = splitDoc();
    const g = generateGCode([{ ...OP_BASE, entityIds: [entId], halftone: true }], doc);
    // The post transliterates comments to ASCII (° → deg) so a controller can
    // read them back — hence the note is matched in its POSTED form, not source.
    expect(g).toMatch(/V-carve halftone: 90deg bit at 1mm deep cuts 2mm grooves, spaced 2mm/);
    expect(g).toMatch(/darkest tone 100% coverage/);
    expect(g).not.toMatch(/use a ball-nose for a smooth photo relief/);
  });

  test("a V-bit relief with overlapping rows says so, and points at the mode", () => {
    const { doc, entId } = splitDoc();
    const g = generateGCode([{ ...OP_BASE, entityIds: [entId] }], doc);
    expect(g).toMatch(/each groove is re-cut by ~4\.0 of its neighbours/);
    expect(g).toMatch(/Turn on V-carve halftone/);
  });

  test("...and stays quiet when the rows are already spaced to the bit", () => {
    // Positive control for the warning above: same op, rows at the groove width.
    const { doc, entId } = splitDoc();
    const g = generateGCode(
      [{ ...OP_BASE, entityIds: [entId], rasterLineInterval: 2 }],
      doc,
    );
    expect(g).toMatch(/^G1 /m); // it did post a program
    expect(g).not.toMatch(/re-cut by/);
  });

  test("a flat-tip bit is told it cannot reach the highlights", () => {
    const { doc, entId } = splitDoc();
    const g = generateGCode(
      [{ ...OP_BASE, entityIds: [entId], halftone: true, tipDiameter: 0.4, depth: -0.8 }],
      doc,
    );
    expect(g).toMatch(/lightest 20% of the tonal range cannot be/);
  });

  test("a bit too small for the depth is told the flutes run out", () => {
    const { doc, entId } = splitDoc();
    const g = generateGCode(
      [{ ...OP_BASE, entityIds: [entId], halftone: true, diameter: 6, depth: -4 }],
      doc,
    );
    expect(g).toMatch(/runs out of flute at 3mm/);
  });
});

// ---------------------------------------------------------------------------
// The 3-D preview must be a picture of the program, not of something adjacent

describe("preview agrees with the program", () => {
  /** Total material removed from the height field — a coarse but honest summary. */
  const removed = (ops: CAMOperation[], doc: CADDocument): number => {
    const hm = rasterizeStock(ops, doc);
    let sum = 0;
    for (const v of hm.data) sum += hm.stockT - v;
    return sum;
  };

  test("turning halftone on changes the preview", () => {
    // Before the shared resolver, rasRelief read rasterLineInterval directly and
    // so previewed a screen the program would never cut.
    const { doc, entId } = splitDoc();
    doc.stockThickness = 10;
    const plain = removed([{ ...OP_BASE, entityIds: [entId] }], doc);
    const half = removed([{ ...OP_BASE, entityIds: [entId], halftone: true }], doc);
    expect(plain).toBeGreaterThan(0); // control: both actually carve
    expect(half).toBeGreaterThan(0);
    expect(half).not.toBeCloseTo(plain, 3);
  });

  test("the preview honours a library tool, as the emitter does", () => {
    // rasterizeStock used the op's INLINE geometry, so editing a tool in the
    // library moved the toolpath and not the picture of it.
    const { doc, entId } = splitDoc();
    doc.stockThickness = 10;
    const tool: ToolDef = {
      id: "t-vee",
      name: "30° vee",
      toolType: "v-bit",
      diameter: 50,
      vAngle: 30, // vs the op's inline 90°: a much narrower groove
      feedrate: 1500,
      plungeRate: 300,
      spindleSpeed: 18000,
      safeZ: 5,
    };
    doc.tools.push(tool);
    const inline = removed([{ ...OP_BASE, entityIds: [entId], halftone: true }], doc);
    const library = removed(
      [{ ...OP_BASE, entityIds: [entId], halftone: true, toolId: "t-vee" }],
      doc,
    );
    expect(inline).toBeGreaterThan(0);
    expect(library).toBeGreaterThan(0);
    expect(library).not.toBeCloseTo(inline, 3);
  });
});

// ---------------------------------------------------------------------------
// Tone: coverage mixes by REFLECTANCE, so it reads linear light

describe("tone mapping", () => {
  test("sRGB → linear matches the standard at its landmarks", () => {
    expect(srgbToLinear(0)).toBeCloseTo(0, 12);
    expect(srgbToLinear(1)).toBeCloseTo(1, 12);
    // The one that matters: "middle grey" reflects about a fifth of the light,
    // which is why it needs most of a row covered rather than half.
    expect(srgbToLinear(0.5)).toBeCloseTo(0.2140, 4);
    expect(srgbToLinear(128 / 255)).toBeCloseTo(0.2159, 4);
    // Monotonic, and the linear part below the knee.
    expect(srgbToLinear(0.04)).toBeCloseTo(0.04 / 12.92, 12);
  });

  const grid = { width: 1, height: 1, data: [128 / 255] };
  const field = (tone?: "encoded" | "linear") =>
    rasterField(grid, { widthMM: 1, heightMM: 1, lineIntervalMM: 1, tone }).rows[0].levels[0];

  test("the default is unchanged — omitting `tone` still inverts the byte", () => {
    // The laser and the ordinary relief both ride this path; a silent change to
    // either would be a tonal shift on work that already prints correctly.
    expect(field()).toBeCloseTo(1 - 128 / 255, 2);
    expect(field("encoded")).toBeCloseTo(1 - 128 / 255, 2);
  });

  test("linear tone puts middle grey at ~78% coverage, not 50%", () => {
    expect(field("linear")).toBeCloseTo(1 - 0.2159, 2);
  });

  test("a halftone asks for linear tone; nothing else does", () => {
    expect(reliefSpacing({ ...OP_BASE, halftone: true }).tone).toBe("linear");
    expect(reliefSpacing(OP_BASE).tone).toBe("encoded");
    expect(reliefSpacing({ ...OP_BASE, toolType: "ball-nose", halftone: true }).tone).toBe(
      "encoded",
    );
  });

  test("and it reaches the cut: a grey halftone goes deeper than half depth", () => {
    const id = registerGrid([
      [128, 128],
      [128, 128],
    ]);
    const doc = new CADDocument({ width: 200, height: 200 });
    doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, 20, 20, 0));
    const entId = doc.entities.find((e) => e.type === "image")!.id;
    const op = { ...OP_BASE, entityIds: [entId], depth: -2, stepdown: 2, rasterDotPitch: 1 };
    const deepest = (g: string) =>
      Math.min(...[...g.matchAll(/Z(-[\d.]+)/g)].map((m) => +m[1]), 0);
    // 1 − linear(128/255) = 0.784 of 2mm.
    expect(deepest(generateGCode([{ ...op, halftone: true }], doc))).toBeCloseTo(-1.568, 2);
    // The ordinary relief keeps the encoded mapping: about half.
    expect(deepest(generateGCode([op], doc))).toBeCloseTo(-0.996, 2);
  });
});

// ---------------------------------------------------------------------------
// Stepdown passes that cut nothing

describe("stepdown passes", () => {
  /**
   * 4 rows top-down: black, light, light, black. The deep rows are deliberately
   * NON-adjacent — with them side by side the second pass is one unbroken run
   * and the gap case below can never arise, which is exactly how the first
   * version of this fixture made its own gouge test vacuous.
   */
  function bandedDoc(): { doc: CADDocument; entId: string } {
    const id = registerGrid([
      [0, 0],
      [230, 230],
      [230, 230],
      [0, 0],
    ]);
    const doc = new CADDocument({ width: 200, height: 200 });
    doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, 20, 20, 0));
    return { doc, entId: doc.entities.find((e) => e.type === "image")!.id };
  }

  /**
   * Feed moves, split into unbroken cutting CHAINS — a `G0` ends one and starts
   * the next. The first version of this matched G1 lines with a global regex,
   * which skipped the G0s entirely and so could not tell a retract from a cut:
   * it reported the hop between two passes as a gouge, and would equally have
   * missed a real one.
   */
  const feedChains = (g: string): { x: number; y: number; z: number }[][] => {
    const chains: { x: number; y: number; z: number }[][] = [];
    let cur: { x: number; y: number; z: number }[] = [];
    for (const line of g.split("\n")) {
      if (line.startsWith("G0")) {
        if (cur.length) chains.push(cur);
        cur = [];
        continue;
      }
      const m = /^G1 X(-?[\d.]+) Y(-?[\d.]+) Z(-?[\d.]+)/.exec(line);
      if (m) cur.push({ x: +m[1], y: +m[2], z: +m[3] });
    }
    if (cur.length) chains.push(cur);
    return chains;
  };
  const allMoves = (g: string) => feedChains(g).flat();

  test("a later pass skips rows the earlier one already finished", () => {
    const { doc, entId } = bandedDoc();
    const op = {
      ...OP_BASE,
      entityIds: [entId],
      depth: -4,
      stepdown: 2, // 2 passes
      rasterLineInterval: 5,
      rasterDotPitch: 5,
      toolType: "ball-nose" as const,
      // OP_BASE carries a ⌀50 V-bit MAJOR diameter, which as a ball-nose is a
      // 25mm-radius flank — it cannot cut a 5mm band 4mm deep beside one that
      // stays near the surface, so the tool-shape correction holds the whole
      // image above the first pass floor and the second pass has nothing to skip.
      diameter: 3,
    };
    const g = generateGCode([op], doc);
    const moves = allMoves(g);
    // 4 rows of a 20mm image ⇒ row centres at 2.5, 7.5, 12.5, 17.5.
    const rowsAt = (ms: { y: number }[]) => [...new Set(ms.map((m) => m.y))].sort((a, b) => a - b);
    // Control: the program as a whole still visits every row.
    expect(rowsAt(moves)).toEqual([2.5, 7.5, 12.5, 17.5]);
    // But only the black band goes past the first pass's floor, so only those
    // two rows are traced a second time. The light band is left alone.
    expect(rowsAt(moves.filter((m) => m.z < -2 - 1e-9))).toEqual([2.5, 17.5]);
  });

  test("no feed move ever spans more than one row — a skip must retract", () => {
    // The gouge this guards: skipping rows breaks the boustrophedon snake, and
    // continuing at cutting depth across the gap would plough a groove through
    // every row in between.
    const { doc, entId } = bandedDoc();
    const g = generateGCode(
      [
        {
          ...OP_BASE,
          entityIds: [entId],
          depth: -4,
          stepdown: 2,
          rasterLineInterval: 5,
          rasterDotPitch: 5,
          toolType: "ball-nose" as const,
        },
      ],
      doc,
    );
    const rowPitch = 5;
    const chains = feedChains(g);
    expect(chains.flat().length).toBeGreaterThan(0); // control: it posts a program
    // Within one chain the tool never leaves the material, so a Y step bigger
    // than a row means it cut its way across the rows in between.
    const spans: string[] = [];
    for (const chain of chains)
      for (let i = 1; i < chain.length; i++)
        if (Math.abs(chain[i].y - chain[i - 1].y) > rowPitch + 1e-6)
          spans.push(`${chain[i - 1].y} → ${chain[i].y}`);
    expect(spans).toEqual([]);
  });

  test("a single-pass relief still rides every row, blank ones included", () => {
    // The first pass is deliberately untouched: it establishes the surface and
    // its continuity is what keeps the path one snake.
    const { doc, entId } = bandedDoc();
    const g = generateGCode(
      [
        {
          ...OP_BASE,
          entityIds: [entId],
          depth: -4,
          stepdown: 4, // one pass
          rasterLineInterval: 5,
          rasterDotPitch: 5,
          toolType: "ball-nose" as const,
        },
      ],
      doc,
    );
    const ys = new Set(allMoves(g).map((m) => m.y));
    expect(ys.size).toBe(4);
  });
});

// ---------------------------------------------------------------------------

test("halftone set on a non-V-bit says it is being ignored", () => {
  // The dialog cannot produce this; a hand-written or generated .rcam can.
  const { doc, entId } = splitDoc();
  const g = generateGCode(
    [{ ...OP_BASE, entityIds: [entId], toolType: "ball-nose", halftone: true }],
    doc,
  );
  expect(g).toMatch(/halftone needs a V-bit \(got "ball-nose"\) - ignored/);
});
