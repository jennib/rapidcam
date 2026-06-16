import { test, expect } from "vitest";
import { contourParallelClear } from "../src/cam/clearing";
import type { Vec2 } from "../src/core/vec2";

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] =>
  [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const circle = (cx: number, cy: number, r: number, n = 48): Vec2[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });

test("simple rectangle pocket yields nested loops, all inside the wall inset", () => {
  const toolR = 3;
  const moves = contourParallelClear(rect(0, 0, 80, 60), [], toolR, 2.4);
  expect(moves.length).toBeGreaterThan(1);
  // every vertex stays within the wall inset [toolR, W-toolR] x [toolR, H-toolR]
  for (const m of moves) for (const p of m.loop) {
    expect(p.x).toBeGreaterThanOrEqual(toolR - 1e-6);
    expect(p.x).toBeLessThanOrEqual(80 - toolR + 1e-6);
    expect(p.y).toBeGreaterThanOrEqual(toolR - 1e-6);
    expect(p.y).toBeLessThanOrEqual(60 - toolR + 1e-6);
  }
});

test("the first loop is always a fresh entry (no link), and many later loops link", () => {
  const moves = contourParallelClear(rect(0, 0, 80, 60), [], 3, 2.4);
  expect(moves[0].link).toBe(false);
  expect(moves.some((m) => m.link)).toBe(true);
});

test("island pocket: no loop point gouges the island (stays >= islandR + toolR from centre)", () => {
  const toolR = 3, islandR = 10, cx = 50, cy = 40;
  const moves = contourParallelClear(rect(10, 10, 90, 70), [circle(cx, cy, islandR)], toolR, 2.4);
  expect(moves.length).toBeGreaterThan(0);
  let minDist = Infinity;
  for (const m of moves) for (const p of m.loop) {
    minDist = Math.min(minDist, Math.hypot(p.x - cx, p.y - cy));
  }
  // small tolerance for arc tessellation of the keep-out
  expect(minDist).toBeGreaterThanOrEqual(islandR + toolR - 0.05);
});

test("pocket smaller than the tool yields no moves", () => {
  expect(contourParallelClear(rect(0, 0, 4, 4), [], 3, 2.4)).toEqual([]);
});

test("every linked move's entry is within toolR of the previous move's end", () => {
  const toolR = 3;
  const moves = contourParallelClear(rect(0, 0, 80, 60), [circle(40, 30, 8)], toolR, 2.4);
  for (let i = 1; i < moves.length; i++) {
    if (!moves[i].link) continue;
    const prevEnd = moves[i - 1].loop[0]; // closed loop returns to start
    const entry = moves[i].loop[0];
    const gap = Math.hypot(prevEnd.x - entry.x, prevEnd.y - entry.y);
    expect(gap).toBeLessThanOrEqual(toolR + 1e-6);
  }
});
