/**
 * G-code → toolpath geometry (backplot) tests. Confirms G0 vs G1/2/3 are tagged
 * rapid/cut, connected same-kind moves merge into one polyline, arcs tessellate
 * onto their true circle, and the XY bounds cover the motion.
 */

import { test, expect, describe } from "vitest";
import { parseGcodePath } from "../src/cam/gcodePath";

describe("parseGcodePath", () => {
  test("tags rapids vs cuts and reports bounds", () => {
    const { segments, bounds } = parseGcodePath("G0 X10 Y0\nG1 X20 Y5 F600");
    expect(segments).toHaveLength(2);
    expect(segments[0].rapid).toBe(true);
    expect(segments[0].pts).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    expect(segments[1].rapid).toBe(false);
    expect(segments[1].pts).toEqual([{ x: 10, y: 0 }, { x: 20, y: 5 }]);
    expect(bounds).toEqual({ min: { x: 0, y: 0 }, max: { x: 20, y: 5 } });
  });

  test("consecutive same-kind moves merge into one polyline (modal motion)", () => {
    // Three G1 moves (the 2nd/3rd inherit G1) trace one connected cut path.
    const { segments } = parseGcodePath("G1 X10 Y0 F600\nX10 Y10\nX0 Y10");
    expect(segments).toHaveLength(1);
    expect(segments[0].rapid).toBe(false);
    expect(segments[0].pts).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
  });

  test("an arc tessellates onto its true circle and ends exactly at the endpoint", () => {
    const { segments } = parseGcodePath("G0 X10 Y0\nG3 X0 Y10 I-10 J0 F600"); // quarter, r=10, centre (0,0)
    const cut = segments[1];
    expect(cut.rapid).toBe(false);
    for (const p of cut.pts) expect(Math.hypot(p.x, p.y)).toBeCloseTo(10, 3); // on r=10
    expect(cut.pts.length).toBeGreaterThan(4); // actually tessellated, not one chord
    expect(cut.pts.at(-1)).toEqual({ x: 0, y: 10 }); // exact endpoint
  });

  test("a full circle spans the whole diameter in bounds", () => {
    const { bounds } = parseGcodePath("G0 X10 Y0\nG2 X10 Y0 I-10 J0 F600");
    expect(bounds!.min.x).toBeCloseTo(-10, 2);
    expect(bounds!.max.x).toBeCloseTo(10, 2);
    expect(bounds!.min.y).toBeCloseTo(-10, 2);
    expect(bounds!.max.y).toBeCloseTo(10, 2);
  });

  test("no motion → no segments, null bounds", () => {
    const { segments, bounds } = parseGcodePath("; comment\nG21\nG90\nM3 S1000");
    expect(segments).toHaveLength(0);
    expect(bounds).toBeNull();
  });
});
