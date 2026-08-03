import { describe, it, expect, vi } from "vitest";
import {
  LineEntity,
  CircleEntity,
  RectEntity,
  PolylineEntity,
  ArcEntity,
} from "../src/model/entities";
import {
  selectionBounds,
  applyScale,
  applyRotate,
  applyFlipH,
  applyFlipV,
} from "../src/core/transform";

describe("transform.ts", () => {
  it("selectionBounds computes correct bounding box", () => {
    const l1 = new LineEntity({ x: 0, y: 0 }, { x: 10, y: 10 });
    const c1 = new CircleEntity({ x: 5, y: 5 }, 2);
    const bounds = selectionBounds([l1, c1]);
    expect(bounds).not.toBeNull();
    expect(bounds!.min.x).toBe(0);
    expect(bounds!.min.y).toBe(0);
    expect(bounds!.max.x).toBe(10);
    expect(bounds!.max.y).toBe(10);
  });

  it("applyScale uniformly scales points around center", () => {
    const rect = new RectEntity({ x: 0, y: 0 }, { x: 10, y: 10 });
    applyScale([rect], 5, 5, 2, 2);
    expect(rect.p0.x).toBe(-5);
    expect(rect.p0.y).toBe(-5);
    expect(rect.p1.x).toBe(15);
    expect(rect.p1.y).toBe(15);
  });

  it("applyScale non-uniformly scales", () => {
    const line = new LineEntity({ x: 0, y: 0 }, { x: 10, y: 10 });
    applyScale([line], 0, 0, 2, 0.5);
    expect(line.a.x).toBe(0);
    expect(line.a.y).toBe(0);
    expect(line.b.x).toBe(20);
    expect(line.b.y).toBe(5);
  });

  /**
   * `applyScale` used to `console.warn` from inside its per-entity loop, once for
   * every circle/arc/text on every call. In an interactive scale drag that is one
   * warning per entity PER POINTER MOVE — 3000 of them from a six-move drag over
   * 500 circles — and it made the gesture ~48× slower than the arithmetic it was
   * guarding. It now reports the same fact once, as a count.
   *
   * The console assertion is the load-bearing one: the behaviour it guards is a
   * performance cliff, so a well-meaning "let's warn about this" would reinstate
   * it invisibly. Every case pairs it with a `uniformOnly` assertion, so the test
   * cannot pass by way of the scale never having been non-uniform.
   */
  it("reports uniform-only entities instead of logging, once per call", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const circles = Array.from(
      { length: 50 },
      (_, i) => new CircleEntity({ x: i * 10, y: 0 }, 4),
    );

    const res = applyScale(circles, 0, 0, 2, 0.5);

    expect(res.uniformOnly).toBe(50); // the non-uniform case really was hit
    expect(warn).not.toHaveBeenCalled();
    // Circles take the uniform (sx) scale on both axes rather than distorting.
    expect(circles[0].radius).toBe(8);
    warn.mockRestore();
  });

  it("counts nothing, and still says nothing, on a uniform scale", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = applyScale([new CircleEntity({ x: 0, y: 0 }, 4)], 0, 0, 2, 2);
    expect(res.uniformOnly).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("counts only the shapes that cannot stretch", () => {
    const circle = new CircleEntity({ x: 0, y: 0 }, 4);
    const line = new LineEntity({ x: 0, y: 0 }, { x: 10, y: 10 });
    const rect = new RectEntity({ x: 0, y: 0 }, { x: 10, y: 10 });
    const res = applyScale([circle, line, rect, new ArcEntity({ x: 0, y: 0 }, 5, 0, 1)], 0, 0, 2, 0.5);
    expect(res.uniformOnly).toBe(2); // the circle and the arc, not the line or rect
    // Positive control: the ones that CAN stretch actually did.
    expect(line.b.x).toBe(20);
    expect(line.b.y).toBe(5);
  });

  it("applyRotate rotates points by 90 degrees CCW", () => {
    const line = new LineEntity({ x: 10, y: 0 }, { x: 10, y: 10 });
    applyRotate([line], 0, 0, Math.PI / 2);
    expect(line.a.x).toBeCloseTo(0);
    expect(line.a.y).toBeCloseTo(10);
    expect(line.b.x).toBeCloseTo(-10);
    expect(line.b.y).toBeCloseTo(10);
  });

  it("applyRotate on RectEntity with arbitrary angle converts to Polyline", () => {
    const rect = new RectEntity({ x: 0, y: 0 }, { x: 10, y: 10 });
    const entities = [rect];
    applyRotate(entities, 5, 5, Math.PI / 4);
    const result = entities[0];
    expect(result).toBeInstanceOf(PolylineEntity);
  });

  it("applyRotate on ArcEntity updates start and end angles", () => {
    const arc = new ArcEntity({ x: 0, y: 0 }, 10, 0, Math.PI / 2);
    applyRotate([arc], 0, 0, Math.PI / 2);
    expect(arc.startAngle).toBeCloseTo(Math.PI / 2);
    expect(arc.endAngle).toBeCloseTo(Math.PI);
  });

  it("applyFlipH negates X around cx", () => {
    const line = new LineEntity({ x: 10, y: 5 }, { x: 15, y: 10 });
    applyFlipH([line], 0);
    expect(line.a.x).toBeCloseTo(-10);
    expect(line.a.y).toBeCloseTo(5);
    expect(line.b.x).toBeCloseTo(-15);
    expect(line.b.y).toBeCloseTo(10);
  });

  it("applyFlipH on ArcEntity swaps and negates angles", () => {
    const arc = new ArcEntity({ x: 0, y: 0 }, 10, 0, Math.PI / 2); // 0 to 90
    applyFlipH([arc], 0);
    // After horizontal flip: newStart = pi - oldEnd, newEnd = pi - oldStart
    // pi - pi/2 = pi/2
    // pi - 0 = pi
    expect(arc.startAngle).toBeCloseTo(Math.PI / 2);
    expect(arc.endAngle).toBeCloseTo(Math.PI);
  });

  it("applyFlipV negates Y around cy", () => {
    const line = new LineEntity({ x: 5, y: 10 }, { x: 10, y: 15 });
    applyFlipV([line], 0);
    expect(line.a.x).toBeCloseTo(5);
    expect(line.a.y).toBeCloseTo(-10);
    expect(line.b.x).toBeCloseTo(10);
    expect(line.b.y).toBeCloseTo(-15);
  });

  it("applyFlipV on ArcEntity swaps and negates angles", () => {
    const arc = new ArcEntity({ x: 0, y: 0 }, 10, Math.PI / 4, (3 * Math.PI) / 4); // 45 to 135
    applyFlipV([arc], 0);
    // After vertical flip: newStart = -oldEnd, newEnd = -oldStart
    // -135 to -45
    expect(arc.startAngle).toBeCloseTo((-3 * Math.PI) / 4);
    expect(arc.endAngle).toBeCloseTo(-Math.PI / 4);
  });
});
