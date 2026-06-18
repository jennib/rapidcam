import { test, expect } from "vitest";
import { RectEntity, CircleEntity } from "../src/model/entities";
import { collectClosedLoops } from "../src/cam/loops";
import { refAtPoint, resolveRegion, regionAtPoint } from "../src/cam/regions";

function bounds(poly: { x: number; y: number }[]) {
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

test("a pocket region reference follows geometry through a reflow", () => {
  // A plate (rect) with a circular island — a pocket-with-island.
  const rect = new RectEntity({ x: 0, y: 0 }, { x: 100, y: 60 }, "rect");
  const hole = new CircleEntity({ x: 50, y: 30 }, 10, "hole");

  const loops1 = collectClosedLoops([rect, hole]);
  // Capture the region from a click inside the plate but outside the island.
  const ref = refAtPoint({ x: 20, y: 30 }, loops1);
  expect(ref).not.toBeNull();
  expect(ref!.containingLoops).toEqual([["rect"]]); // the face is inside only the plate

  const r1 = resolveRegion(ref!, loops1);
  expect(r1).not.toBeNull();
  expect(bounds(r1!.outer)).toMatchObject({ minX: 0, maxX: 100, minY: 0, maxY: 60 });
  expect(r1!.holes).toHaveLength(1); // the island is carved out

  // --- reflow: plate and island move far away (a driving-dimension / origin
  //     change). The original pick point (20,30) is now outside everything.
  rect.p0 = { x: 200, y: 200 };
  rect.p1 = { x: 300, y: 260 };
  hole.center = { x: 250, y: 230 };
  const loops2 = collectClosedLoops([rect, hole]);

  // A frozen absolute seed would now miss entirely — the old bug.
  expect(regionAtPoint({ x: 20, y: 30 }, loops2)).toBeNull();

  // The parametric reference still resolves, and the region tracked the geometry.
  const r2 = resolveRegion(ref!, loops2);
  expect(r2).not.toBeNull();
  expect(bounds(r2!.outer)).toMatchObject({ minX: 200, maxX: 300, minY: 200, maxY: 260 });
  expect(r2!.holes).toHaveLength(1);
});

test("a region reference fails (null) when its loop is gone", () => {
  const rect = new RectEntity({ x: 0, y: 0 }, { x: 100, y: 60 }, "rect");
  const ref = refAtPoint({ x: 20, y: 30 }, collectClosedLoops([rect]));
  expect(ref).not.toBeNull();
  // Boundary entity deleted → no loops → unresolved, rather than a wrong cut.
  expect(resolveRegion(ref!, collectClosedLoops([]))).toBeNull();
});
