/**
 * A dimension's offset is derived purely from where you click to place it —
 * with no awareness of dimensions already sitting nearby. Chain dimensioning
 * (two dimensions measured from the same datum point) routinely lands two
 * dimensions on the same or a near-identical offset, so the shorter one's
 * shaft sits buried inside the longer one instead of stacking cleanly outward
 * — reported directly as dimension lines with a "weird look".
 * avoidDimensionCollision nudges a freshly-placed horizontal/vertical
 * dimension clear of that, once, at placement time.
 */
import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { makeDimension, avoidDimensionCollision, type Dimension } from "../src/model/dimensions";
import type { Geo } from "../src/model/constraints";

function geoOf(doc: CADDocument): Geo {
  const m = new Map(doc.entities.map((e) => [e.id, e]));
  return (id) => m.get(id);
}

test("two vertical dims from the same datum, overlapping range: the new one is nudged clear", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const datum = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 0, y: 0 }));
  const top = doc.add(new LineEntity({ x: 150, y: 124 }, { x: 150, y: 124 }));
  const bottom = doc.add(new LineEntity({ x: 150, y: 76 }, { x: 150, y: 76 }));

  const existing = makeDimension("vertical", {
    points: [
      { entityId: datum.id, key: "a" },
      { entityId: top.id, key: "a" },
    ],
    value: 74,
    offset: -60,
  });
  doc.addDimension(existing);

  const fresh = makeDimension("vertical", {
    points: [
      { entityId: datum.id, key: "a" },
      { entityId: bottom.id, key: "a" },
    ],
    value: 26,
    offset: -60, // same offset as `existing` — this is the collision
  });

  const geo = geoOf(doc);
  const adjusted = avoidDimensionCollision(fresh, doc.dimensions, geo, "mm");
  expect(adjusted).not.toBe(-60);
  expect(Math.abs(adjusted)).toBeGreaterThan(60); // pushed further from the geometry
});

test("two vertical dims already offset far apart: no nudge", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const datum = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 0, y: 0 }));
  const top = doc.add(new LineEntity({ x: 150, y: 124 }, { x: 150, y: 124 }));
  const bottom = doc.add(new LineEntity({ x: 150, y: 76 }, { x: 150, y: 76 }));

  doc.addDimension(
    makeDimension("vertical", {
      points: [
        { entityId: datum.id, key: "a" },
        { entityId: top.id, key: "a" },
      ],
      value: 74,
      offset: -60,
    }),
  );
  const fresh = makeDimension("vertical", {
    points: [
      { entityId: datum.id, key: "a" },
      { entityId: bottom.id, key: "a" },
    ],
    value: 26,
    offset: -200, // already well clear
  });

  const adjusted = avoidDimensionCollision(fresh, doc.dimensions, geoOf(doc), "mm");
  expect(adjusted).toBe(-200);
});

test("close offsets but non-overlapping Y ranges: no nudge (the shafts don't actually cross)", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const a1 = doc.add(new LineEntity({ x: 150, y: 0 }, { x: 150, y: 0 }));
  const a2 = doc.add(new LineEntity({ x: 150, y: 50 }, { x: 150, y: 50 }));
  const b1 = doc.add(new LineEntity({ x: 150, y: 100 }, { x: 150, y: 100 }));
  const b2 = doc.add(new LineEntity({ x: 150, y: 150 }, { x: 150, y: 150 }));

  doc.addDimension(
    makeDimension("vertical", {
      points: [
        { entityId: a1.id, key: "a" },
        { entityId: a2.id, key: "a" },
      ],
      value: 50,
      offset: -60,
    }),
  );
  // Same offset, but its own Y range (100..150) never overlaps the first
  // dimension's (0..50) — nothing to collide with.
  const fresh = makeDimension("vertical", {
    points: [
      { entityId: b1.id, key: "a" },
      { entityId: b2.id, key: "a" },
    ],
    value: 50,
    offset: -60,
  });

  const adjusted = avoidDimensionCollision(fresh, doc.dimensions, geoOf(doc), "mm");
  expect(adjusted).toBe(-60);
});

test("a horizontal dimension never collides against a vertical one, even at the same offset", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const a1 = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 0, y: 0 }));
  const a2 = doc.add(new LineEntity({ x: 150, y: 100 }, { x: 150, y: 100 }));

  doc.addDimension(
    makeDimension("vertical", {
      points: [
        { entityId: a1.id, key: "a" },
        { entityId: a2.id, key: "a" },
      ],
      value: 100,
      offset: -60,
    }),
  );
  const fresh = makeDimension("horizontal", {
    points: [
      { entityId: a1.id, key: "a" },
      { entityId: a2.id, key: "a" },
    ],
    value: 150,
    offset: -60,
  });

  const adjusted = avoidDimensionCollision(fresh, doc.dimensions, geoOf(doc), "mm");
  expect(adjusted).toBe(-60);
});

test("aligned/distance dimensions are untouched — not axis-aligned, out of scope", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const a1 = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 0, y: 0 }));
  const a2 = doc.add(new LineEntity({ x: 150, y: 100 }, { x: 150, y: 100 }));
  const dim = makeDimension("distance", {
    points: [
      { entityId: a1.id, key: "a" },
      { entityId: a2.id, key: "a" },
    ],
    value: 180,
    offset: -60,
  });
  const adjusted = avoidDimensionCollision(dim, doc.dimensions, geoOf(doc), "mm");
  expect(adjusted).toBe(-60);
});

test("a hidden (headless) dimension is not treated as an obstacle", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const datum = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 0, y: 0 }));
  const top = doc.add(new LineEntity({ x: 150, y: 124 }, { x: 150, y: 124 }));
  const bottom = doc.add(new LineEntity({ x: 150, y: 76 }, { x: 150, y: 76 }));

  const hidden: Dimension = {
    ...makeDimension("vertical", {
      points: [
        { entityId: datum.id, key: "a" },
        { entityId: top.id, key: "a" },
      ],
      value: 74,
      offset: -60,
    }),
    hidden: true, // nothing is drawn for this — can't visually collide
  };
  doc.addDimension(hidden);

  const fresh = makeDimension("vertical", {
    points: [
      { entityId: datum.id, key: "a" },
      { entityId: bottom.id, key: "a" },
    ],
    value: 26,
    offset: -60,
  });
  const adjusted = avoidDimensionCollision(fresh, doc.dimensions, geoOf(doc), "mm");
  expect(adjusted).toBe(-60);
});
