/**
 * Rest machining: clear only what a bigger tool left standing.
 *
 * Run with: npx vitest run test/restMachining.test.ts
 *
 * The leftover is a morphological opening, so most of it is checkable in closed
 * form rather than by eyeballing polygons. A round cutter of radius R backed
 * into a 90° corner leaves a sliver of area R²(1 − π/4) — the square it cannot
 * enter, less the quarter-disc it can. Four corners of a square pocket therefore
 * leave 4R²(1 − π/4), and that number is what these tests hold the geometry to.
 */

import { test, expect, describe } from "vitest";
import { restRegions, restCentreRegions, restArea } from "../src/cam/rest";
import { generateGCode } from "../src/cam/gcode";
import { rasterizeStock } from "../src/cam/stockRasterizer";
import { lintGCode, buildLintContext } from "../src/cam/lint";
import { CADDocument } from "../src/model/document";
import { RectEntity, CircleEntity } from "../src/model/entities";
import type { CAMOperation } from "../src/cam/types";
import type { Vec2 } from "../src/core/vec2";

const SQUARE: Vec2[] = [
  { x: 0, y: 0 },
  { x: 40, y: 0 },
  { x: 40, y: 40 },
  { x: 0, y: 40 },
];

/** Area a round cutter of radius R leaves in one 90° corner. */
const cornerSliver = (R: number) => R * R * (1 - Math.PI / 4);

describe("what a bigger tool left behind", () => {
  test("a square pocket keeps exactly four corner slivers", () => {
    const R = 3; // ⌀6 roughing cutter
    const regions = restRegions(SQUARE, [], R);
    expect(regions).toHaveLength(4);

    // Closed form, not a recorded number: four corners of R²(1 − π/4) each.
    const expected = 4 * cornerSliver(R);
    expect(restArea(regions)).toBeGreaterThan(expected * 0.9);
    expect(restArea(regions)).toBeLessThan(expected * 1.1);

    // ...and each sits in a corner, within a tool radius of it.
    const corners = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 40 },
      { x: 0, y: 40 },
    ];
    for (const r of regions) {
      const cx = r.outer.reduce((s, p) => s + p.x, 0) / r.outer.length;
      const cy = r.outer.reduce((s, p) => s + p.y, 0) / r.outer.length;
      const nearest = Math.min(...corners.map((c) => Math.hypot(c.x - cx, c.y - cy)));
      expect(nearest).toBeLessThan(R);
    }
  });

  test("the sliver grows with the square of the roughing tool", () => {
    // Doubling the previous tool quadruples what it leaves behind.
    const small = restArea(restRegions(SQUARE, [], 2));
    const big = restArea(restRegions(SQUARE, [], 4));
    expect(big / small).toBeGreaterThan(3.6);
    expect(big / small).toBeLessThan(4.4);
  });

  test("a round pocket leaves nothing — a round tool reaches all of it", () => {
    const circle: Vec2[] = Array.from({ length: 64 }, (_, i) => {
      const a = (2 * Math.PI * i) / 64;
      return { x: 20 + 15 * Math.cos(a), y: 20 + 15 * Math.sin(a) };
    });
    expect(restArea(restRegions(circle, [], 3))).toBeLessThan(0.5);
  });

  test("a square island adds nothing — a round tool gets round a convex corner", () => {
    // Worth pinning because it's the opposite of the intuition that "an island
    // has corners too". The island's corners stick INTO the material, so the
    // cutter sweeps round the outside of them and misses nothing. Only material
    // that closes around the tool traps stock.
    const island = [
      [
        { x: 15, y: 15 },
        { x: 25, y: 15 },
        { x: 25, y: 25 },
        { x: 15, y: 25 },
      ],
    ];
    const withIsland = restArea(restRegions(SQUARE, island, 3));
    const without = restArea(restRegions(SQUARE, [], 3));
    expect(withIsland).toBeCloseTo(without, 3);
  });

  test("a channel narrower than the roughing tool is left whole", () => {
    // An island sitting 4mm from the wall: a ⌀10 cutter can't enter that
    // channel at all, so all of it is still standing — the case rest machining
    // exists for, and much more material than the corners.
    const island = [
      [
        { x: 4, y: 4 },
        { x: 36, y: 4 },
        { x: 36, y: 36 },
        { x: 4, y: 36 },
      ],
    ];
    const trapped = restArea(restRegions(SQUARE, island, 5));
    const channelArea = 40 * 40 - 32 * 32; // the 4mm ring around the island
    expect(trapped).toBeGreaterThan(channelArea * 0.8);
  });

  test("a previous cut's finishing allowance is still standing", () => {
    // The roughing pass stopped 0.5mm short of the walls, so that skin is part
    // of what's left.
    const plain = restArea(restRegions(SQUARE, [], 3));
    const withSkin = restArea(restRegions(SQUARE, [], 3, 0.5));
    expect(withSkin).toBeGreaterThan(plain);
  });

  test("a tool that never fitted leaves the whole pocket", () => {
    const narrow: Vec2[] = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 4 },
      { x: 0, y: 4 },
    ];
    // A ⌀20 cutter can't enter a 4mm slot at all.
    expect(restArea(restRegions(narrow, [], 10))).toBeGreaterThan(40 * 4 * 0.9);
  });

  test("a curve's discretisation hairs are not treated as stock", () => {
    // A circle arrives as a polyline, and every chord leaves a sliver the round
    // tool didn't quite touch. They are an artefact of writing the circle down,
    // and cutting them means running the machine round a finished pocket.
    const circle = (n: number): Vec2[] =>
      Array.from({ length: n }, (_, i) => {
        const a = (2 * Math.PI * i) / n;
        return { x: 50 + 15 * Math.cos(a), y: 50 + 15 * Math.sin(a) };
      });
    expect(restRegions(circle(64), [], 4)).toEqual([]);
    expect(restRegions(circle(32), [], 4)).toEqual([]);
    // Positive control: a real corner on the same scale is still found.
    expect(restRegions(SQUARE, [], 4).length).toBe(4);
  });

  test("the region handed to the cutter never reaches past the wall", () => {
    // It is grown by a tool diameter so the cutter can manoeuvre, then clipped
    // to the pocket. Expressing that clip as A − (A − B) rather than a true
    // intersection put the boundary 0.16mm OUTSIDE the wall — a gouge in the
    // one place this clip exists to prevent one.
    for (const prevD of [8, 12, 20]) {
      let worst = 0;
      for (const r of restCentreRegions(SQUARE, [], prevD / 2, 1.5)) {
        for (const p of [...r.outer, ...r.holes.flat()]) {
          worst = Math.max(worst, -p.x, p.x - 40, -p.y, p.y - 40);
        }
      }
      expect(worst, `previous ⌀${prevD}`).toBeLessThan(1e-6);
    }
  });

  test("the leftover is reachable by the cutter that has to take it", () => {
    // The bare sliver is not a pocket: the cutter's centre sits in the air the
    // roughing pass made, and only its edge reaches the stock. Inset a 3.5mm²
    // corner sliver by a tool radius and there is nowhere for a centre to go,
    // which had a ⌀3 cutter "not fitting" in a corner it plainly fits.
    for (const [prevD, curD] of [
      [8, 3],
      [12, 3],
      [20, 6],
    ] as const) {
      const centres = restCentreRegions(SQUARE, [], prevD / 2, curD / 2);
      // Non-empty is the whole point: with the sliver itself handed over these
      // came back empty, i.e. "the cutter doesn't fit" in a corner it fits.
      expect(centres.length, `prev ⌀${prevD} → ⌀${curD}`).toBeGreaterThan(0);
    }
  });

  test("degenerate inputs return nothing rather than throwing", () => {
    expect(restRegions([], [], 3)).toEqual([]);
    expect(restRegions(SQUARE, [], 0)).toEqual([]);
    expect(restRegions(SQUARE, [], -1)).toEqual([]);
  });
});

// --- as an operation ---------------------------------------------------------
function pocketGcode(extra: Partial<CAMOperation>): string {
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.stockThickness = 6;
  const r = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 60, y: 60 }));
  doc.operations = [
    {
      id: "op1",
      name: "Pocket",
      type: "pocket",
      side: "inside",
      entityIds: [r.id],
      diameter: 3,
      depth: -3,
      stepdown: 1.5,
      stepover: 0.4,
      feedrate: 900,
      plungeRate: 300,
      spindleSpeed: 14000,
      safeZ: 5,
      ...extra,
    } as CAMOperation,
  ];
  return generateGCode(doc.operations, doc);
}

describe("as a pocket operation", () => {
  test("cuts only the corners, and says so", () => {
    const full = pocketGcode({});
    const rest = pocketGcode({ restToolDiameter: 8 });

    expect(rest).toMatch(/; rest machining after dia 8mm: 4 areas/);

    // Far less CUTTING than clearing the pocket again. Measured as distance,
    // not as a line count: the leftover is bounded by the arc the roughing
    // cutter swept, so its loops are curved and carry many more vertices per
    // millimetre than the pocket's straight sides. Counting lines made the rest
    // pass look longer than the full pocket while it cut a tenth as far.
    const cutDistance = (g: string): number => {
      let d = 0;
      let prev: { x: number; y: number } | null = null;
      for (const l of g.split("\n")) {
        const mx = /^(G[0-3]) .*X(-?\d+(?:\.\d+)?)/.exec(l);
        const my = /Y(-?\d+(?:\.\d+)?)/.exec(l);
        if (!mx || !my) continue;
        const p = { x: Number(mx[2]), y: Number(my[1]) };
        if (prev && mx[1] !== "G0") d += Math.hypot(p.x - prev.x, p.y - prev.y);
        prev = p;
      }
      return d;
    };
    expect(cutDistance(rest)).toBeLessThan(cutDistance(full) / 3);

    // Every cut is near a corner of the 40mm pocket: nothing in the middle,
    // which the roughing pass already took.
    const corners = [
      { x: 20, y: 20 },
      { x: 60, y: 20 },
      { x: 60, y: 60 },
      { x: 20, y: 60 },
    ];
    const strays = rest.split("\n").filter((l) => {
      const mx = /^G[0-3] .*X(-?\d+(?:\.\d+)?)/.exec(l);
      const my = /^G[0-3] .*Y(-?\d+(?:\.\d+)?)/.exec(l);
      if (!mx || !my) return false;
      const p = { x: Number(mx[1]), y: Number(my[1]) };
      return !corners.some((c) => Math.hypot(c.x - p.x, c.y - p.y) < 8);
    });
    expect(strays).toEqual([]);
  });

  test("refuses a previous tool that isn't bigger", () => {
    const g = pocketGcode({ restToolDiameter: 2 });
    expect(g).toMatch(/rest machining needs a previous tool LARGER/);
    // And cuts nothing: a note, not a toolpath.
    expect(g.split("\n").filter((l) => /^G1 /.test(l))).toEqual([]);
  });

  test("says so when the roughing tool already reached everything", () => {
    const doc = new CADDocument({ width: 100, height: 100 });
    doc.stockThickness = 6;
    const c = doc.add(new CircleEntity({ x: 50, y: 50 }, 15));
    doc.operations = [
      {
        id: "op1",
        name: "Pocket",
        type: "pocket",
        side: "inside",
        entityIds: [c.id],
        diameter: 3,
        depth: -3,
        stepdown: 1.5,
        stepover: 0.4,
        feedrate: 900,
        plungeRate: 300,
        spindleSpeed: 14000,
        safeZ: 5,
        restToolDiameter: 8,
      } as CAMOperation,
    ];
    const g = generateGCode(doc.operations, doc);
    expect(g).toMatch(/nothing to rest machine/);
  });

  test("the 3D preview removes only the leftover, like the program does", () => {
    // The preview has its own implementation of what each operation takes off
    // (stockRasterizer "mirrors toolpathBody"), and it did not know about rest
    // machining: it showed the whole pocket coming off while the program cut
    // four corners. A preview that disagrees with the program is worse than
    // none, because it is the thing people believe.
    const build = (extra: Partial<CAMOperation>) => {
      const doc = new CADDocument({ width: 100, height: 100 });
      doc.stockThickness = 6;
      const r = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 60, y: 60 }));
      doc.operations = [
        {
          id: "op1",
          name: "Pocket",
          type: "pocket",
          side: "inside",
          entityIds: [r.id],
          diameter: 3,
          depth: -3,
          stepdown: 1.5,
          stepover: 0.4,
          feedrate: 900,
          plungeRate: 300,
          spindleSpeed: 14000,
          safeZ: 5,
          ...extra,
        } as CAMOperation,
      ];
      const hm = rasterizeStock(doc.operations, doc);
      // How much stock the simulation says came off.
      let removed = 0;
      for (const h of hm.data) removed += hm.stockT - h;
      return removed;
    };

    const full = build({});
    const rest = build({ restToolDiameter: 12 });
    expect(full).toBeGreaterThan(0);
    expect(rest).toBeGreaterThan(0); // the corners DO come off
    expect(rest).toBeLessThan(full / 3);
  });

  test("a rest pass over a round pocket previews as removing nothing", () => {
    const doc = new CADDocument({ width: 100, height: 100 });
    doc.stockThickness = 6;
    const c = doc.add(new CircleEntity({ x: 50, y: 50 }, 15));
    doc.operations = [
      {
        id: "op1",
        name: "Pocket",
        type: "pocket",
        side: "inside",
        entityIds: [c.id],
        diameter: 3,
        depth: -3,
        stepdown: 1.5,
        stepover: 0.4,
        feedrate: 900,
        plungeRate: 300,
        spindleSpeed: 14000,
        safeZ: 5,
        restToolDiameter: 8,
      } as CAMOperation,
    ];
    const hm = rasterizeStock(doc.operations, doc);
    let removed = 0;
    for (const h of hm.data) removed += hm.stockT - h;
    // The program emits a note and no motion, so the preview must match it.
    expect(removed).toBe(0);
  });

  test("pre-flight warns when the named roughing tool isn't in the job", () => {
    // The stale case: the roughing pass was switched to a ⌀10 but the rest pass
    // still names ⌀12. The motion it emits is perfectly valid G-code for a tool
    // that isn't cutting, so nothing else in the program can reveal it.
    const doc = new CADDocument({ width: 100, height: 100 });
    doc.stockThickness = 6;
    const r = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 60, y: 60 }));
    const base = {
      type: "pocket",
      side: "inside",
      entityIds: [r.id],
      depth: -3,
      stepdown: 1.5,
      stepover: 0.4,
      feedrate: 900,
      plungeRate: 300,
      spindleSpeed: 14000,
      safeZ: 5,
    };
    const roughing = (dia: number) =>
      ({ ...base, id: "rough", name: "Rough", diameter: dia }) as CAMOperation;
    const rest = { ...base, id: "rest", name: "Rest", diameter: 3, restToolDiameter: 12 } as CAMOperation;

    const lintFor = (ops: CAMOperation[]) => {
      doc.operations = ops;
      return lintGCode(generateGCode(ops, doc), buildLintContext(doc, {}));
    };

    // Matching roughing tool: no complaint.
    expect(lintFor([roughing(12), rest]).map((f) => f.code)).not.toContain("rest-tool-mismatch");
    // Roughing tool changed to ⌀10 and the rest pass wasn't updated.
    const stale = lintFor([roughing(10), rest]).find((f) => f.code === "rest-tool-mismatch");
    expect(stale?.severity).toBe("warning");
    expect(stale?.message).toContain("12");
    // ...and with no roughing pass at all.
    expect(lintFor([rest]).map((f) => f.code)).toContain("rest-tool-mismatch");
  });

  test("the finishing pass and the dog-bone still act on a rest pass", () => {
    // Both live in the same dialog section, both are enabled for pockets, and
    // both were silently inert here: the rest branch returned before the wall
    // lap that carries them. The dog-bone was the worse of the two — its relief
    // is cut at the corners, and corners are the entire job of a rest pass.
    const lap = /finishing pass \(full-depth wall\)/;

    const plain = pocketGcode({ restToolDiameter: 12 });
    expect(plain, "a plain rest pass shouldn't lap the wall").not.toMatch(lap);

    const finished = pocketGcode({
      restToolDiameter: 12,
      finishPass: true,
      finishAllowance: 0.3,
    });
    expect(finished, "finishing pass must lay down the lap it names").toMatch(lap);

    const boned = pocketGcode({ restToolDiameter: 12, cornerStyle: "dogbone" });
    expect(boned, "a dog-bone needs the lap that cuts its relief").toMatch(lap);
    // ...and it is actually extra motion, not just a comment.
    const moves = (g: string) => g.split("\n").filter((l) => /^G[0-3] /.test(l)).length;
    expect(moves(boned)).toBeGreaterThan(moves(plain));
  });

  test("works with every clearing strategy", () => {
    for (const strategy of ["offset", "adaptive", "raster"] as const) {
      const g = pocketGcode({ restToolDiameter: 8, pocketStrategy: strategy });
      expect(g, strategy).toMatch(/; rest machining after dia 8mm/);
      expect(g.split("\n").filter((l) => /^G[123] /.test(l)).length, strategy).toBeGreaterThan(10);
    }
  });
});
