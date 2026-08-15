import { describe, it, expect, vi } from "vitest";
import {
  LineEntity,
  CircleEntity,
  RectEntity,
  PolylineEntity,
  ArcEntity,
} from "../src/model/entities";
import type { Vec2 } from "../src/core/vec2";
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

/**
 * A transform moves a shape; anything indexed BY a part of that shape has to
 * move with it. Two families of that were unhandled, and both failed silently:
 * a polyline's vertex ids were left behind by the winding reversal, and a
 * rectangle's corner treatments were left behind by every transform.
 *
 * These assert the INVARIANT ("the radius is still on the same physical
 * corner", "v1 is still the same physical vertex") rather than an index table,
 * so a permutation that is wrong in a way the table happens to agree with still
 * fails.
 */
describe("transforms carry what is indexed by the shape", () => {
  /** Where the one rounded corner physically is, in world coordinates. */
  const roundedCornerOf = (rect: RectEntity): Vec2 => {
    const i = rect.cornerRadii.findIndex((r) => r > 0);
    expect(i).toBeGreaterThanOrEqual(0); // positive control: a radius survived at all
    return rect.corners()[i];
  };

  it("applyFlipH keeps polyline vertex ids on their own vertices", () => {
    const pl = new PolylineEntity(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      true,
    );
    const before = pl.getPoint("v1"); // (10, 0)
    applyFlipH([pl], 5);
    // v1 must be where v1 went — the mirror of (10,0) is (0,0). Before the fix
    // it landed on (0,10): points reversed, ids did not, so every constraint
    // and dimension on this shape quietly changed which vertex it held.
    expect(pl.getPoint("v1")).toEqual({ x: 10 - before.x, y: before.y });
    expect(pl.points.length).toBe(pl.vertexIds.length);
  });

  it("applyFlipV keeps polyline vertex ids on their own vertices", () => {
    const pl = new PolylineEntity(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 8 },
      ],
      false,
    );
    const before = pl.getPoint("v2");
    applyFlipV([pl], 4);
    expect(pl.getPoint("v2")).toEqual({ x: before.x, y: 8 - before.y });
  });

  it("winding still reverses, so CAM keeps its orientation", () => {
    const pl = new PolylineEntity(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      true,
    );
    const area = (p: PolylineEntity) => {
      let a = 0;
      for (let i = 0; i < p.points.length; i++) {
        const q = p.points[i],
          r = p.points[(i + 1) % p.points.length];
        a += q.x * r.y - r.x * q.y;
      }
      return a / 2;
    };
    const before = area(pl);
    applyFlipH([pl], 0);
    // Mirroring alone would negate the signed area; the reversal puts it back.
    expect(Math.sign(area(pl))).toBe(Math.sign(before));
  });

  it("applyScale scales a rectangle's corner radii with the rectangle", () => {
    const rect = new RectEntity({ x: 0, y: 0 }, { x: 100, y: 100 });
    rect.cornerRadii = [10, 10, 10, 10];
    applyScale([rect], 0, 0, 2, 2);
    expect(rect.width).toBe(200);
    // A 10mm corner on a 100mm side stays a 10% corner on the 200mm side.
    expect(rect.cornerRadii).toEqual([20, 20, 20, 20]);
  });

  it("counts a shaped rectangle as uniform-only, an unshaped one not", () => {
    const shaped = new RectEntity({ x: 0, y: 0 }, { x: 100, y: 100 });
    shaped.cornerRadii = [10, 0, 0, 0];
    const plain = new RectEntity({ x: 0, y: 0 }, { x: 100, y: 100 });
    // A corner is round, never elliptical — it can only take one factor.
    expect(applyScale([shaped], 0, 0, 2, 0.5).uniformOnly).toBe(1);
    expect(applyScale([plain], 0, 0, 2, 0.5).uniformOnly).toBe(0);
  });

  it("applyFlipH moves a rectangle's corner treatment to the mirrored corner", () => {
    const rect = new RectEntity({ x: 0, y: 0 }, { x: 100, y: 50 });
    rect.cornerRadii = [10, 0, 0, 0]; // bottom-left
    const at = roundedCornerOf(rect);
    applyFlipH([rect], 50);
    expect(roundedCornerOf(rect)).toEqual({ x: 100 - at.x, y: at.y });
  });

  it("applyFlipV moves a rectangle's corner treatment to the mirrored corner", () => {
    const rect = new RectEntity({ x: 0, y: 0 }, { x: 100, y: 50 });
    rect.cornerRadii = [0, 0, 10, 0]; // top-right
    const at = roundedCornerOf(rect);
    applyFlipV([rect], 25);
    expect(roundedCornerOf(rect)).toEqual({ x: at.x, y: 50 - at.y });
  });

  it("applyRotate turns a rectangle's corner treatments with the rectangle", () => {
    for (const turns of [1, 2, 3, -1]) {
      const rect = new RectEntity({ x: 0, y: 0 }, { x: 100, y: 50 });
      rect.cornerRadii = [10, 0, 0, 0];
      const at = roundedCornerOf(rect);
      const a = (turns * Math.PI) / 2;
      applyRotate([rect], 50, 25, a);
      const want = {
        x: 50 + (at.x - 50) * Math.cos(a) - (at.y - 25) * Math.sin(a),
        y: 25 + (at.x - 50) * Math.sin(a) + (at.y - 25) * Math.cos(a),
      };
      const got = roundedCornerOf(rect);
      expect(got.x).toBeCloseTo(want.x);
      expect(got.y).toBeCloseTo(want.y);
    }
  });

  it("two flips and four quarter-turns are the identity on corner treatments", () => {
    const radii: [number, number, number, number] = [1, 2, 3, 4];
    const a = new RectEntity({ x: 0, y: 0 }, { x: 100, y: 50 });
    a.cornerRadii = [...radii];
    applyFlipH([a], 50);
    applyFlipH([a], 50);
    expect(a.cornerRadii).toEqual(radii);

    const b = new RectEntity({ x: 0, y: 0 }, { x: 100, y: 50 });
    b.cornerRadii = [...radii];
    for (let i = 0; i < 4; i++) applyRotate([b], 50, 25, Math.PI / 2);
    expect(b.cornerRadii).toEqual(radii);
  });
});
