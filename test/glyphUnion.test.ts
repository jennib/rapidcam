import { expect, test } from "vitest";
import { signedArea, unionPolygons } from "../src/cam/offset";

/**
 * Glyph sub-path merging.
 *
 * A modern font builds a glyph from several OVERLAPPING sub-paths — Inter's 'e'
 * is the reported case. opentype hands them over as-is, and before this they
 * went out as separate contours, so the overlap seams were cut as real strokes:
 * stray lines through the counter of an 'e'.
 *
 * NonZero is the load-bearing choice, not merely a tidy one. A font winds a
 * counter opposite to its outer contour, so the same rule that fuses two
 * overlapping same-wound sub-paths must also leave the hole open. EvenOdd would
 * turn every genuine self-overlap into a hole — the artefact, not the fix.
 *
 * Expected areas below were measured, not assumed.
 */

const sq = (x: number, y: number, w: number) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + w },
  { x, y: y + w },
];
/** Reverse winding — how a font draws a counter against its outer contour. */
const counter = (x: number, y: number, w: number) => [...sq(x, y, w)].reverse();

test("overlapping same-wound sub-paths fuse into one contour", () => {
  const r = unionPolygons([sq(0, 0, 10), sq(5, 0, 10)]);
  expect(r).toHaveLength(1);
  // 150, the union — NOT 200, which is what emitting both separately gives and
  // what put a seam down the middle of the glyph.
  expect(signedArea(r[0])).toBeCloseTo(150, 6);
});

test("a counter survives the union as a hole", () => {
  const r = unionPolygons([sq(0, 0, 10), counter(3, 3, 4)]);
  expect(r).toHaveLength(2);
  const areas = r.map(signedArea).sort((a, b) => b - a);
  expect(areas[0]).toBeCloseTo(100, 6);
  // Negative: opposite winding, i.e. still a hole. An EvenOdd union or a naive
  // "merge everything" would lose this and engrave a solid blob.
  expect(areas[1]).toBeCloseTo(-16, 6);
});

test("the 'e' case: two overlapping strokes plus a counter", () => {
  const r = unionPolygons([sq(0, 0, 10), sq(5, 0, 10), counter(3, 3, 4)]);
  expect(r).toHaveLength(2);
  const areas = r.map(signedArea).sort((a, b) => b - a);
  expect(areas[0]).toBeCloseTo(150, 6);
  // The counter spans x 3..7 but the second stroke covers x 5..15 and is solid,
  // so NonZero leaves only x 3..5 open: 2 x 4 = 8. Getting this wrong in either
  // direction is a visibly wrong glyph.
  expect(areas[1]).toBeCloseTo(-8, 6);
});

test("degenerate input yields nothing rather than throwing", () => {
  expect(unionPolygons([])).toEqual([]);
  expect(unionPolygons([[{ x: 0, y: 0 }, { x: 1, y: 1 }]])).toEqual([]);
  // Positive control: a real polygon through the same call still comes back, so
  // the emptiness above is about the input and not a broken wrapper.
  expect(unionPolygons([sq(0, 0, 4)])).toHaveLength(1);
});
