/**
 * G-code run-time estimator tests. Hand-written programs with known geometry so
 * the expected seconds are exact: length ÷ feed for lines, r·sweep ÷ feed for arcs,
 * length ÷ rapid rate for G0, and 1/F for inverse-time (G93) moves. Also covers the
 * modal state the parser must track (feed, motion mode) and that non-motion lines
 * are ignored.
 */

import { test, expect, describe } from "vitest";
import { estimateGCodeTime, formatDuration, DEFAULT_RAPID_RATE } from "../src/cam/timeEstimate";
import { generateGCode } from "../src/cam/gcode";
import { CADDocument } from "../src/model/document";
import { RectEntity } from "../src/model/entities";
import type { CAMOperation } from "../src/cam/types";

describe("estimateGCodeTime", () => {
  test("a linear feed move: length ÷ feed", () => {
    const e = estimateGCodeTime("G1 X100 Y0 F1000"); // 100 mm at 1000 mm/min = 0.1 min
    expect(e.cutSeconds).toBeCloseTo(6, 5);
    expect(e.rapidSeconds).toBe(0);
    expect(e.seconds).toBeCloseTo(6, 5);
  });

  test("a rapid uses the rapid rate, not the feed", () => {
    const e = estimateGCodeTime("G0 X60 Y0"); // 60 mm at 3000 mm/min = 0.02 min
    expect(e.rapidSeconds).toBeCloseTo(1.2, 5);
    expect(e.cutSeconds).toBe(0);
  });

  test("feed and motion mode are modal across lines", () => {
    // Second line restates neither G nor F — it inherits G1 @ 600.
    const e = estimateGCodeTime("G1 X10 F600\nX20");
    expect(e.cutSeconds).toBeCloseTo(2, 5); // two 10 mm moves at 600 = 1 s each
  });

  test("a quarter-circle arc: r·sweep ÷ feed", () => {
    // Start (10,0), G3 to (0,10) about centre (0,0): quarter of r=10 ⇒ 10·(π/2) mm.
    const e = estimateGCodeTime("G0 X10 Y0\nG3 X0 Y10 I-10 J0 F600");
    expect(e.rapidSeconds).toBeCloseTo(10 / DEFAULT_RAPID_RATE * 60, 5); // the G0 X10
    expect(e.cutSeconds).toBeCloseTo(((10 * Math.PI) / 2 / 600) * 60, 5); // ≈ 1.5708 s
  });

  test("a closed arc (start == end) is a full circle", () => {
    const e = estimateGCodeTime("G0 X10 Y0\nG2 X10 Y0 I-10 J0 F600"); // 2π·10 mm
    expect(e.cutSeconds).toBeCloseTo(((2 * Math.PI * 10) / 600) * 60, 5); // ≈ 6.2832 s
  });

  test("a helical arc adds the Z component to the arc length", () => {
    // Full circle r=10 (circumference 2π·10) while descending 5 mm in Z.
    const flat = estimateGCodeTime("G0 X10 Y0\nG2 X10 Y0 I-10 J0 F600");
    const helix = estimateGCodeTime("G0 X10 Y0\nG2 X10 Y0 Z-5 I-10 J0 F600");
    expect(helix.cutSeconds).toBeGreaterThan(flat.cutSeconds);
    const arcXY = 2 * Math.PI * 10;
    expect(helix.cutSeconds).toBeCloseTo((Math.hypot(arcXY, 5) / 600) * 60, 5);
  });

  test("comments, setup, and M/S/T lines contribute no time", () => {
    const g = ["; a comment", "G21 ; metric", "G90", "M3 S1000", "T1", "G1 X10 Y0 F600"].join("\n");
    const e = estimateGCodeTime(g);
    expect(e.cutSeconds).toBeCloseTo(1, 5); // only the 10 mm @ 600 move
    expect(e.rapidSeconds).toBe(0);
  });

  test("G93 inverse-time: a move takes 1/F minutes regardless of length", () => {
    const e = estimateGCodeTime("G93\nG1 X5 A90 F2"); // 1/2 min = 30 s
    expect(e.cutSeconds).toBeCloseTo(30, 5);
  });

  test("empty / whitespace input is zero", () => {
    expect(estimateGCodeTime("").seconds).toBe(0);
    expect(estimateGCodeTime("\n  \n").seconds).toBe(0);
  });

  test("a custom rapid rate scales the rapid time", () => {
    const slow = estimateGCodeTime("G0 X60 Y0", { rapidRate: 1000 });
    expect(slow.rapidSeconds).toBeCloseTo(3.6, 5); // 60 mm at 1000 = 0.06 min
  });
});

describe("generateGCode header", () => {
  const millOp = (entityIds: string[]): CAMOperation => ({
    id: "p1", name: "prof", type: "profile", side: "outside", entityIds,
    toolType: "end-mill", toolNumber: 1, diameter: 6, feedrate: 1000, plungeRate: 300,
    spindleSpeed: 18000, safeZ: 5, depth: -2, stepdown: 2, stepover: 0.4,
  });

  test("a generated program carries a self-consistent estimated-run-time header", () => {
    const doc = new CADDocument({ width: 200, height: 100 });
    const rect = doc.add(new RectEntity({ x: 40, y: 30 }, { x: 160, y: 90 }));
    const g = generateGCode([millOp([rect.id])], doc);

    expect(g).toMatch(/^; Estimated run time: .+ \(cut .+, rapid .+\)$/m);
    // The printed time matches a fresh estimate of the program (the comment is inert).
    const est = estimateGCodeTime(g);
    expect(est.seconds).toBeGreaterThan(0);
    expect(g).toContain(`; Estimated run time: ${formatDuration(est.seconds)} `);
  });

  test("an empty program gets no estimate line", () => {
    const doc = new CADDocument({ width: 100, height: 100 });
    expect(generateGCode([], doc)).not.toMatch(/Estimated run time/);
  });
});

describe("formatDuration", () => {
  test.each([
    [0, "0 s"],
    [-5, "0 s"],
    [6, "6 s"],
    [45, "45 s"],
    [600, "10 min"],
    [3600, "1 h"],
    [5400, "1 h 30 min"],
  ])("%d s → %s", (secs, want) => {
    expect(formatDuration(secs)).toBe(want);
  });
});
