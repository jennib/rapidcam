import { test, expect } from "vitest";
import { registrationEvents } from "../src/cam/registration";
import type { GMoveEvent } from "../src/cam/gcodeMotion";

const F = [{ x: 10, y: 20 }];
const opts = (mode: "none" | "holes" | "crosshairs" | "both") =>
  ({ mode, safeZ: 5, holeDepth: 3, crosshairDepth: 0.5, crosshairSize: 4 });

const moves = (evs: ReturnType<typeof registrationEvents>) =>
  evs.filter((e): e is GMoveEvent => e.kind === "move");

test("none (or no features) emits nothing", () => {
  expect(registrationEvents(F, opts("none"))).toEqual([]);
  expect(registrationEvents([], opts("holes"))).toEqual([]);
});

test("a hole is a rapid-over, plunge, retract at the feature", () => {
  const evs = registrationEvents(F, opts("holes"));
  expect(evs[0]).toMatchObject({ kind: "raw" }); // labelled section
  const ms = moves(evs);
  expect(ms).toHaveLength(4);
  const plunge = ms.find((m) => m.motion === 1)!;
  expect(plunge).toMatchObject({ hasZ: true, z: -3 }); // to hole depth
  expect(ms.some((m) => m.motion === 0 && m.x === 10 && m.y === 20)).toBe(true);
});

test("a crosshair scribes two centred lines", () => {
  const ms = moves(registrationEvents(F, opts("crosshairs")));
  // two feed passes, each x/y-centred on the feature and spanning ±size
  const feeds = ms.filter((m) => m.motion === 1 && (m.hasX || m.hasY) && m.f !== undefined);
  expect(feeds).toHaveLength(2);
  expect(ms.some((m) => m.motion === 1 && m.hasX && Math.abs(m.x - 14) < 1e-9)).toBe(true); // 10 + size(4)
  expect(ms.some((m) => m.motion === 1 && m.hasY && Math.abs(m.y - 24) < 1e-9)).toBe(true); // 20 + size(4)
});

test("both combines a hole and a crosshair per feature", () => {
  expect(moves(registrationEvents(F, opts("both")))).toHaveLength(4 + 9);
});
