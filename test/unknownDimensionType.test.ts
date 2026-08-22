/**
 * A dimension type this build cannot measure must be IGNORED, not allowed to
 * take the document down with it.
 *
 * A `.rcam` can carry one two ways: hand-authored or AI-authored with a typo in
 * `type` (File → Open does not validate against the schema — that check lives
 * on the AI-assistant path), or written by a later RapidCAM. Either is ordinary.
 *
 * What used to happen: `dimensionMeasure`'s switch had no default, so it fell
 * off the end and returned `undefined`. `dimensionResiduals` guarded only
 * `m === null`, so `undefined` sailed past, `undefined - dim.value` put a NaN
 * into the residual vector, and the solve stopped converging — which the status
 * bar renders as "Over-constrained / conflicting", blaming geometry that was
 * fine, with nothing pointing at the file.
 */
import { describe, expect, it } from "vitest";
import type { Geo } from "../src/model/constraints";
import {
  type Dimension,
  dimensionLayout,
  dimensionMeasure,
  dimensionResiduals,
  makeDimension,
  unreadableDimensionTypes,
} from "../src/model/dimensions";
import { CADDocument } from "../src/model/document";
import { CircleEntity, LineEntity } from "../src/model/entities";
import { solve } from "../src/solver/solver";

/** A 100mm line with a driving length dimension whose type is from the future. */
function docWithAlienDim(): { doc: CADDocument; line: LineEntity; dim: Dimension; geo: Geo } {
  const doc = new CADDocument({ width: 200, height: 200 });
  const line = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 0 })) as LineEntity;
  const dim = makeDimension("distance", {
    points: [
      { entityId: line.id, key: "a" },
      { entityId: line.id, key: "b" },
    ],
    value: 50,
    offset: 10,
  });
  // Exactly what a later version's file looks like to this one.
  (dim as { type: string }).type = "from-the-future";
  doc.addDimension(dim);
  const geo: Geo = (id) => doc.entities.find((e) => e.id === id);
  return { doc, line, dim, geo };
}

describe("a dimension type this build cannot measure", () => {
  it("measures as null, not undefined — the signature has to be true", () => {
    const { dim, geo } = docWithAlienDim();
    expect(dimensionMeasure(dim, geo)).toBe(null);
  });

  it("contributes no residual, so it cannot poison the solve", () => {
    const { dim, geo } = docWithAlienDim();
    expect(dimensionResiduals(dim, geo)).toEqual([]);
  });

  it("leaves the rest of the document solving normally", () => {
    const { doc, line } = docWithAlienDim();
    const res = solve(doc);
    // The whole failure was here: a single unreadable dimension reported the
    // document as conflicting, which is what the status bar shows the user.
    expect(res.converged).toBe(true);
    // ...and the geometry it claimed to drive is simply left alone.
    expect(line.length).toBeCloseTo(100, 6);
  });

  it("draws nothing rather than drawing something wrong", () => {
    const { dim, geo } = docWithAlienDim();
    expect(dimensionLayout(dim, geo, "mm")).toBe(null);
  });

  it("is reported by name, so the file can be blamed instead of the geometry", () => {
    const { doc } = docWithAlienDim();
    expect(unreadableDimensionTypes(doc.dimensions)).toEqual(["from-the-future"]);
  });

  it("says nothing about a document whose dimensions are all readable", () => {
    // The positive control: a check that fires on everything is no check.
    const doc = new CADDocument({ width: 200, height: 200 });
    const l = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 0 })) as LineEntity;
    doc.addDimension(
      makeDimension("distance", {
        points: [
          { entityId: l.id, key: "a" },
          { entityId: l.id, key: "b" },
        ],
        value: 50,
        offset: 10,
      }),
    );
    doc.addDimension(
      makeDimension("point-line-distance", {
        points: [{ entityId: l.id, key: "a" }],
        entities: [l.id],
        value: 0,
        offset: 0,
      }),
    );
    expect(unreadableDimensionTypes(doc.dimensions)).toEqual([]);
  });

  it("names each unknown type once, sorted", () => {
    const { doc } = docWithAlienDim();
    for (const t of ["zzz-later", "from-the-future", "aaa-later"]) {
      const d = makeDimension("distance", { points: [], value: 0, offset: 0 });
      (d as { type: string }).type = t;
      doc.addDimension(d);
    }
    expect(unreadableDimensionTypes(doc.dimensions)).toEqual([
      "aaa-later",
      "from-the-future",
      "zzz-later",
    ]);
  });

  it("also drops a KNOWN type whose measurement comes out as NaN", () => {
    // The other way a file poisons the solve, and the reason the residual guard
    // tests `Number.isFinite` rather than just `!== null`: a hand-authored
    // `"radius": null` (or `"radius": "8mm"`) becomes a NaN radius, and NaN is
    // a perfectly ordinary number as far as `dimensionMeasure`'s diameter arm
    // is concerned. Unlike an unknown type this is not the version's fault, so
    // it is dropped silently rather than reported as unreadable.
    const doc = new CADDocument({ width: 200, height: 200 });
    const c = doc.add(new CircleEntity({ x: 50, y: 50 }, Number.NaN)) as CircleEntity;
    const geo: Geo = (id) => doc.entities.find((e) => e.id === id);
    const d = makeDimension("diameter", { entities: [c.id], value: 10, offset: 5 });
    doc.addDimension(d);

    expect(dimensionMeasure(d, geo)).toBeNaN(); // the measurement really is NaN...
    expect(dimensionResiduals(d, geo)).toEqual([]); // ...and never reaches the solver
    expect(solve(doc).converged).toBe(true);
    expect(unreadableDimensionTypes(doc.dimensions)).toEqual([]);
  });

  it("still measures a dimension whose type is known but whose geometry is gone", () => {
    // "measure returned null" cannot tell the two apart, which is why the known
    // -type list exists separately from dimensionMeasure. A dangling reference
    // must NOT be reported as an unreadable type — that would blame the version
    // for what is really a deleted entity.
    const doc = new CADDocument({ width: 200, height: 200 });
    doc.addDimension(
      makeDimension("distance", {
        points: [
          { entityId: "gone", key: "a" },
          { entityId: "gone", key: "b" },
        ],
        value: 50,
        offset: 10,
      }),
    );
    const geo: Geo = () => undefined;
    expect(dimensionMeasure(doc.dimensions[0], geo)).toBe(null);
    expect(unreadableDimensionTypes(doc.dimensions)).toEqual([]);
  });
});
