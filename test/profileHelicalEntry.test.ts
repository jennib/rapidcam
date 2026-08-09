/**
 * A profile enters a closed contour by spiralling down it, not by driving the
 * tool straight in. Run with: npx vitest run test/profileHelicalEntry.test.ts
 *
 * Before this, every profile pass began `G1 Z<depth> F<plungeRate>` — an axial
 * plunge into solid stock at each stepdown, with a non-centre-cutting end mill
 * as likely as not. Pocket entries have spiralled since they were written; the
 * profile path simply never got the same treatment, on any shape.
 *
 * What's pinned here is the shape of the entry and, as much as the behaviour
 * itself, the three cases that must KEEP plunging: a lead-in owns the entry, a
 * finishing lap drops into cleared kerf, and a helix may never descend past a
 * tab it would otherwise machine away.
 */

import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { CircleEntity, RectEntity } from "../src/model/entities";
import { generateGCode } from "../src/cam/gcode";
import type { CAMOperation } from "../src/cam/types";

function op(entityIds: string[], extra: Partial<CAMOperation> = {}): CAMOperation {
  return {
    id: "op1",
    name: "op1",
    type: "profile",
    side: "outside",
    entityIds,
    diameter: 3.175,
    depth: -6,
    stepdown: 2,
    feedrate: 800,
    plungeRate: 300,
    spindleSpeed: 12000,
    safeZ: 5,
    ...extra,
  } as CAMOperation;
}

/** A 60mm square profiled with the given options. */
function squareGcode(extra: Partial<CAMOperation> = {}): string[] {
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.stockThickness = 6;
  const r = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 80, y: 80 }));
  doc.operations = [op([r.id], extra)];
  return generateGCode(doc.operations, doc).split("\n");
}

/** A circle profiled with the given options. */
function circleGcode(extra: Partial<CAMOperation> = {}): string[] {
  const doc = new CADDocument({ width: 100, height: 100 });
  doc.stockThickness = 6;
  const c = doc.add(new CircleEntity({ x: 50, y: 50 }, 20));
  doc.operations = [op([c.id], { side: "inside", ...extra })];
  return generateGCode(doc.operations, doc).split("\n");
}

/** Feed moves that change X/Y *and* Z at once — i.e. a spiral. */
const helixMoves = (g: string[]) => g.filter((l) => /^G1 X\S+ Y\S+ Z/.test(l));
/** Helical interpolation proper: an arc that also changes Z. */
const helixArcs = (g: string[]) => g.filter((l) => /^G[23] .*\bZ-?\d/.test(l));
/** A straight descent into the cut at the plunge feed. */
const plunges = (g: string[]) => g.filter((l) => /^G1 Z-\d.*F/.test(l));

// --- the entry ---------------------------------------------------------------
test("a square profile spirals down its own contour instead of plunging", () => {
  const g = squareGcode();
  // Three stepdowns; each descends around the four sides of the square.
  expect(helixMoves(g).length).toBeGreaterThanOrEqual(12);

  // The flat lap after the descent is what actually cuts the wall to size, so
  // the helix must not have replaced it: four corners, three times over.
  const flat = g.filter((l) => /^G1 X\S+ Y\S+(?! Z)/.test(l) && !/Z/.test(l));
  expect(flat.length).toBeGreaterThanOrEqual(12);
});

test("a circle profile uses real helical interpolation, not a tessellated spiral", () => {
  const g = circleGcode();
  // One G2 with a Z word per stepdown — an arc, not a fan of short segments.
  expect(helixArcs(g)).toHaveLength(3);
  expect(helixMoves(g)).toHaveLength(0);
});

test("a shallower ramp angle buys more laps, never a steeper dive", () => {
  // One 6mm pass around a ~253mm perimeter. At 30° a single lap covers it
  // easily; at 1° a lap only loses 253 × tan1° ≈ 4.4mm, so it must take two.
  // The angle is a cap on the descent, so the only way to honour a shallow one
  // is to go round again.
  const deep = { depth: -6, stepdown: 6 };
  const shallow = helixMoves(squareGcode({ ...deep, rampAngle: 1 }));
  const steep = helixMoves(squareGcode({ ...deep, rampAngle: 30 }));
  expect(steep).toHaveLength(4); // one lap of a square
  expect(shallow).toHaveLength(8); // two
});

// --- the three cases that must keep plunging ---------------------------------
test("a lead-in keeps the plunge — the lead is the entry", () => {
  // The lead starts off the contour: spiralling around the contour would cut
  // before the lead had led anything in.
  const g = squareGcode({ leadIn: { type: "arc", length: 3 } });
  expect(helixMoves(g)).toHaveLength(0);
  expect(plunges(g).length).toBeGreaterThan(0);
});

test("the finishing lap plunges, because its centre sits in the rough kerf", () => {
  const g = squareGcode({ finishPass: true, finishAllowance: 0.3 });
  // Roughing still spirals...
  expect(helixMoves(g).length).toBeGreaterThan(0);
  // ...and the last descent to full depth is a plunge, into stock already cut.
  const lastPlunge = plunges(g).at(-1);
  expect(lastPlunge).toMatch(/^G1 Z-6/);
});

test("a helix never descends past a tab it would machine away", () => {
  // 6mm stock cut through at -6 with 2mm tabs: tab tops sit at Z-4, so no
  // descending move on a tabbed pass may go below that.
  const g = squareGcode({
    depth: -6,
    stepdown: 2,
    tabs: { enabled: true, count: 4, width: 8, height: 2 },
  });
  for (const line of helixMoves(g)) {
    const z = Number(/Z(-?\d+(?:\.\d+)?)/.exec(line)![1]);
    expect(z, `helix cut to ${z}, below the Z-4 tab tops: ${line}`).toBeGreaterThanOrEqual(-4);
  }
  // Positive control: the tabs are real, and the pass below them still happens.
  expect(g.some((l) => /^G1 Z-4/.test(l))).toBe(true);
  expect(g.some((l) => /^G1 Z-6/.test(l))).toBe(true);
});

// --- feeds -------------------------------------------------------------------
test("the spiral cuts at the cutting feed, not the plunge feed", () => {
  const g = squareGcode();
  const first = helixMoves(g)[0];
  // A descent that inherited plungeRate as its modal feed would crawl around the
  // whole contour at 300mm/min.
  expect(first).toContain("F800");
});

test("the approach to the previous floor is still a plunge-rate move", () => {
  const g = squareGcode();
  // Rapid to just above the last floor, then FEED down to it — the tool is over
  // stock it has already cut, but a rapid into it would still be a crash.
  const i = g.findIndex((l) => /^G1 Z-2 F300$/.test(l));
  expect(i).toBeGreaterThan(0);
  expect(g[i - 1]).toMatch(/^G0 Z-1\.5$/);
});
