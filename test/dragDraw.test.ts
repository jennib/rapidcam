/**
 * Press-drag-release for the two-point drawing tools.
 *
 * The threshold rule is the whole design: below it the gesture is a click and
 * falls through to "arm the second point" (which is also what keeps degenerate
 * near-zero shapes out), above it the release completes the shape. Everything
 * else is deliberately delegated — a drag re-enters the tool's own
 * `onPointerDown`, so snapping, typed dimensions, history and the size guards
 * are the same code the second click has always run.
 */

import { test, expect } from "vitest";
import { DRAG_THRESHOLD_PX, isDragRelease } from "../src/tools/dragDraw";
import type { ToolPointerEvent } from "../src/tools/tool";

/** A pointer event at a screen position; only `screen` matters here. */
function at(x: number, y: number): ToolPointerEvent {
  return {
    world: { x: 0, y: 0 },
    worldRaw: { x: 0, y: 0 },
    screen: { x, y },
    snap: null,
    button: 0,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
  };
}

test("no anchor means no drag — an idle tool cannot be completed by a release", () => {
  expect(isDragRelease(null, at(500, 500))).toBe(false);
});

test("a release in the same place is a click, not a drag", () => {
  expect(isDragRelease({ x: 100, y: 100 }, at(100, 100))).toBe(false);
});

test("a shaky click stays a click", () => {
  // The hand moves a pixel or two between press and release on any real click;
  // reading that as a drag would commit a near-zero-size shape at the press
  // point, which is the failure mode the threshold exists to prevent.
  expect(isDragRelease({ x: 100, y: 100 }, at(101, 100))).toBe(false);
  expect(isDragRelease({ x: 100, y: 100 }, at(100, 102))).toBe(false);
  expect(isDragRelease({ x: 100, y: 100 }, at(102, 102))).toBe(false); // ~2.8px
});

test("a deliberate drag is a drag", () => {
  expect(isDragRelease({ x: 100, y: 100 }, at(160, 140))).toBe(true);
  expect(isDragRelease({ x: 100, y: 100 }, at(40, 100))).toBe(true); // leftwards
  expect(isDragRelease({ x: 100, y: 100 }, at(100, 40))).toBe(true); // upwards
});

test("the threshold is a radius, not a bounding box", () => {
  // Exactly on the threshold in each axis, and just inside it diagonally.
  expect(isDragRelease({ x: 0, y: 0 }, at(DRAG_THRESHOLD_PX, 0))).toBe(true);
  expect(isDragRelease({ x: 0, y: 0 }, at(0, DRAG_THRESHOLD_PX))).toBe(true);
  expect(isDragRelease({ x: 0, y: 0 }, at(DRAG_THRESHOLD_PX - 0.01, 0))).toBe(false);
  // 3,3 is 4.24px away — over the threshold although neither axis reaches it.
  expect(isDragRelease({ x: 0, y: 0 }, at(3, 3))).toBe(true);
  // 2,2 is 2.83px — under it.
  expect(isDragRelease({ x: 0, y: 0 }, at(2, 2))).toBe(false);
});

test("the threshold is small enough to be reachable and large enough to be safe", () => {
  // Guards the constant itself: a value of 0 would make every click a drag, and
  // anything above ~10px would make short drags mysteriously do nothing.
  expect(DRAG_THRESHOLD_PX).toBeGreaterThan(1);
  expect(DRAG_THRESHOLD_PX).toBeLessThanOrEqual(10);
});
