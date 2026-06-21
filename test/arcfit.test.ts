import { describe, it, expect } from "vitest";
import { fitArcs } from "../src/cam/arcfit";
import type { Vec2 } from "../src/core/vec2";

// Sample an arc: center c, radius r, from a0 to a1 over `nSeg` segments (nSeg+1 pts).
function sampleArc(cx: number, cy: number, r: number, a0: number, a1: number, nSeg: number): Vec2[] {
  return Array.from({ length: nSeg + 1 }, (_, k) => {
    const t = a0 + (a1 - a0) * (k / nSeg);
    return { x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) };
  });
}

describe("fitArcs", () => {
  it("fits a single arc to a sampled quarter circle (CCW = G3)", () => {
    const pts = sampleArc(0, 0, 20, 0, Math.PI / 2, 40);
    const moves = fitArcs(pts);
    expect(moves.length).toBe(1);
    expect(moves[0].kind).toBe("arc");
    if (moves[0].kind !== "arc") return;
    expect(moves[0].cx).toBeCloseTo(0, 3);
    expect(moves[0].cy).toBeCloseTo(0, 3);
    expect(moves[0].cw).toBe(false); // counter-clockwise
    expect(moves[0].to.x).toBeCloseTo(0, 3);
    expect(moves[0].to.y).toBeCloseTo(20, 3);
  });

  it("marks a clockwise arc as G2", () => {
    const pts = sampleArc(0, 0, 15, Math.PI / 2, 0, 40); // 90° -> 0°, clockwise
    const moves = fitArcs(pts);
    expect(moves.every((m) => m.kind === "arc")).toBe(true);
    expect(moves[0].kind === "arc" && moves[0].cw).toBe(true);
  });

  it("keeps a square as straight lines (corners on a circumcircle must NOT fit)", () => {
    const sq: Vec2[] = [
      { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }, { x: 0, y: 0 },
    ];
    const moves = fitArcs(sq);
    expect(moves.every((m) => m.kind === "line")).toBe(true);
    expect(moves.length).toBe(4);
  });

  it("splits a full circle into several arcs (capped under a half turn), no lines", () => {
    const circle = sampleArc(5, 5, 12, 0, 2 * Math.PI, 240);
    const moves = fitArcs(circle);
    expect(moves.every((m) => m.kind === "arc")).toBe(true);
    expect(moves.length).toBeGreaterThanOrEqual(3); // 360° / 150° cap -> >= 3
    for (const m of moves) {
      if (m.kind !== "arc") continue;
      expect(m.cx).toBeCloseTo(5, 2);
      expect(m.cy).toBeCloseTo(5, 2);
    }
  });

  it("handles a stadium (straight sides + semicircular ends) as a mix", () => {
    // Two straight runs joined by two 180°-ish ends; build explicitly.
    const right = sampleArc(30, 0, 10, -Math.PI / 2, Math.PI / 2, 60); // right semicircle (up)
    const left = sampleArc(0, 0, 10, Math.PI / 2, (3 * Math.PI) / 2, 60); // left semicircle (down)
    // top edge from right end (30,10) back to left start (0,10) and bottom likewise
    const pts: Vec2[] = [
      ...right,
      { x: 0, y: 10 },          // straight top to left arc start
      ...left,
      { x: 30, y: -10 },        // straight bottom back to right arc start
    ];
    const moves = fitArcs(pts);
    const arcs = moves.filter((m) => m.kind === "arc").length;
    const lines = moves.filter((m) => m.kind === "line").length;
    expect(arcs).toBeGreaterThan(0);
    expect(lines).toBeGreaterThan(0);
  });

  it("chains: following the moves from path[0] retraces the input endpoints", () => {
    const pts = sampleArc(0, 0, 20, 0, Math.PI / 2, 40);
    const moves = fitArcs(pts);
    // The last move's endpoint is the input's last point.
    const last = moves[moves.length - 1];
    expect(last.to.x).toBeCloseTo(pts[pts.length - 1].x, 6);
    expect(last.to.y).toBeCloseTo(pts[pts.length - 1].y, 6);
  });
});
