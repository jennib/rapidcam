/**
 * Extend geometry: a line or arc grows from the clicked end to the nearest
 * entity ahead of it.
 */

import { describe, it, expect } from "vitest";
import { lineExtension, arcExtension } from "../src/tools/extend";
import { LineEntity, ArcEntity, CircleEntity } from "../src/model/entities";

describe("lineExtension", () => {
  it("extends the near endpoint forward to a perpendicular wall", () => {
    const line = new LineEntity({ x: 0, y: 0 }, { x: 10, y: 0 });
    const wall = new LineEntity({ x: 20, y: -5 }, { x: 20, y: 5 });
    const ext = lineExtension(line, { x: 10, y: 0 }, [wall]); // click near b
    expect(ext).not.toBeNull();
    expect(ext!.end).toBe("b");
    expect(ext!.target.x).toBeCloseTo(20);
    expect(ext!.target.y).toBeCloseTo(0);
  });

  it("extends the other endpoint backward when clicked near it", () => {
    const line = new LineEntity({ x: 10, y: 0 }, { x: 20, y: 0 });
    const wall = new LineEntity({ x: 0, y: -5 }, { x: 0, y: 5 });
    const ext = lineExtension(line, { x: 10, y: 0 }, [wall]); // click near a
    expect(ext!.end).toBe("a");
    expect(ext!.target.x).toBeCloseTo(0);
  });

  it("stops at the nearest wall when several lie ahead", () => {
    const line = new LineEntity({ x: 0, y: 0 }, { x: 5, y: 0 });
    const near = new LineEntity({ x: 12, y: -5 }, { x: 12, y: 5 });
    const far = new LineEntity({ x: 30, y: -5 }, { x: 30, y: 5 });
    const ext = lineExtension(line, { x: 5, y: 0 }, [far, near]);
    expect(ext!.target.x).toBeCloseTo(12);
  });

  it("extends to the first crossing of a circle", () => {
    const line = new LineEntity({ x: 0, y: 0 }, { x: 5, y: 0 });
    const circle = new CircleEntity({ x: 20, y: 0 }, 5); // crossings at x=15 and x=25
    const ext = lineExtension(line, { x: 5, y: 0 }, [circle]);
    expect(ext!.target.x).toBeCloseTo(15);
  });

  it("returns null when nothing lies ahead", () => {
    const line = new LineEntity({ x: 0, y: 0 }, { x: 10, y: 0 });
    const behind = new LineEntity({ x: -5, y: -5 }, { x: -5, y: 5 });
    expect(lineExtension(line, { x: 10, y: 0 }, [behind])).toBeNull();
  });
});

describe("arcExtension", () => {
  it("extends the end CCW to the first crossing", () => {
    // Quarter arc 0 → π/2 on a circle of radius 10 at the origin.
    const arc = new ArcEntity({ x: 0, y: 0 }, 10, 0, Math.PI / 2);
    // Vertical wall at x = -6 crosses the circle at (-6, ±8).
    const wall = new LineEntity({ x: -6, y: -12 }, { x: -6, y: 12 });
    const endPt = { x: 0, y: 10 }; // arc end
    const ext = arcExtension(arc, endPt, [wall]);
    expect(ext!.end).toBe("end");
    expect(ext!.angle).toBeCloseTo(Math.atan2(8, -6));
  });

  it("extends the start CW when clicked near the start", () => {
    const arc = new ArcEntity({ x: 0, y: 0 }, 10, 0, Math.PI / 2);
    // Horizontal wall at y = -6 crosses the circle at (±8, -6).
    const wall = new LineEntity({ x: -12, y: -6 }, { x: 12, y: -6 });
    const startPt = { x: 10, y: 0 }; // arc start (angle 0)
    const ext = arcExtension(arc, startPt, [wall]);
    expect(ext!.end).toBe("start");
    // Sweeping CW from 0, the first crossing is (8, -6).
    expect(ext!.angle).toBeCloseTo(Math.atan2(-6, 8));
  });
});
