/**
 * A circle/arc rim pick for a dimension anchor used to capture whatever exact
 * angle the mouse happened to be at, with zero snapping — even though
 * CircleEntity already exposes its 4 quadrant points as first-class snap
 * points that every DRAW tool snaps to. A real click aimed at "the top of the
 * circle" lands a fraction of a degree off, and since the measured VALUE
 * between the centre and any rim point is always exactly the radius (a clean
 * number regardless of angle), the mismatch reads as a crooked-looking
 * dimension line attached to a perfectly round label — reported directly as
 * "still getting weird looking dimensions", reproduced and diagnosed live.
 *
 * circleEdgePick now snaps to the nearest quadrant when the click is close
 * enough, measured in ARC LENGTH (not raw angle) so the catch radius is the
 * same few screen pixels regardless of the circle's size.
 */
import { test, expect } from "vitest";
import { CircleEntity, ArcEntity } from "../src/model/entities";
import { circleEdgePick } from "../src/tools/dimensionTool";

test("a click within tolerance of the top quadrant snaps exactly to it", () => {
  const c = new CircleEntity({ x: 150, y: 120 }, 40);
  // ~1mm off the true top (150,160) -- an ordinary mouse wobble.
  const pick = circleEdgePick(c, { x: 151, y: 159.9 }, 3.2);
  expect(pick).not.toBeNull();
  expect(pick!.pos.x).toBeCloseTo(150, 6);
  expect(pick!.pos.y).toBeCloseTo(160, 6); // exactly on the circle, not the raw click
  expect(pick!.ref.key).toBe(`edge@${Math.PI / 2}`);
});

test("a click too far from any quadrant keeps the raw angle (still a deliberate off-quadrant pick)", () => {
  const c = new CircleEntity({ x: 150, y: 120 }, 40);
  // 6mm off the top -- more than the tolerance below allows to snap.
  const pick = circleEdgePick(c, { x: 156, y: 159.5 }, 3.2);
  expect(pick).not.toBeNull();
  expect(pick!.ref.key).not.toBe(`edge@${Math.PI / 2}`);
  // Still lands exactly ON the circle at the raw clicked angle.
  const dx = pick!.pos.x - 150;
  const dy = pick!.pos.y - 120;
  expect(Math.hypot(dx, dy)).toBeCloseTo(40, 6);
});

test("snaps to all four quadrants, not just the top", () => {
  const c = new CircleEntity({ x: 0, y: 0 }, 50);
  const cases: [{ x: number; y: number }, number][] = [
    [{ x: 49, y: 2 }, 0], // right
    [{ x: 2, y: 49 }, Math.PI / 2], // top
    [{ x: -49, y: 2 }, Math.PI], // left
    [{ x: 2, y: -49 }, -Math.PI / 2], // bottom
  ];
  for (const [click, expectedAngle] of cases) {
    const pick = circleEdgePick(c, click, 5);
    expect(pick?.ref.key).toBe(`edge@${expectedAngle}`);
  }
});

test("the tolerance is measured in arc length, so it scales with radius", () => {
  // A 1.5 degree miss is ~1.3mm of arc on a 50mm circle, ~13mm on a 500mm one.
  const small = new CircleEntity({ x: 0, y: 0 }, 50);
  const big = new CircleEntity({ x: 0, y: 0 }, 500);
  const angle = Math.PI / 2 - (1.5 * Math.PI) / 180; // 1.5deg short of the top
  const clickOn = (r: number) => ({ x: r * Math.cos(angle), y: r * Math.sin(angle) });

  // 3mm tolerance: catches the small circle's ~1.3mm arc miss...
  expect(circleEdgePick(small, clickOn(50), 3)?.ref.key).toBe(`edge@${Math.PI / 2}`);
  // ...but NOT the big circle's ~13mm arc miss at the same tolerance and angle.
  expect(circleEdgePick(big, clickOn(500), 3)?.ref.key).not.toBe(`edge@${Math.PI / 2}`);
});

test("an arc never snaps to a quadrant outside its own span", () => {
  // A quarter arc from 0 to 90 degrees -- the RIGHT quadrant (0) is valid,
  // the TOP quadrant (90) is exactly at its boundary (endAngle), and every
  // other quadrant (180, -90) is well outside the arc's sweep entirely.
  const a = new ArcEntity({ x: 0, y: 0 }, 40, 0, Math.PI / 2);
  // A click near angle 170deg would be closest to the LEFT quadrant (180) in
  // raw angle terms, but the LEFT quadrant is outside this arc's span, and a
  // raw click at 170deg is ALSO outside the arc -- correctly rejected either way.
  const outside = circleEdgePick(a, { x: 40 * Math.cos((170 * Math.PI) / 180), y: 40 * Math.sin((170 * Math.PI) / 180) }, 5);
  expect(outside).toBeNull();

  // A click near the arc's own valid RIGHT end (angle 0) still snaps cleanly.
  const valid = circleEdgePick(a, { x: 39.8, y: 1.5 }, 5);
  expect(valid?.ref.key).toBe("edge@0");
});

test("nearer the centre than the rim: still rejected, same as before this change", () => {
  const c = new CircleEntity({ x: 0, y: 0 }, 40);
  expect(circleEdgePick(c, { x: 2, y: 2 }, 5)).toBeNull();
});
