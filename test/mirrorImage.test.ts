import { describe, it, expect } from "vitest";
import { mirrorEntity } from "../src/tools/mirrorTool";
import { RasterImageEntity, TextEntity } from "../src/model/entities";
import type { Vec2 } from "../src/core/vec2";

// The Mirror tool used to silently skip images and text. Images now get a true
// mirrored copy (footprint = reflection of the original's, content flipped);
// text gets a readable copy at the reflected footprint (MIRRTEXT=0).

/** Assert two point sets are equal within tolerance, ignoring order. */
function expectSameCorners(a: Vec2[], b: Vec2[]): void {
  expect(a.length).toBe(b.length);
  for (const p of a) {
    const hit = b.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1e-9);
    expect(hit, `corner (${p.x}, ${p.y}) missing from reflected set`).toBe(true);
  }
}

function reflect(p: Vec2, A: Vec2, B: Vec2): Vec2 {
  const dx = B.x - A.x,
    dy = B.y - A.y;
  const len = Math.hypot(dx, dy);
  const d = { x: dx / len, y: dy / len };
  const v = { x: p.x - A.x, y: p.y - A.y };
  const proj2 = 2 * (v.x * d.x + v.y * d.y);
  return { x: p.x + proj2 * d.x - 2 * v.x, y: p.y + proj2 * d.y - 2 * v.y };
}

describe("mirrorEntity: images", () => {
  it("mirrors an axis-aligned image across a vertical axis", () => {
    const img = new RasterImageEntity("img-1", { x: 10, y: 0 }, 20, 10);
    const m = mirrorEntity(img, { x: 0, y: 0 }, { x: 0, y: 1 }) as RasterImageEntity;
    expect(m).not.toBeNull();
    expectSameCorners(
      m.corners(),
      img.corners().map((c) => reflect(c, { x: 0, y: 0 }, { x: 0, y: 1 })),
    );
    expect(m.flipY).toBe(true); // content mirrored
    expect(m.flipX).toBe(false);
    // Original untouched.
    expect(img.position).toEqual({ x: 10, y: 0 });
    expect(img.flipY).toBe(false);
  });

  it("mirrors a rotated, pre-flipped image across an arbitrary axis", () => {
    const img = new RasterImageEntity("img-2", { x: 3, y: -2 }, 8, 5, 0.4, true, false);
    const A = { x: 5, y: 5 };
    const B = { x: 6, y: 5 + Math.tan(Math.PI / 6) }; // 30° axis
    const m = mirrorEntity(img, A, B) as RasterImageEntity;
    expect(m).not.toBeNull();
    expectSameCorners(
      m.corners(),
      img.corners().map((c) => reflect(c, A, B)),
    );
    expect(m.flipX).toBe(true); // untouched
    expect(m.flipY).toBe(true); // toggled
    expect(m.widthMM).toBe(8);
    expect(m.heightMM).toBe(5);
  });
});

describe("mirrorEntity: text (MIRRTEXT=0)", () => {
  it("copies text readable at the reflected footprint centre", () => {
    const t = new TextEntity("hi", "no-such-font", 10, { x: 5, y: 0 });
    const b = t.bounds();
    const c = { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 };
    const m = mirrorEntity(t, { x: 0, y: 0 }, { x: 0, y: 1 }) as TextEntity;
    expect(m).not.toBeNull();
    expect(m.angle).toBe(0); // stays readable
    expect(m.sizeMM).toBe(10);
    const mb = m.bounds();
    expect((mb.min.x + mb.max.x) / 2).toBeCloseTo(-c.x);
    expect((mb.min.y + mb.max.y) / 2).toBeCloseTo(c.y);
  });
});
