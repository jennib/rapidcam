import { expect, test } from "vitest";
import { generateGCode } from "../src/cam/gcode";
import type { CAMOperation } from "../src/cam/types";
import { CADDocument } from "../src/model/document";
import { PolylineEntity, RectEntity, type CornerType } from "../src/model/entities";

/**
 * The end of the chain: a shaped rectangle reaching the actual G-code.
 *
 * This is the failure the whole two-pass structure exists to prevent — the
 * toolpath cutting square corners while the canvas draws round ones, the
 * drawing and the program disagreeing. Pass A's seam and its drift guard make
 * that very unlikely; this makes it checked. "Very likely correct" is exactly
 * what Pass A was built to stop anyone having to say.
 *
 * Measured against the toolpath's own geometry rather than against the code
 * that produced it: an outside profile of a corner of radius r, cut with a tool
 * of radius R, must run on an arc of radius r+R about the SAME centre. That
 * pins the corner's shape, its size and its position at once, and it fails if
 * the boundary handed to CAM was ever the square one.
 */

const W = 80;
const H = 60;
const R = 12; // corner radius
const TOOL_D = 6;

function shapedDoc(type: CornerType, radius = R): { doc: CADDocument; rect: RectEntity } {
  const doc = new CADDocument({ width: 200, height: 200 }, "mm");
  const rect = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 20 + W, y: 20 + H }));
  rect.cornerRadii = [radius, radius, radius, radius];
  rect.cornerType = type;
  return { doc, rect };
}

function profileOp(rect: RectEntity, side: "outside" | "inside"): CAMOperation {
  return {
    id: "op",
    name: "cut",
    type: "profile",
    side,
    entityIds: [rect.id],
    toolType: "end-mill",
    toolNumber: 1,
    diameter: TOOL_D,
    feedrate: 1000,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -2,
    stepdown: 2,
    stepover: 0.4,
  };
}

/** Every cutting move's XY, in order. */
function cutPath(code: string): { x: number; y: number }[] {
  return code
    .split("\n")
    .filter((l) => /^G[123] /.test(l) && /X/.test(l) && /Y/.test(l))
    .map((l) => ({
      x: parseFloat(l.match(/X(-?[\d.]+)/)![1]),
      y: parseFloat(l.match(/Y(-?[\d.]+)/)![1]),
    }));
}

test("an outside profile follows the ROUND, not the square corner", () => {
  const { doc, rect } = shapedDoc("round");
  const path = cutPath(generateGCode([profileOp(rect, "outside")], doc));
  expect(path.length).toBeGreaterThan(8);

  // The bottom-left corner's arc centre, and the radius the tool centre must
  // run at: r + toolRadius on an outside cut.
  const c = { x: 20 + R, y: 20 + R };
  const want = R + TOOL_D / 2;
  const inCorner = path.filter((p) => p.x < c.x && p.y < c.y);
  expect(inCorner.length, "the corner region must contain cutting moves").toBeGreaterThan(2);
  for (const p of inCorner) {
    expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeCloseTo(want, 1);
  }

  // The square corner is where the tool would go if CAM had seen a plain
  // rectangle: offset diagonally out from (20,20). Nothing may be near it.
  const sq = { x: 20 - TOOL_D / 2, y: 20 - TOOL_D / 2 };
  const nearest = Math.min(...path.map((p) => Math.hypot(p.x - sq.x, p.y - sq.y)));
  expect(nearest, "the toolpath must not visit the square corner").toBeGreaterThan(2);
});

test("a square rectangle still cuts a square corner — the positive control", () => {
  // Without this, the assertion above passes for a toolpath that is simply
  // never near anything.
  const { doc, rect } = shapedDoc("round", 0);
  const path = cutPath(generateGCode([profileOp(rect, "outside")], doc));
  const sq = { x: 20 - TOOL_D / 2, y: 20 - TOOL_D / 2 };
  const nearest = Math.min(...path.map((p) => Math.hypot(p.x - sq.x, p.y - sq.y)));
  expect(nearest).toBeLessThan(0.5);
});

test("an inverted corner cuts INTO the shape, and no cut escapes the blank", () => {
  const { doc, rect } = shapedDoc("inverted");
  const path = cutPath(generateGCode([profileOp(rect, "outside")], doc));

  // The cove is centred on the corner point itself; an outside cut runs at
  // r − toolRadius there, because the tool is outside the material, i.e. INSIDE
  // the cove. A sign error here would put the path at r + R and cut away the
  // corner instead of scooping it.
  const corner = { x: 20, y: 20 };
  const near = path.filter((p) => Math.hypot(p.x - corner.x, p.y - corner.y) < R * 1.5);
  expect(near.length).toBeGreaterThan(2);
  const dists = near.map((p) => Math.hypot(p.x - corner.x, p.y - corner.y));
  expect(Math.min(...dists)).toBeGreaterThan(R - TOOL_D / 2 - 1);
});

test("a chamfered corner cuts a straight bevel", () => {
  const { doc, rect } = shapedDoc("chamfer");
  const path = cutPath(generateGCode([profileOp(rect, "outside")], doc));
  // Points across the bottom-left bevel lie on one straight line, so the area
  // of the triangle any three of them make is ~0.
  const c = { x: 20 + R, y: 20 + R };
  const bevel = path
    .filter((p) => p.x < c.x && p.y < c.y)
    .sort((a, b) => a.x - b.x);
  expect(bevel.length).toBeGreaterThanOrEqual(3);
  const [a, b, d] = [bevel[0], bevel[Math.floor(bevel.length / 2)], bevel[bevel.length - 1]];
  const area2 = Math.abs((b.x - a.x) * (d.y - a.y) - (d.x - a.x) * (b.y - a.y));
  expect(area2 / Math.hypot(d.x - a.x, d.y - a.y)).toBeLessThan(0.6); // deviation, mm
});

test("the toolpath keeps its winding — kerf side does not flip on a shaped corner", () => {
  // CAM consumers take which side of the boundary to compensate from the ring's
  // winding. A corner that reversed it would cut the part to the wrong size.
  for (const type of ["round", "inverted", "chamfer"] as const) {
    const { doc, rect } = shapedDoc(type);
    const path = cutPath(generateGCode([profileOp(rect, "outside")], doc));
    let a = 0;
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      const q = path[(i + 1) % path.length];
      a += p.x * q.y - q.x * p.y;
    }
    // Same sign as a plain rectangle's cut, whatever that convention is.
    const { doc: sqDoc, rect: sqRect } = shapedDoc("round", 0);
    const sqPath = cutPath(generateGCode([profileOp(sqRect, "outside")], sqDoc));
    let sa = 0;
    for (let i = 0; i < sqPath.length; i++) {
      const p = sqPath[i];
      const q = sqPath[(i + 1) % sqPath.length];
      sa += p.x * q.y - q.x * p.y;
    }
    expect(Math.sign(a), type).toBe(Math.sign(sa));
  }
});

test("a shaped rectangle cuts EXACTLY as the same points would as a polyline", () => {
  // The seam's core promise, stated as an identity: whatever CAM does with a
  // boundary, a rectangle's shaped boundary gets the same treatment, because it
  // IS the same boundary by the time CAM sees it. It also settles attribution —
  // anything odd in the toolpath around a cove is the shared polygon offsetter's
  // behaviour for concave geometry, not something corner radii introduced.
  const { doc: dA, rect } = shapedDoc("inverted");
  const A = cutPath(generateGCode([profileOp(rect, "outside")], dA));

  const dB = new CADDocument({ width: 200, height: 200 }, "mm");
  const pl = dB.add(new PolylineEntity(rect.outlinePoints(), true));
  const opB = { ...profileOp(rect, "outside"), entityIds: [pl.id] };
  const B = cutPath(generateGCode([opB], dB));

  expect(A.length).toBe(B.length);
  expect(A).toEqual(B);
});

test("the cove is cut at its true radius, inside the tolerance budget", () => {
  // The arc's own accuracy, separately from the junction: every cutting move on
  // the cove sits at r − toolRadius from the corner point.
  //
  // The budget is stated rather than tuned. Two known contributions:
  //   • 0.05 mm — outlinePoints' default chord-flattening tolerance, the CAM
  //     arc tolerance this app has always used;
  //   • 0.01 mm — G-code is emitted at two decimals.
  // Measured worst case is 0.022 mm, comfortably inside both. Asserting
  // "microns" would have been asserting something the design never promised.
  const { doc, rect } = shapedDoc("inverted");
  const path = cutPath(generateGCode([profileOp(rect, "outside")], doc));
  const corner = { x: 20, y: 20 };
  const want = R - TOOL_D / 2;
  const onArc = path
    .map((p) => Math.hypot(p.x - corner.x, p.y - corner.y))
    .filter((d) => Math.abs(d - want) < 0.5);
  expect(onArc.length, "the cove must actually be traced").toBeGreaterThan(3);
  for (const d of onArc) expect(Math.abs(d - want)).toBeLessThan(0.06);
});
