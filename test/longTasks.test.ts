/**
 * Long-task attribution.
 *
 * The correlation in `attribute` is the only part of core/longTasks.ts with a
 * wrong answer available to it: a `longtask` entry arrives in a later task, with
 * boundaries set by the browser's task queue rather than by the code that
 * blocked, so it never nests exactly inside the `measure` window it belongs to.
 * Getting this wrong misnames the culprit, which is worse than reporting none.
 */

import { expect, test } from "vitest";
import { attribute, longTasks, measure, resetLongTasks } from "../src/core/longTasks";

type W = { label: string; start: number; end: number };

const windows: W[] = [
  { label: "render", start: 0, end: 10 },
  { label: "generator:reprobe:kumiko-asanoha", start: 20, end: 300 },
  { label: "cam:estimate:profile-inside:1236", start: 310, end: 340 },
];

test("attributes a block to the window it overlaps most", () => {
  // A task the browser reports as 15..305 — starting before the build call and
  // ending after it, which is the normal shape.
  expect(attribute(15, 305, windows)).toBe("generator:reprobe:kumiko-asanoha");
});

test("overlap wins over containment", () => {
  // Wholly inside `render`'s window but overlapping the reprobe far longer.
  expect(attribute(5, 290, windows)).toBe("generator:reprobe:kumiko-asanoha");
});

test("a block touching no window is unattributed", () => {
  expect(attribute(400, 900, windows)).toBe("unattributed");
  // Positive control: the same call DOES name a window when one overlaps, so the
  // assertion above is failing for the intended reason and not because
  // `attribute` returns "unattributed" for everything.
  expect(attribute(400, 900, [{ label: "solve", start: 500, end: 600 }])).toBe("solve");
});

test("zero-length overlap does not count as attribution", () => {
  // Abutting exactly: `render` ends at 10, the task starts at 10.
  expect(attribute(10, 15, windows)).toBe("unattributed");
});

test("measure returns the callee's value and records nothing when fast", () => {
  resetLongTasks();
  expect(measure("fast", () => 6 * 7)).toBe(42);
  expect(longTasks()).toEqual([]);
});

test("measure rethrows, so wrapping a call cannot change what it does", () => {
  resetLongTasks();
  expect(() =>
    measure("throws", () => {
      throw new Error("boom");
    }),
  ).toThrow("boom");
  // The window must still have closed despite the throw — otherwise a throwing
  // path would leave a stale window that misattributes the NEXT long task.
  expect(attribute(0, Number.MAX_SAFE_INTEGER)).toBe("throws");
});
