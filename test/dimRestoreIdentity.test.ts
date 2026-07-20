/**
 * Regression coverage for commitDimValue's rollback path. On a rejected dim edit
 * it calls doc.restore(snapshot), which rebuilds every Dimension as a NEW object.
 * The dim editor stays open holding its original reference, so a corrected retry
 * value would land on an orphaned Dimension (silent no-op) unless commitDimValue
 * re-resolves by id. This test pins the underlying invariant that makes the
 * re-resolution both necessary and sufficient.
 */

import { describe, it, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { makeDimension } from "../src/model/dimensions";

describe("doc.restore() dimension identity", () => {
  it("rebuilds dimensions as new objects with stable ids; re-resolution by id recovers the live one", () => {
    const doc = new CADDocument({ width: 300, height: 200 });
    const l = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 0 })) as LineEntity;
    doc.addDimension(
      makeDimension("distance", {
        points: [
          { entityId: l.id, key: "a" },
          { entityId: l.id, key: "b" },
        ],
        value: 50,
        offset: 12,
      }),
    );

    const before = doc.dimensions[0];
    const snap = doc.snapshot();

    // Simulate a rejected commit: the live dim is mutated, then rolled back.
    before.value = 999;
    doc.restore(snap);

    const after = doc.dimensions[0];

    // Identity is NOT preserved — any held reference (e.g. an open dim editor) is
    // now orphaned. This is exactly why commitDimValue must not trust its argument.
    expect(after).not.toBe(before);
    // The id is stable, so re-resolving by id recovers the current live instance...
    expect(after.id).toBe(before.id);
    expect(doc.dimensions.find((d) => d.id === before.id)).toBe(after);
    // ...and the rollback restored the pre-edit value.
    expect(after.value).toBe(50);
  });
});
