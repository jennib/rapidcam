import { expect, test } from "vitest";
import { CADDocument, STOCK_ENTITY_ID } from "../src/model/document";
import { PolylineEntity, RectEntity } from "../src/model/entities";
import { makeConstraint } from "../src/model/constraints";
import { findCorner, spliceCornerVertices } from "../src/tools/corner";

/**
 * Filleting a rectangle that other things are constrained to.
 *
 * Reported as "fillet fails when a corner coincides with the stock boundary".
 * Corner PICKING was innocent — `findCorner` only walks `doc.entities` and never
 * sees the stock. The damage was downstream: a `RectEntity` has four corners, not
 * a vertex list, so it cannot be spliced. The old code built a replacement
 * polyline, `doc.remove()`d the rect and `doc.add()`ed the polyline under a NEW
 * id — and `remove()` calls `pruneReferences()`, so every constraint naming the
 * rect was silently deleted. Pin a rectangle to the blank, round one corner, and
 * the pin was simply gone with nothing said.
 *
 * The rect is now swapped in place, keeping its id, and point keys are remapped
 * (`"bl"` means nothing on a polyline, so keeping the id alone would leave a
 * constraint naming a live entity and a dead key — a quieter bug than the one
 * being fixed).
 *
 * Two references genuinely cannot survive and are still dropped: the corner
 * being filleted (it becomes several vertices, so there is no single successor)
 * and `center`. Dropping those is correct; dropping them SILENTLY was the bug,
 * so the count comes back for the caller to report.
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
      entities: [`${STOCK_ENTITY_ID}#mid_b`],
    }),
  );
}

/** Fillet the bottom-left corner (index 0). */
function filletBL(doc: CADDocument): number {
  const corner = findCorner({ x: 0, y: 0 }, doc, 1);
  if (corner?.kind !== "rect") throw new Error("expected a rect corner");
  return spliceCornerVertices(corner, doc, [
    { x: 5, y: 0 },
    { x: 0, y: 5 },
  ]);
}

test("the corner is found even when it sits on the stock boundary", () => {
  const { doc } = docWithRect();
  const corner = findCorner({ x: 0, y: 0 }, doc, 1);
  expect(corner?.kind).toBe("rect");
});

test("the rectangle keeps its id through the fillet", () => {
  const { doc, rect } = docWithRect();
  const idBefore = rect.id;
  filletBL(doc);

  const after = doc.entities.find((e) => e.id === idBefore);
  expect(after, "the entity id must survive — references are keyed by it").toBeDefined();
  expect(after).toBeInstanceOf(PolylineEntity);
});

test("a constraint on an UNTOUCHED corner survives, remapped to a live key", () => {
  const { doc, rect } = docWithRect();
  pinToStock(doc, rect.id, "tr"); // the far corner — nothing to do with the fillet
  const dropped = filletBL(doc);

  expect(dropped).toBe(0);
  expect(doc.constraints).toHaveLength(1);

  const ref = doc.constraints[0].points[0];
  expect(ref.entityId).toBe(rect.id);
  expect(ref.key).not.toBe("tr"); // "tr" is meaningless on a polyline
  // And the remapped key must actually RESOLVE — a key that merely differs would
  // be a quieter version of the same bug.
  const poly = doc.entities.find((e): e is PolylineEntity => e instanceof PolylineEntity)!;
  expect(poly.dofPoints().map((p) => p.key)).toContain(ref.key);
  // It still names the same physical corner: top-right of a 60x40 rect.
  expect(poly.getPoint(ref.key)).toEqual({ x: 60, y: 40 });
});

test("a constraint on the FILLETED corner is dropped, and reported", () => {
  const { doc, rect } = docWithRect();
  pinToStock(doc, rect.id, "bl"); // the corner being rounded away
  const dropped = filletBL(doc);

  // Correct to drop — one corner becomes two vertices, so there is no single
  // successor. The point is that the caller is TOLD.
  expect(dropped).toBe(1);
  expect(doc.constraints).toHaveLength(0);
});

test("an edge reference is carried over too", () => {
  const { doc, rect } = docWithRect();
  // The right-hand edge, named the way a segment constraint names it.
  doc.addConstraint(
    makeConstraint("pointOnLine", {
      points: [{ entityId: STOCK_ENTITY_ID, key: "bl" }],
      entities: [`${rect.id}#mid_r`],
    }),
  );
  const dropped = filletBL(doc);

  expect(dropped).toBe(0);
  expect(doc.constraints).toHaveLength(1);
  expect(doc.constraints[0].entities[0]).toMatch(new RegExp(`^${rect.id}#`));
  expect(doc.constraints[0].entities[0]).not.toBe(`${rect.id}#mid_r`);
});

test("a polyline corner is spliced in place and loses nothing", () => {
  const { doc } = docWithRect();
  filletBL(doc); // rect -> polyline, same id
  const poly = doc.entities.find((e): e is PolylineEntity => e instanceof PolylineEntity)!;
  pinToStock(doc, poly.id, `v${poly.vertexIds[2]}`);

  const c2 = findCorner(poly.points[2], doc, 1);
  if (c2?.kind !== "poly") throw new Error("expected a poly corner");
  const dropped = spliceCornerVertices(c2, doc, [{ x: 58, y: 40 }]);

  // Positive control on the whole mechanism: filleting a DIFFERENT vertex of the
  // same polyline drops nothing, so the drops above are about the corner that
  // was cut and not about splicing in general.
  expect(dropped).toBe(0);
  expect(doc.constraints).toHaveLength(1);
});
