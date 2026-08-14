import { expect, test } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity, PolylineEntity, RectEntity } from "../src/model/entities";
import { findCorner, refreshCorner, shapeCorners } from "../src/tools/corner";

/**
 * Rounding every corner of a shape in one action.
 *
 * AutoCAD's `FILLET → Polyline` and Illustrator's corner widgets both do the
 * whole shape at once; rounding a rectangle one corner at a time was the
 * reported friction.
 *
 * The order is the load-bearing part. Each fillet replaces one corner with
 * several vertices, so every index ABOVE it shifts. Walking highest-first means
 * the corners still to come are all below the splice and keep their indices —
 * walking lowest-first would aim later fillets at the middle of the arc it just
 * inserted. These pin the order and the re-read that survives the rect →
 * polyline swap.
 */

function rectDoc() {
  const doc = new CADDocument({ width: 300, height: 200 }, "mm");
  const rect = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 60, y: 40 })) as RectEntity;
  return { doc, rect };
}

test("a rect offers its four corners, highest index first", () => {
  const { doc } = rectDoc();
  const corner = findCorner({ x: 0, y: 0 }, doc, 1)!;
  const all = shapeCorners(corner, doc);

  expect(all).toHaveLength(4);
  expect(all.map((c) => (c.kind === "rect" ? c.index : -1))).toEqual([3, 2, 1, 0]);
});

test("a closed polyline offers every vertex, highest first", () => {
  const doc = new CADDocument({ width: 300, height: 200 }, "mm");
  const pl = doc.add(
    new PolylineEntity(
      [
        { x: 0, y: 0 },
        { x: 50, y: 0 },
        { x: 50, y: 30 },
        { x: 0, y: 30 },
      ],
      true,
    ),
  ) as PolylineEntity;
  const corner = findCorner({ x: 0, y: 0 }, doc, 1)!;
  const all = shapeCorners(corner, doc);

  expect(all.map((c) => (c.kind === "poly" ? c.index : -1))).toEqual([3, 2, 1, 0]);
  expect(pl.points).toHaveLength(4);
});

test("an OPEN polyline's two ends are not corners", () => {
  const doc = new CADDocument({ width: 300, height: 200 }, "mm");
  doc.add(
    new PolylineEntity(
      [
        { x: 0, y: 0 },
        { x: 30, y: 20 },
        { x: 60, y: 0 },
      ],
      false,
    ),
  );
  const corner = findCorner({ x: 30, y: 20 }, doc, 1)!;
  const all = shapeCorners(corner, doc);

  // Only the middle vertex has geometry on both sides.
  expect(all.map((c) => (c.kind === "poly" ? c.index : -1))).toEqual([1]);
});

test("a line-line corner has no enclosing shape, so it yields only itself", () => {
  const doc = new CADDocument({ width: 300, height: 200 }, "mm");
  doc.add(new LineEntity({ x: 0, y: 0 }, { x: 40, y: 0 }));
  doc.add(new LineEntity({ x: 40, y: 0 }, { x: 40, y: 30 }));
  const corner = findCorner({ x: 40, y: 0 }, doc, 1)!;
  expect(corner.kind).toBe("line");
  expect(shapeCorners(corner, doc)).toHaveLength(1);
});

test("refreshCorner survives the rect turning into a polyline mid-walk", () => {
  const { doc, rect } = rectDoc();
  const corner = findCorner({ x: 0, y: 0 }, doc, 1)!;
  if (corner.kind !== "rect") throw new Error("expected a rect corner");

  // Stand in for the first fillet: replace the rect with a polyline of the same
  // id, exactly as spliceCornerVertices does.
  const pl = new PolylineEntity(rect.corners().map((p) => ({ ...p })), true);
  (pl as { id: string }).id = rect.id;
  doc.entities[doc.entities.findIndex((e) => e.id === rect.id)] = pl;

  // The descriptor still names the dead RectEntity object; refreshing must find
  // the live polyline by id rather than returning null.
  const live = refreshCorner(corner, doc);
  expect(live).not.toBeNull();
  expect(live?.kind).toBe("poly");
  expect(live?.pos).toEqual({ x: 0, y: 0 });
});

test("refreshCorner returns null once an index no longer exists", () => {
  const doc = new CADDocument({ width: 300, height: 200 }, "mm");
  const pl = doc.add(
    new PolylineEntity(
      [
        { x: 0, y: 0 },
        { x: 50, y: 0 },
        { x: 50, y: 30 },
      ],
      true,
    ),
  ) as PolylineEntity;
  const corner = findCorner({ x: 50, y: 30 }, doc, 1)!;
  if (corner.kind !== "poly") throw new Error("expected a poly corner");

  pl.spliceVertices(2, 1); // remove the vertex the descriptor names
  expect(refreshCorner(corner, doc)).toBeNull();
  // Positive control: an index that still exists still resolves, so the null
  // above is about the missing vertex and not a broken lookup.
  expect(refreshCorner({ ...corner, index: 0 }, doc)).not.toBeNull();
});
