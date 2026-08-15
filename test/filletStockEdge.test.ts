import { expect, test } from "vitest";
import { CADDocument, STOCK_ENTITY_ID } from "../src/model/document";
import { PolylineEntity, RectEntity } from "../src/model/entities";
import { makeConstraint, SEGMENT_SEP } from "../src/model/constraints";
import { findCorner, setRectCorner, spliceCornerVertices } from "../src/tools/corner";

/**
 * Filleting a rectangle that other things are constrained to.
 *
 * Reported as "fillet fails when a corner coincides with the stock boundary".
 * Corner PICKING was innocent — `findCorner` only walks `doc.entities` and never
 * sees the stock. The damage was downstream: a rectangle was REPLACED by a
 * polyline, which cost it every constraint naming it (#53 kept the id and
 * remapped the keys, but the filleted corner's own references still had nowhere
 * to go — one corner became forty-nine vertices).
 *
 * The conversion is gone. A rectangle corner is a radius on the entity, so
 * there is nothing to carry across and nothing to drop: these assert the
 * stronger property that replaced the guard. The bug class is retired rather
 * than watched.
 */

function docWithRect() {
  const doc = new CADDocument({ width: 300, height: 200 }, "mm");
  doc.stockRect = { x: 0, y: 0, width: 200, height: 100 };
  const rect = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 60, y: 40 })) as RectEntity;
  return { doc, rect };
}

/** The stock-edge pin the snap creates when you draw a corner onto the blank. */
function pinToStock(doc: CADDocument, entityId: string, key: string) {
  doc.addConstraint(
    makeConstraint("pointOnLine", {
      points: [{ entityId, key }],
      entities: [`${STOCK_ENTITY_ID}${SEGMENT_SEP}mid_b`],
    }),
  );
}

/** Round the bottom-left corner (index 0) through the shared corner code. */
function filletBL(doc: CADDocument, r = 5): boolean {
  const corner = findCorner({ x: 0, y: 0 }, doc, 1);
  if (corner?.kind !== "rect") throw new Error("expected a rect corner");
  return setRectCorner(corner, r, "round");
}

test("the corner is found even when it sits on the stock boundary", () => {
  const { doc } = docWithRect();
  const corner = findCorner({ x: 0, y: 0 }, doc, 1);
  expect(corner?.kind).toBe("rect");
});

test("the rectangle stays a rectangle, under its own id", () => {
  const { doc, rect } = docWithRect();
  const idBefore = rect.id;
  expect(filletBL(doc)).toBe(true);

  const after = doc.entities.find((e) => e.id === idBefore);
  expect(after).toBeInstanceOf(RectEntity);
  expect(doc.entities.some((e) => e instanceof PolylineEntity)).toBe(false);
});

test("a constraint on an untouched corner survives, on the SAME key", () => {
  const { doc, rect } = docWithRect();
  pinToStock(doc, rect.id, "tr");
  filletBL(doc);

  expect(doc.constraints).toHaveLength(1);
  const ref = doc.constraints[0].points[0];
  expect(ref.entityId).toBe(rect.id);
  expect(ref.key).toBe("tr"); // no remapping needed — nothing was replaced
  expect(rect.getPoint("tr")).toEqual({ x: 60, y: 40 });
});

test("a constraint on the FILLETED corner survives too — the old unavoidable loss", () => {
  // This is the case #53 could only report, not save: the corner became several
  // vertices, so there was no single successor. As a radius, the corner point is
  // still there and still addressable; only the geometry between it and its
  // neighbours changed.
  const { doc, rect } = docWithRect();
  pinToStock(doc, rect.id, "bl");
  filletBL(doc);

  expect(doc.constraints).toHaveLength(1);
  expect(doc.constraints[0].points[0].key).toBe("bl");
  expect(rect.getPoint("bl")).toEqual({ x: 0, y: 0 });
  // The corner is genuinely rounded, so this is not "nothing happened".
  expect(rect.outlinePoints()).not.toContainEqual({ x: 0, y: 0 });
});

test("an edge reference survives unchanged", () => {
  const { doc, rect } = docWithRect();
  doc.addConstraint(
    makeConstraint("pointOnLine", {
      points: [{ entityId: STOCK_ENTITY_ID, key: "bl" }],
      entities: [`${rect.id}${SEGMENT_SEP}mid_r`],
    }),
  );
  filletBL(doc);

  expect(doc.constraints).toHaveLength(1);
  expect(doc.constraints[0].entities[0]).toBe(`${rect.id}${SEGMENT_SEP}mid_r`);
});

test("a dimension anchored to a filleted corner keeps measuring it", () => {
  const { doc, rect } = docWithRect();
  const before = rect.getPoint("bl");
  filletBL(doc, 12);
  // The named corners are the dimension vocabulary; a radius must not move them.
  expect(rect.getPoint("bl")).toEqual(before);
  expect(rect.width).toBe(60);
  expect(rect.height).toBe(40);
});

test("a polyline corner is still spliced in place and loses nothing", () => {
  // Polylines keep the splice path — they are a vertex list, so a corner really
  // is cut into them. Their stable vertex ids are what carries the references.
  const { doc } = docWithRect();
  const pl = doc.add(
    new PolylineEntity(
      [
        { x: 100, y: 0 },
        { x: 160, y: 0 },
        { x: 160, y: 40 },
        { x: 100, y: 40 },
      ],
      true,
    ),
  ) as PolylineEntity;
  pinToStock(doc, pl.id, `v${pl.vertexIds[2]}`);

  const c = findCorner({ x: 100, y: 0 }, doc, 1);
  if (c?.kind !== "poly") throw new Error("expected a poly corner");
  spliceCornerVertices(c, [
    { x: 105, y: 0 },
    { x: 100, y: 5 },
  ]);

  expect(doc.constraints).toHaveLength(1);
  expect(pl.points).toHaveLength(5);
});
