/**
 * Adaptive clearing has to earn its name: the claim is that the cutter is never
 * buried much deeper than a straight wall step would bury it. That is a physical
 * property of the path, so these tests measure it — with test/engagementSim.ts,
 * a bitmap simulation that shares no code with the generator — rather than
 * asserting on the shape of the output.
 *
 * Run with: npx vitest run test/adaptiveClearing.test.ts
 *
 * The measurement is anchored first: on a straight cut it must agree with the
 * closed-form engagement angle. Without that check, every number below would be
 * self-referential — a generator and a simulator that share a wrong idea of
 * engagement agree perfectly and mean nothing.
 */

import { test, expect, describe } from "vitest";
import { contourParallelClear, cuttableRegion, type ClearingMove } from "../src/cam/clearing";
import { adaptiveClear, nominalEngagementDeg } from "../src/cam/adaptive";
import { simulateEngagement, densify } from "./engagementSim";
import type { Vec2 } from "../src/core/vec2";
import { CADDocument } from "../src/model/document";
import { RectEntity } from "../src/model/entities";
import { generateGCode } from "../src/cam/gcode";
import type { CAMOperation } from "../src/cam/types";

const TOOL_R = 3.175 / 2;
const STEPOVER = 0.4 * 3.175; // 40% of diameter — the app's default
const NOMINAL = nominalEngagementDeg(TOOL_R, STEPOVER);

const SQUARE: Vec2[] = [
  { x: 0, y: 0 },
  { x: 40, y: 0 },
  { x: 40, y: 40 },
  { x: 0, y: 40 },
];
/** A sharp internal corner mid-wall — where an offset loop wraps and digs in. */
const L_SHAPE: Vec2[] = [
  { x: 0, y: 0 },
  { x: 40, y: 0 },
  { x: 40, y: 15 },
  { x: 15, y: 15 },
  { x: 15, y: 40 },
  { x: 0, y: 40 },
];
/** A channel too narrow for two passes: an offset loop has to slot down it. */
const NECK: Vec2[] = [
  { x: 0, y: 0 },
  { x: 40, y: 0 },
  { x: 40, y: 40 },
  { x: 24, y: 40 },
  { x: 24, y: 22 },
  { x: 16, y: 22 },
  { x: 16, y: 40 },
  { x: 0, y: 40 },
];

/** Each move removes material as a unit; a closed loop returns to its start. */
const passesOf = (moves: ClearingMove[]): Vec2[][] =>
  moves.map((m) => (m.closed === false ? m.loop : [...m.loop, m.loop[0]]));

interface Measured {
  p95: number;
  median: number;
  max: number;
  cleared: number;
  lengthMM: number;
}

function measure(passes: Vec2[][], outer: Vec2[], holes: Vec2[][] = []): Measured {
  const r = simulateEngagement(passes, { outer, holes }, TOOL_R, { cell: 0.1, stepMM: 0.25 });
  const sorted = [...r.series].sort((a, b) => a - b);
  let lengthMM = 0;
  for (const p of passes) {
    for (let i = 1; i < p.length; i++) lengthMM += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
  }
  return {
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    median: r.medianDeg,
    max: r.maxDeg,
    cleared: r.cleared,
    lengthMM,
  };
}

const offset = (outer: Vec2[], holes: Vec2[][] = []) =>
  passesOf(contourParallelClear(outer, holes, TOOL_R, STEPOVER));
const adaptive = (outer: Vec2[], holes: Vec2[][] = []) =>
  passesOf(adaptiveClear(outer, holes, TOOL_R, { stepover: STEPOVER }));

// --- the instrument ----------------------------------------------------------
describe("the measurement itself", () => {
  test("agrees with the closed-form engagement of a straight side cut", () => {
    // Two passes down a wide slab, spaced one stepover apart: the second removes
    // a crescent exactly `stepover` deep, for which the engaged arc is
    // 2·acos(1 − stepover/r) with no simulation needed.
    const slab: Vec2[] = [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 30 },
      { x: 0, y: 30 },
    ];
    const y0 = 10;
    const passes: Vec2[][] = [
      [
        { x: 5, y: y0 },
        { x: 55, y: y0 },
      ],
      [
        { x: 55, y: y0 + STEPOVER },
        { x: 5, y: y0 + STEPOVER },
      ],
    ];
    const stepMM = 0.25;
    const r = simulateEngagement(passes, { outer: slab, holes: [] }, TOOL_R, {
      cell: 0.05,
      stepMM,
    });
    // Only the SECOND pass has a neighbour to step over from; the first is a
    // slot in solid stock at 360°, and taking a median across both would just
    // measure which of the two contributed more samples.
    const firstCount = densify(passes[0], stepMM).length;
    const second = r.series.slice(firstCount).sort((a, b) => a - b);
    const median = second[Math.floor(second.length / 2)];
    expect(median).toBeGreaterThan(NOMINAL - 6);
    expect(median).toBeLessThan(NOMINAL + 6);
    // ...and the first pass really is a slot, which is what the entry has to
    // avoid doing laterally.
    expect(Math.max(...r.series.slice(0, firstCount))).toBeGreaterThan(340);
  });
});

// --- what offset clearing actually does --------------------------------------
describe("contour-parallel clearing (the strategy that was called adaptive)", () => {
  test("buries the cutter far past the nominal load", () => {
    // This is the baseline the new strategy is measured against, and the reason
    // the old label was wrong: an offset loop's load is set by the shape of the
    // wall, not by the stepover.
    for (const [name, shape] of [
      ["square", SQUARE],
      ["L-shape", L_SHAPE],
      ["neck", NECK],
    ] as const) {
      const m = measure(offset(shape), shape);
      // The innermost loop is a closed slot in solid stock: fully buried.
      expect(m.max, `${name}: expected full immersion somewhere`).toBeGreaterThan(340);
      expect(m.p95, `${name}: p95 should exceed nominal`).toBeGreaterThan(NOMINAL * 1.3);
    }
  });
});

// --- the claim ---------------------------------------------------------------
describe("adaptive clearing", () => {
  test("holds the sustained load far below what offset clearing reaches", () => {
    for (const [name, shape] of [
      ["square", SQUARE],
      ["L-shape", L_SHAPE],
      ["neck", NECK],
    ] as const) {
      const o = measure(offset(shape), shape);
      const a = measure(adaptive(shape), shape);
      expect(a.p95, `${name}: p95 ${a.p95} vs offset ${o.p95}`).toBeLessThan(o.p95);
      // ...and below the straight-wall load with a margin, which is the promise.
      expect(a.p95, `${name}: p95 ${a.p95} vs nominal ${NOMINAL}`).toBeLessThan(NOMINAL * 1.35);
      expect(a.median, `${name}: median ${a.median}`).toBeLessThan(NOMINAL);
    }
  });

  test("clears as much material as the offset strategy does", () => {
    // A gentler toolpath that leaves stock standing is not gentler, it's broken.
    for (const [name, shape] of [
      ["square", SQUARE],
      ["L-shape", L_SHAPE],
      ["neck", NECK],
    ] as const) {
      const o = measure(offset(shape), shape);
      const a = measure(adaptive(shape), shape);
      expect(a.cleared, `${name}: cleared ${a.cleared} vs offset ${o.cleared}`).toBeGreaterThanOrEqual(
        o.cleared - 0.002,
      );
    }
  });

  test("never puts the cutter where it would gouge a wall", () => {
    // Every position must keep the tool centre inside the cuttable region — the
    // trochoidal circles are the new thing here, and a circle that overhangs the
    // boundary cuts into the finished wall.
    const holes = [
      [
        { x: 15, y: 15 },
        { x: 25, y: 15 },
        { x: 25, y: 25 },
        { x: 15, y: 25 },
      ],
    ];
    const region = cuttableRegion(SQUARE, holes, TOOL_R);
    const inPoly = (pt: Vec2, poly: Vec2[]): boolean => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i],
          b = poly[j];
        if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x)
          inside = !inside;
      }
      return inside;
    };
    const inside = (pt: Vec2) => region.filter((p) => inPoly(pt, p)).length % 2 === 1;
    /** Distance from a point to the nearest boundary edge. */
    const toBoundary = (pt: Vec2): number => {
      let best = Infinity;
      for (const poly of region) {
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i],
            b = poly[(i + 1) % poly.length];
          const dx = b.x - a.x,
            dy = b.y - a.y,
            l2 = dx * dx + dy * dy;
          const t =
            l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / l2));
          best = Math.min(best, Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy)));
        }
      }
      return best;
    };

    // Overhang, not in/out: the wall pass runs ALONG the region boundary, so its
    // own corners land exactly on it and classify either way depending on which
    // side of a floating-point comparison they fall. What would actually gouge
    // is a position measurably outside.
    let worst = 0;
    for (const pass of adaptive(SQUARE, holes)) {
      for (const p of pass) if (!inside(p)) worst = Math.max(worst, toBoundary(p));
    }
    expect(worst).toBeLessThan(0.001);
  });

  test("handles islands, and still clears around them", () => {
    const holes = [
      [
        { x: 15, y: 15 },
        { x: 25, y: 15 },
        { x: 25, y: 25 },
        { x: 15, y: 25 },
      ],
    ];
    const a = measure(adaptive(SQUARE, holes), SQUARE, holes);
    const o = measure(offset(SQUARE, holes), SQUARE, holes);
    expect(a.cleared).toBeGreaterThanOrEqual(o.cleared - 0.002);
    expect(a.p95).toBeLessThan(o.p95);
  });

  test("costs travel, which is the trade being made", () => {
    // Stated rather than hidden: the gentler load is bought with air time. If
    // this ratio ever collapses to ~1 the strategy has stopped trochoiding and
    // the load numbers above deserve re-checking.
    const o = measure(offset(SQUARE), SQUARE);
    const a = measure(adaptive(SQUARE), SQUARE);
    expect(a.lengthMM / o.lengthMM).toBeGreaterThan(1.5);
    expect(a.lengthMM / o.lengthMM).toBeLessThan(8);
  });

  test("posts as arcs, and stays inside the pocket", () => {
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
        diameter: 3.175,
        depth: -3,
        stepdown: 1.5,
        stepover: 0.4,
        feedrate: 900,
        plungeRate: 300,
        spindleSpeed: 14000,
        safeZ: 5,
        pocketStrategy: "adaptive",
      } as CAMOperation,
    ];
    const g = generateGCode(doc.operations, doc);
    const lines = g.split("\n");

    expect(lines.some((l) => /^; clearing pass .*adaptive/.test(l))).toBe(true);

    // Trochoidal circles are circles. Drawn as line segments this pocket posted
    // 20,876 moves; as arcs it posts a tenth of that, and a controller can look
    // ahead through it.
    const arcs = lines.filter((l) => /^G[23] /.test(l)).length;
    const moves = lines.filter((l) => /^G[0-3] /.test(l)).length;
    expect(arcs).toBeGreaterThan(100);
    expect(moves).toBeLessThan(6000);

    // Nothing may be cut outside the pocket: the tool centre stays a radius in.
    // Collected and asserted once — an expect() per line is thousands of calls
    // and turned this file from 4s into 50s.
    const lo = 20 + 3.175 / 2 - 0.01;
    const hi = 60 - 3.175 / 2 + 0.01;
    const outside = lines.filter((l) => {
      const mx = /^G[0-3] .*X(-?\d+(?:\.\d+)?)/.exec(l);
      const my = /^G[0-3] .*Y(-?\d+(?:\.\d+)?)/.exec(l);
      if (!mx || !my) return false;
      const x = Number(mx[1]),
        y = Number(my[1]);
      return x < lo || x > hi || y < lo || y > hi;
    });
    expect(outside).toEqual([]);
  });

  test("degenerate inputs produce nothing rather than throwing", () => {
    expect(adaptiveClear([], [], TOOL_R, { stepover: STEPOVER })).toEqual([]);
    // A pocket smaller than the cutter.
    const tiny: Vec2[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    expect(adaptiveClear(tiny, [], TOOL_R, { stepover: STEPOVER })).toEqual([]);
    expect(adaptiveClear(SQUARE, [], TOOL_R, { stepover: 0 })).toEqual([]);
  });
});
