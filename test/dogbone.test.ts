import { test, expect } from "vitest";
import { addDogbones, dogbonePoint } from "../src/cam/dogbone";
import type { Vec2 } from "../src/core/vec2";

// A CCW square wall loop of side 2·s centred at origin. This models the tool
// path of a square pocket, already inset from the walls by the tool radius.
const square = (s: number): Vec2[] => [
  { x: -s, y: -s }, { x: s, y: -s }, { x: s, y: s }, { x: -s, y: s },
];

/** Distance from p to the nearest point of a circle (centre c, radius r). */
const edgeToPoint = (c: Vec2, r: number, p: Vec2): number =>
  Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - r);

test("a square pocket gets exactly one spur per corner", () => {
  const loop = square(10);
  const out = addDogbones(loop, 3);
  // Each of the 4 corners expands from [v] to [v, spur, v]: +2 points each.
  expect(out.length).toBe(loop.length + 4 * 2);
});

test("the dog-bone tool centre sits so the tool edge reaches the true corner", () => {
  // Tool path corner (10,10) is inset by toolR from a 90° part corner; the true
  // corner is toolR·√2 further out along the diagonal.
  const toolR = 3;
  const spur = dogbonePoint({ x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }, toolR)!;
  expect(spur).not.toBeNull();
  const apex = { x: 10 + toolR, y: 10 + toolR }; // real corner of the pocket
  // With the tool centred at the spur point, its edge just touches the apex.
  expect(edgeToPoint(spur, toolR, apex)).toBeLessThan(1e-6);
  // …and the overcut runs outward (past the tool-path corner), not inward.
  expect(spur.x).toBeGreaterThan(10);
  expect(spur.y).toBeGreaterThan(10);
});

test("90° overcut length is toolR·(√2 − 1) from the corner", () => {
  const toolR = 4;
  const v = { x: 10, y: 10 };
  const spur = dogbonePoint({ x: 10, y: -10 }, v, { x: -10, y: 10 }, toolR)!;
  const d = Math.hypot(spur.x - v.x, spur.y - v.y);
  expect(d).toBeCloseTo(toolR * (Math.SQRT2 - 1), 9);
});

test("reflex (concave) corners get no dog-bone", () => {
  // An L-shaped CCW loop has one reflex corner; only its 5 convex corners relieve.
  const L: Vec2[] = [
    { x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 },
    { x: 15, y: 30 }, { x: 15, y: 15 }, { x: 0, y: 15 },
  ];
  let spurs = 0;
  const n = L.length;
  for (let i = 0; i < n; i++) {
    if (dogbonePoint(L[(i - 1 + n) % n], L[i], L[(i + 1) % n], 2)) spurs++;
  }
  expect(spurs).toBe(5); // the inner (reflex) corner at (15,15) is skipped
});

test("straight/collinear vertices produce no spur", () => {
  expect(dogbonePoint({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, 3)).toBeNull();
});

// Build a convex (left-turn on a CCW loop) corner at the origin with a given
// interior angle: incoming edge along +x, outgoing edge rotated left by the
// exterior turn (180° − interior).
const convexCorner = (interiorDeg: number): { p: Vec2; v: Vec2; q: Vec2 } => {
  const turn = Math.PI - (interiorDeg * Math.PI) / 180;
  return {
    p: { x: -10, y: 0 },
    v: { x: 0, y: 0 },
    q: { x: 10 * Math.cos(turn), y: 10 * Math.sin(turn) },
  };
};

test("corners too acute to relieve are skipped", () => {
  const { p, v, q } = convexCorner(10); // below the 20° threshold
  expect(dogbonePoint(p, v, q, 3)).toBeNull();
});

test("acute (but relievable) corners overcut further than right-angle ones", () => {
  const toolR = 3;
  const { p, v, q } = convexCorner(60);
  const spur = dogbonePoint(p, v, q, toolR)!;
  expect(spur).not.toBeNull();
  const d = Math.hypot(spur.x, spur.y);
  // 1/sin(30°) − 1 = 1 → toolR; larger than the 90° case (toolR·0.414).
  expect(d).toBeCloseTo(toolR * (1 / Math.sin(Math.PI / 6) - 1), 9);
  expect(d).toBeGreaterThan(toolR * (Math.SQRT2 - 1));
});

test("winding is normalised — a CW loop relieves the same corners", () => {
  const cw = square(10).slice().reverse(); // clockwise
  const out = addDogbones(cw, 3);
  expect(out.length).toBe(cw.length + 4 * 2);
});

test("zero / negative tool radius is a no-op", () => {
  const loop = square(10);
  expect(addDogbones(loop, 0)).toBe(loop);
  expect(addDogbones(loop, -1)).toBe(loop);
});

test("addDogbones does not mutate its input", () => {
  const loop = square(10);
  const before = JSON.stringify(loop);
  addDogbones(loop, 3);
  expect(JSON.stringify(loop)).toBe(before);
});
