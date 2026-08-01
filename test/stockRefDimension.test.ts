/**
 * Dimensioning FROM the stock rectangle's edges/corners — see STOCK_ENTITY_ID
 * in model/document.ts.
 *
 * Before this, there was no way to anchor a dimension to the stock at all: the
 * stock rect isn't an entity, so `pickPoint`/`snapPoints`/the solver's `geo`
 * never resolved it. A user who tried anyway (clicking near the stock edge)
 * would land on whatever real geometry happened to be nearest instead — a
 * dimension that LOOKS anchored to the edge but measures something else
 * entirely, silently. That's the exact "22.50 mm is fiction" failure mode this
 * feature closes: the corner is now a real, resolvable anchor, on a positioned
 * stockRect (New Project's default) as well as the legacy stock-fills-canvas case.
 */
import { test, expect } from "vitest";
import { CADDocument, STOCK_ENTITY_ID, stockRefPoint } from "../src/model/document";
import { CircleEntity, LineEntity } from "../src/model/entities";
import { makeDimension } from "../src/model/dimensions";
import { solve } from "../src/solver/solver";

// New Project's default: a 200×150 stock centred on a 300×250 sheet (see
// projectManager.ts) — the exact scenario the field report hit.
function newProjectDoc(): CADDocument {
  const doc = new CADDocument({ width: 300, height: 250 });
  doc.stockRect = { x: 50, y: 50, width: 200, height: 150 };
  return doc;
}

test("stockRefPoint: positioned stockRect gives corners/midpoints relative to ITS origin, not canvas (0,0)", () => {
  const doc = newProjectDoc();
  expect(stockRefPoint(doc, "bl")).toEqual({ x: 50, y: 50 });
  expect(stockRefPoint(doc, "br")).toEqual({ x: 250, y: 50 });
  expect(stockRefPoint(doc, "tr")).toEqual({ x: 250, y: 200 });
  expect(stockRefPoint(doc, "tl")).toEqual({ x: 50, y: 200 });
  expect(stockRefPoint(doc, "mid_b")).toEqual({ x: 150, y: 50 });
  expect(stockRefPoint(doc, "mid_r")).toEqual({ x: 250, y: 125 });
  expect(stockRefPoint(doc, "mid_t")).toEqual({ x: 150, y: 200 });
  expect(stockRefPoint(doc, "mid_l")).toEqual({ x: 50, y: 125 });
});

test("stockRefPoint: legacy doc (no stockRect) falls back to the whole canvas as stock", () => {
  const doc = new CADDocument({ width: 120, height: 80 });
  expect(stockRefPoint(doc, "bl")).toEqual({ x: 0, y: 0 });
  expect(stockRefPoint(doc, "tr")).toEqual({ x: 120, y: 80 });
});

test("stockRefPoint: a rotary document has no flat stock rect to dimension from", () => {
  const doc = newProjectDoc();
  doc.machineKind = "mill-rotary";
  expect(stockRefPoint(doc, "bl")).toBeNull();
});

test("stockRefPoint: unknown key returns null rather than throwing", () => {
  const doc = newProjectDoc();
  expect(stockRefPoint(doc, "nope")).toBeNull();
});

test("pickPoint finds a stock corner within tolerance, tagged with STOCK_ENTITY_ID", () => {
  const doc = newProjectDoc();
  const pick = doc.pickPoint({ x: 51, y: 51 }, 5);
  expect(pick).not.toBeNull();
  expect(pick!.ref.entityId).toBe(STOCK_ENTITY_ID);
  expect(pick!.ref.key).toBe("bl");
  expect(pick!.pos).toEqual({ x: 50, y: 50 });
});

test("pickPoint: a real entity point closer than the stock corner still wins", () => {
  const doc = newProjectDoc();
  // A circle centre 2mm from the stock's bl corner (50,50) — closer than any
  // click near that corner would be to the corner itself in this test.
  const c = doc.add(new CircleEntity({ x: 52, y: 50 }, 10));
  const pick = doc.pickPoint({ x: 52, y: 50 }, 5);
  expect(pick!.ref.entityId).toBe(c.id);
});

test("snapPoints includes the stock rectangle's corners", () => {
  const doc = newProjectDoc();
  const sp = doc.snapPoints();
  const corner = sp.find((p) => p.entityId === STOCK_ENTITY_ID && p.key === "br");
  expect(corner?.pos).toEqual({ x: 250, y: 50 });
});

test("a driving horizontal dimension from the stock's left edge actually moves the geometry", () => {
  const doc = newProjectDoc();
  const c = doc.add(new CircleEntity({ x: 999, y: 999 }, 5)); // arbitrary start
  doc.addDimension(
    makeDimension("horizontal", {
      points: [
        { entityId: STOCK_ENTITY_ID, key: "bl" },
        { entityId: c.id, key: "c" },
      ],
      value: 22.5,
      offset: 20,
    }),
  );
  const r = solve(doc);
  expect(r.converged).toBe(true);
  // stockRect.x is 50 — the CORRECT anchor. If this ever regresses to measuring
  // from canvas (0,0) instead (the exact bug reported), the circle would land
  // at x=22.5 rather than x=72.5: a 50mm difference, not a rounding error.
  expect(c.center.x).toBeCloseTo(72.5, 3);
  // The stock itself is a fixed reference — dimensioning FROM it must never move it.
  expect(doc.stockRect).toEqual({ x: 50, y: 50, width: 200, height: 150 });
});

test("a driving vertical dimension from the stock's bottom edge moves the geometry, and the legacy (no stockRect) case anchors at 0", () => {
  const doc = new CADDocument({ width: 120, height: 80 }); // no stockRect: stock fills canvas
  const c = doc.add(new CircleEntity({ x: 10, y: 10 }, 5));
  doc.addDimension(
    makeDimension("vertical", {
      points: [
        { entityId: STOCK_ENTITY_ID, key: "bl" },
        { entityId: c.id, key: "c" },
      ],
      value: 30,
      offset: 15,
    }),
  );
  const r = solve(doc);
  expect(r.converged).toBe(true);
  expect(c.center.y).toBeCloseTo(30, 3);
});

test("a driving stock-anchored dimension consumes exactly one degree of freedom", () => {
  const doc = newProjectDoc();
  const c = doc.add(new CircleEntity({ x: 100, y: 100 }, 5));
  const before = solve(doc);
  doc.addDimension(
    makeDimension("horizontal", {
      points: [
        { entityId: STOCK_ENTITY_ID, key: "bl" },
        { entityId: c.id, key: "c" },
      ],
      value: 40,
      offset: 20,
    }),
  );
  const after = solve(doc);
  expect(after.dof).toBe(before.dof - 1);
});

test("deleting an UNRELATED entity does not orphan-prune a stock-anchored dimension", () => {
  // pruneReferences() runs on every entity delete and drops any dimension whose
  // referenced entity id is no longer in doc.entities. STOCK_ENTITY_ID is
  // deliberately never in doc.entities, so without an explicit exception this
  // silently deleted every stock-anchored dimension the next time the user
  // deleted anything ELSE, anywhere in the drawing.
  const doc = newProjectDoc();
  const c = doc.add(new CircleEntity({ x: 100, y: 100 }, 5));
  const dim = makeDimension("horizontal", {
    points: [
      { entityId: STOCK_ENTITY_ID, key: "bl" },
      { entityId: c.id, key: "c" },
    ],
    value: 40,
    offset: 20,
  });
  doc.addDimension(dim);

  const unrelated = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 10, y: 10 }));
  doc.remove(unrelated);

  expect(doc.dimensions.find((d) => d.id === dim.id)).toBeDefined();
});
