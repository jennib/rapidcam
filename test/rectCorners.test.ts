import { expect, test } from "vitest";
import { RectEntity } from "../src/model/entities";

/**
 * Parametric corners on a rectangle.
 *
 * The geometry is asserted through AREA rather than through the point list.
 * A point list only says the code did what the code does; the area of the ring
 * says the shape is the shape — it catches an arc centred in the wrong place, a
 * sweep going the wrong way round, and a corner treatment applied as its
 * opposite, none of which a "check these coordinates" test would notice.
 *
 *   round     w·h − r²(4 − π)   four corners, each a square minus a quarter disc
 *   inverted  w·h − πr²         four quarter discs bitten out
 *   chamfer   w·h − 2r²         four right triangles cut off
 *
 * Signed area also pins the WINDING, which every CAM consumer depends on for
 * which side of the boundary the kerf goes.
 */

const W = 60;
const H = 40;
const FINE = 0.001; // flattening tolerance: keeps the area error under ~1e-4%

function rect(): RectEntity {
  return new RectEntity({ x: 10, y: 20 }, { x: 10 + W, y: 20 + H });
}

/** Shoelace area of a closed ring. Positive = counter-clockwise. */
function signedArea(pts: { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

test("no radius: the outline is exactly the four corners", () => {
  const r = rect();
  expect(r.outlinePoints()).toEqual(r.corners());
  expect(r.hasShapedCorners()).toBe(false);
  expect(r.outlineParts().every((p) => p.kind === "line")).toBe(true);
  expect(r.outlineParts()).toHaveLength(4);
});

test("round corners cut a square-minus-quarter-disc from each corner", () => {
  const r = rect();
  r.cornerRadii = [8, 8, 8, 8];
  r.cornerType = "round";
  const area = signedArea(r.outlinePoints(FINE));
  expect(area).toBeCloseTo(W * H - 8 * 8 * (4 - Math.PI), 1);
  expect(area).toBeGreaterThan(0); // still CCW
});

test("inverted corners bite a quarter disc out of each corner", () => {
  const r = rect();
  r.cornerRadii = [8, 8, 8, 8];
  r.cornerType = "inverted";
  const area = signedArea(r.outlinePoints(FINE));
  expect(area).toBeCloseTo(W * H - Math.PI * 8 * 8, 1);
  expect(area).toBeGreaterThan(0);
});

test("chamfered corners cut a right triangle off each corner", () => {
  const r = rect();
  r.cornerRadii = [8, 8, 8, 8];
  r.cornerType = "chamfer";
  const pts = r.outlinePoints();
  expect(pts).toHaveLength(8); // two per corner, no tessellation
  expect(signedArea(pts)).toBeCloseTo(W * H - 2 * 8 * 8, 6);
});

test("an inverted corner takes MORE material than a round one of the same radius", () => {
  // The two are not sign flips of one number: a cove removes the whole quarter
  // disc, a round removes only the part outside it. Getting this backwards
  // would still produce a plausible-looking shape.
  const round = rect();
  round.cornerRadii = [8, 8, 8, 8];
  const cove = rect();
  cove.cornerRadii = [8, 8, 8, 8];
  cove.cornerType = "inverted";
  expect(signedArea(cove.outlinePoints(FINE))).toBeLessThan(signedArea(round.outlinePoints(FINE)));
});

test("a round corner is tangent to both edges; an inverted one meets them square", () => {
  const r = rect();
  r.cornerRadii = [8, 0, 0, 0];
  const [bl] = r.corners();

  // Round: the arc's nearest approach to the corner point is r(√2 − 1).
  const near = (e: RectEntity) =>
    Math.min(...e.outlinePoints(FINE).map((p) => Math.hypot(p.x - bl.x, p.y - bl.y)));
  expect(near(r)).toBeCloseTo(8 * (Math.SQRT2 - 1), 3);

  // Inverted: the cove is centred ON the corner, so every point of it is
  // exactly r away — that IS the difference between a cove and a fillet.
  r.cornerType = "inverted";
  expect(near(r)).toBeCloseTo(8, 3);
});

test("corner radii follow corners() order — bl, br, tr, tl", () => {
  const r = rect();
  r.cornerRadii = [8, 0, 0, 0];
  const [bl, br, tr, tl] = r.corners();
  const pts = r.outlinePoints(FINE);
  const on = (p: { x: number; y: number }) =>
    pts.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1e-9);

  expect(on(bl)).toBe(false); // rounded away
  expect(on(br)).toBe(true);
  expect(on(tr)).toBe(true);
  expect(on(tl)).toBe(true);
});

test("every corner treatment stays inside the bounding box", () => {
  for (const type of ["round", "inverted", "chamfer"] as const) {
    const r = rect();
    r.cornerRadii = [8, 4, 12, 2];
    r.cornerType = type;
    const b = r.bounds();
    for (const p of r.outlinePoints(FINE)) {
      expect(p.x, type).toBeGreaterThanOrEqual(b.min.x - 1e-9);
      expect(p.x, type).toBeLessThanOrEqual(b.max.x + 1e-9);
      expect(p.y, type).toBeGreaterThanOrEqual(b.min.y - 1e-9);
      expect(p.y, type).toBeLessThanOrEqual(b.max.y + 1e-9);
    }
    // bounds() is unchanged by radii, which is why it needs no seam of its own.
    expect(b.min).toEqual({ x: 10, y: 20 });
    expect(b.max).toEqual({ x: 70, y: 60 });
  }
});

test("flattening honours the tolerance it is given", () => {
  const r = rect();
  r.cornerRadii = [10, 10, 10, 10];
  const coarse = r.outlinePoints(0.5).length;
  const fine = r.outlinePoints(0.005).length;
  expect(fine).toBeGreaterThan(coarse);

  // Chord deviation of the flattened arc must actually be within tolerance:
  // the midpoint of every chord sits no further inside than the sagitta.
  const centre = { x: 20, y: 30 }; // bl arc centre for r=10
  const pts = r.outlinePoints(0.05).filter((p) => p.x < 20 && p.y < 30);
  for (let i = 1; i < pts.length; i++) {
    const m = { x: (pts[i - 1].x + pts[i].x) / 2, y: (pts[i - 1].y + pts[i].y) / 2 };
    expect(10 - Math.hypot(m.x - centre.x, m.y - centre.y)).toBeLessThanOrEqual(0.05 + 1e-9);
  }
});

// --------------------------------------------------------------------------
// Clamping: a radius is kept as asked for, drawn as it fits.

test("two corners sharing an edge cannot overrun it", () => {
  const r = rect();
  r.cornerRadii = [50, 50, 0, 0]; // 100mm of radius on a 60mm edge
  const eff = r.effectiveCornerRadii();
  expect(eff[0] + eff[1]).toBeCloseTo(W, 9);
  expect(eff[0]).toBeCloseTo(30, 9);
  // A corner that shares no edge with the offender is untouched — the clamp is
  // per shared edge, not one global factor applied to the whole shape.
  r.cornerRadii = [50, 0, 5, 0];
  const [c0, , c2] = r.effectiveCornerRadii();
  expect(c0).toBeCloseTo(40, 9); // pulled in by the 40mm left edge it shares with tl
  expect(c2).toBeCloseTo(5, 9); // top-right, on two edges with room to spare
});

test("an over-large radius is clamped for drawing but KEPT, so a resize is reversible", () => {
  const r = rect();
  r.cornerRadii = [8, 8, 8, 8];
  r.p1 = { x: r.p0.x + 6, y: r.p0.y + 6 }; // shrink under the radius
  expect(r.effectiveCornerRadii()[0]).toBeCloseTo(3, 9);
  expect(r.cornerRadii[0]).toBe(8); // the ASKED-FOR value survives

  r.p1 = { x: r.p0.x + W, y: r.p0.y + H }; // grow back
  expect(r.effectiveCornerRadii()[0]).toBeCloseTo(8, 9);
});

test("a degenerate rectangle produces a finite outline", () => {
  const r = new RectEntity({ x: 0, y: 0 }, { x: 0, y: 0 });
  r.cornerRadii = [5, 5, 5, 5];
  expect(r.hasShapedCorners()).toBe(false);
  for (const p of r.outlinePoints()) {
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  }
});

test("negative or non-finite radii are ignored, not drawn", () => {
  const r = rect();
  r.cornerRadii = [-5, Number.NaN, 0, 8];
  expect(r.effectiveCornerRadii()).toEqual([0, 0, 0, 8]);
});

test("fitsCornerRadius refuses what would not fit beside its neighbours", () => {
  const r = rect();
  r.cornerRadii = [0, 25, 0, 0];
  expect(r.fitsCornerRadius(0, 30)).toBe(true); // 30 + 25 > 60? no: 55 fits
  expect(r.fitsCornerRadius(0, 40)).toBe(false); // 40 + 25 = 65 on a 60mm edge
  expect(r.fitsCornerRadius(0, 0)).toBe(true); // square always fits
  // Corner 0's other edge is the 40mm left side, and corner 3 is square there.
  expect(r.fitsCornerRadius(0, 41)).toBe(false);
  expect(r.maxUniformCornerRadius()).toBe(20);
});

// --------------------------------------------------------------------------
// The property nature of it — the point of the whole feature.

test("radii survive duplication", () => {
  const r = rect();
  r.cornerRadii = [1, 2, 3, 4];
  r.cornerType = "chamfer";
  const copy = r.duplicate();
  expect(copy.cornerRadii).toEqual([1, 2, 3, 4]);
  expect(copy.cornerType).toBe("chamfer");
  copy.cornerRadii[0] = 9;
  expect(r.cornerRadii[0]).toBe(1); // copied, not shared
});

test("a shaped rectangle is still hit-tested on its real boundary", () => {
  const r = rect();
  r.cornerRadii = [10, 0, 0, 0];
  const bl = r.corners()[0];
  // The square corner point is now empty space, 10·(√2−1) ≈ 4.14mm from the arc.
  expect(r.distanceTo(bl)).toBeCloseTo(10 * (Math.SQRT2 - 1), 3);
  // …while a point ON the arc is on the entity.
  const onArc = { x: bl.x + 10 - 10 * Math.SQRT1_2, y: bl.y + 10 - 10 * Math.SQRT1_2 };
  expect(r.distanceTo(onArc)).toBeLessThan(1e-9);
  // A square rectangle still measures zero AT the corner (positive control).
  expect(rect().distanceTo(bl)).toBe(0);
});

test("the four NAMED corners stay where they are, whatever shape they are cut", () => {
  // Constraints and dimensions address bl/br/tr/tl. That vocabulary is what
  // makes a filleted rectangle keep its constraints, so a radius must not move
  // the points — only the geometry between them.
  const r = rect();
  const before = r.corners();
  r.cornerRadii = [8, 8, 8, 8];
  r.cornerType = "inverted";
  expect(r.corners()).toEqual(before);
  expect(r.getPoint("bl")).toEqual(before[0]);
  expect(r.snapPoints().find((s) => s.key === "tr")?.pos).toEqual(before[2]);
});

test("a patterned copy carries its corners", () => {
  // Pattern instances are built with duplicate(); a copy that came out square
  // would show up as a row of rectangles where only the first is rounded.
  const r = rect();
  r.cornerRadii = [3, 3, 3, 3];
  r.cornerType = "inverted";
  const copy = r.duplicate();
  copy.translate({ x: 100, y: 0 });
  expect(copy.outlinePoints().length).toBe(r.outlinePoints().length);
  expect(copy.cornerType).toBe("inverted");
});
