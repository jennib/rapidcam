import { test, expect } from "vitest";
import { RectEntity, CircleEntity } from "../src/model/entities";
import { collectClosedLoops } from "../src/cam/loops";
import { refAtPoint, resolveRegion, regionAtPoint } from "../src/cam/regions";

function bounds(poly: { x: number; y: number }[]) {
  const xs = poly.map((p) => p.x),
    ys = poly.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
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

test("a hand-authored ref naming only the innermost loop resolves inside an enclosing outline", () => {
  // The AI-field-test shaker door: a panel rect fully inside the door outline.
  // A hand-written ref lists only ["panel"]; the app would have recorded
  // ["door","panel"]. Both must resolve to the same face — the door outline
  // fully contains the panel and must be promoted, not subtracted (subtracting
  // it erased the region entirely: the original bug).
  const door = new RectEntity({ x: 0, y: 0 }, { x: 304.8, y: 762 }, "door");
  const panel = new RectEntity({ x: 57.15, y: 57.15 }, { x: 247.65, y: 704.85 }, "panel");
  const loops = collectClosedLoops([door, panel]);

  const handRef = { containingLoops: [["panel"]] };
  const r = resolveRegion(handRef, loops);
  expect(r).not.toBeNull();
  expect(bounds(r!.outer)).toMatchObject({
    minX: 57.15,
    maxX: 247.65,
    minY: 57.15,
    maxY: 704.85,
  });
  expect(r!.holes).toHaveLength(0);

  // The seed-picked spelling of the same face agrees.
  const picked = refAtPoint({ x: 150, y: 400 }, loops);
  expect(picked!.containingLoops.flat().sort()).toEqual(["door", "panel"]);
  const rPicked = resolveRegion(picked!, loops);
  expect(bounds(rPicked!.outer)).toMatchObject({ minX: 57.15, maxX: 247.65 });

  // An island inside the panel still subtracts (it cuts, not contains).
  const knob = new CircleEntity({ x: 152.4, y: 380 }, 15, "knob");
  const rIsland = resolveRegion(handRef, collectClosedLoops([door, panel, knob]));
  expect(rIsland).not.toBeNull();
  expect(rIsland!.holes).toHaveLength(1);
});

test("a region reference fails (null) when its loop is gone", () => {
  const rect = new RectEntity({ x: 0, y: 0 }, { x: 100, y: 60 }, "rect");
  const ref = refAtPoint({ x: 20, y: 30 }, collectClosedLoops([rect]));
  expect(ref).not.toBeNull();
  // Boundary entity deleted → no loops → unresolved, rather than a wrong cut.
  expect(resolveRegion(ref!, collectClosedLoops([]))).toBeNull();
});
