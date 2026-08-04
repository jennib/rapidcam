import { describe, expect, test } from "vitest";
import { CADDocument, STOCK_ENTITY_ID } from "../src/model/document";
import { makeConstraint } from "../src/model/constraints";
import { makeDimension } from "../src/model/dimensions";
import { CircleEntity, LineEntity } from "../src/model/entities";

/**
 * References to the stock rectangle must survive an unrelated delete.
 *
 * `pruneReferences` drops any constraint or dimension whose geometry is gone,
 * which is right — except the stock rect is never IN `doc.entities`; it is
 * derived on demand and cannot be deleted, so it is never actually orphaned. The
 * exemption for that existed but covered only a dimension's `points`, so
 * anything anchored to a stock EDGE — `__stock__#mid_b`, which arrives in
 * `entities` rather than `points` — was silently destroyed the next time any
 * unrelated shape was deleted.
 *
 * Silent is the operative word: the constraint vanishes, the sketch quietly
 * gains a degree of freedom, and nothing says so. Hence a test per reference
 * shape, each with a positive control that a genuinely orphaned reference IS
 * still pruned — otherwise "nothing was deleted" would pass by pruning nothing.
 */

/** A doc with flat stock, a line, and an unrelated circle to delete. */
function scene() {
  const doc = new CADDocument({ width: 200, height: 150 }, "mm");
  doc.stockRect = { x: 0, y: 0, width: 200, height: 150 };
  const line = doc.add(new LineEntity({ x: 10, y: 10 }, { x: 90, y: 10 }));
  const unrelated = doc.add(new CircleEntity({ x: 150, y: 120 }, 5));
  return { doc, line, unrelated };
}

describe("stock references survive unrelated deletes", () => {
  test("a constraint on a stock EDGE", () => {
    const { doc, line, unrelated } = scene();
    doc.addConstraint(
      makeConstraint("pointOnLine", {
        points: [{ entityId: line.id, key: "a" }],
        entities: [`${STOCK_ENTITY_ID}#mid_b`],
      }),
    );

    doc.remove(unrelated);
    expect(doc.constraints).toHaveLength(1);
  });

  test("a dimension against a stock EDGE", () => {
    const { doc, line, unrelated } = scene();
    doc.addDimension(
      makeDimension("angle", {
        entities: [line.id, `${STOCK_ENTITY_ID}#mid_b`],
        value: 0,
        offset: 0,
      }),
    );

    doc.remove(unrelated);
    expect(doc.dimensions).toHaveLength(1);
  });

  test("a dimension to a stock CORNER point (the case already covered)", () => {
    const { doc, line, unrelated } = scene();
    doc.addDimension(
      makeDimension("horizontal", {
        points: [
          { entityId: STOCK_ENTITY_ID, key: "bl" },
          { entityId: line.id, key: "a" },
        ],
        value: 10,
        offset: 0,
      }),
    );

    doc.remove(unrelated);
    expect(doc.dimensions).toHaveLength(1);
  });

  test("but a genuinely orphaned reference is still pruned", () => {
    // The positive control: without this, a prune that never removed anything
    // would satisfy every assertion above.
    const { doc, line, unrelated } = scene();
    doc.addConstraint(
      makeConstraint("pointOnLine", {
        points: [{ entityId: line.id, key: "a" }],
        entities: [unrelated.id],
      }),
    );
    doc.addDimension(
      makeDimension("radius", { entities: [unrelated.id], value: 5, offset: 0 }),
    );

    doc.remove(unrelated);
    expect(doc.constraints, "constraint on deleted geometry").toHaveLength(0);
    expect(doc.dimensions, "dimension on deleted geometry").toHaveLength(0);
  });
});
