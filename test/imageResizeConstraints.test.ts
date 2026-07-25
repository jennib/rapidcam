/**
 * Resizing a placed image THROUGH the constraint engine — the `constraintFit`
 * modes. "rigid" (the default, covered in imageConstraints.test.ts) is a pure
 * move; these cover "scale" (uniform, the calibrate case) and "stretch".
 */
import { expect, test } from "vitest";
import { makeConstraint } from "../src/model/constraints";
import { makeDimension } from "../src/model/dimensions";
import { CADDocument } from "../src/model/document";
import {
  CircleEntity,
  type ImageConstraintFit,
  RasterImageEntity,
} from "../src/model/entities";
import { applyFile, serializeDoc } from "../src/io/fileio";
import { computeEntityDofStatus, solve } from "../src/solver/solver";

const near = (p: { x: number; y: number }, x: number, y: number, d = 3) => {
  expect(p.x).toBeCloseTo(x, d);
  expect(p.y).toBeCloseTo(y, d);
};

/** Pin a point of any entity to an absolute position. */
function pin(doc: CADDocument, entityId: string, key: string, x: number, y: number) {
  doc.addConstraint(
    makeConstraint("fixedPoint", { points: [{ entityId, key }], params: [x, y] }),
  );
}

test("scale fit: pinning two corners resizes the image uniformly onto them", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const img = doc.add(new RasterImageEntity("img", { x: 0, y: 0 }, 20, 10, 0)); // 2:1
  img.constraintFit = "scale-rotate";
  pin(doc, img.id, "c0", 30, 40);
  pin(doc, img.id, "c1", 90, 40); // the bottom edge must become 60mm long

  const r = solve(doc);
  expect(r.converged).toBe(true);
  near(img.getPoint("c0"), 30, 40);
  near(img.getPoint("c1"), 90, 40);
  expect(img.widthMM).toBeCloseTo(60, 3); // scaled ×3 …
  expect(img.heightMM).toBeCloseTo(30, 3); // … and the height came with it
  expect(img.widthMM / img.heightMM).toBeCloseTo(2, 9); // aspect exact, not approximate
  expect(img.angle).toBeCloseTo(0, 4);
});

test("scale-rotate fit: two corners off-axis turn the image as well as scale it", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const img = doc.add(new RasterImageEntity("img", { x: 0, y: 0 }, 20, 10, 0));
  img.constraintFit = "scale-rotate";
  pin(doc, img.id, "c0", 10, 10);
  pin(doc, img.id, "c1", 10, 50); // bottom edge now points straight up: 40mm at 90°

  expect(solve(doc).converged).toBe(true);
  near(img.getPoint("c0"), 10, 10);
  near(img.getPoint("c1"), 10, 50);
  expect(img.widthMM).toBeCloseTo(40, 3);
  expect(img.heightMM).toBeCloseTo(20, 3);
  // A quarter turn — and reached the SHORT way round, not by winding through
  // extra revolutions to an equivalent angle (the anchor's moment-arm scaling).
  expect(img.angle).toBeCloseTo(Math.PI / 2, 4);
  // c3 is perpendicular to the pinned edge, at the scaled height — the image was
  // rotated and scaled, never sheared.
  near(img.getPoint("c3"), -10, 10);
});

test("scale fit: a driving dimension across the image calibrates it (the scan case)", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const img = doc.add(new RasterImageEntity("img", { x: 0, y: 0 }, 80, 40, 0));
  img.constraintFit = "scale";
  pin(doc, img.id, "c0", 0, 0); // hold the anchor so only the size can move
  // "This edge of the scan is 100mm" — a horizontal dimension across the bottom
  // edge, exactly what the Dimension tool builds when you click one.
  doc.dimensions.push(
    makeDimension("horizontal", {
      points: [
        { entityId: img.id, key: "c0" },
        { entityId: img.id, key: "c1" },
      ],
      value: 100,
      offset: 10,
      driving: true,
    }),
  );

  expect(solve(doc).converged).toBe(true);
  expect(img.widthMM).toBeCloseTo(100, 3);
  expect(img.heightMM).toBeCloseTo(50, 3); // 2:1 kept
  near(img.getPoint("c0"), 0, 0); // calibrating pivots about the held corner

  // Re-calibrating to a different value rescales from wherever it is now.
  doc.dimensions[0].value = 40;
  expect(solve(doc).converged).toBe(true);
  expect(img.widthMM).toBeCloseTo(40, 3);
  expect(img.heightMM).toBeCloseTo(20, 3);
});

test("scale fit: a dimension on the HEIGHT edge drives the same single scale DOF", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const img = doc.add(new RasterImageEntity("img", { x: 0, y: 0 }, 80, 40, 0));
  img.constraintFit = "scale";
  pin(doc, img.id, "c0", 0, 0);
  doc.dimensions.push(
    makeDimension("vertical", {
      points: [
        { entityId: img.id, key: "c0" },
        { entityId: img.id, key: "c3" },
      ],
      value: 10,
      offset: 10,
      driving: true,
    }),
  );

  // h isn't a solver variable in this mode — it rides on w — so this only works
  // because the coupling makes the height respond to the width DOF.
  expect(solve(doc).converged).toBe(true);
  expect(img.heightMM).toBeCloseTo(10, 3);
  expect(img.widthMM).toBeCloseTo(20, 3);
  expect(img.angle).toBeCloseTo(0, 6); // scaled, not tilted to fake the gap
});

test("stretch fit: three pinned corners pull the image non-uniformly", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const img = doc.add(new RasterImageEntity("img", { x: 0, y: 0 }, 20, 20, 0));
  img.constraintFit = "stretch";
  pin(doc, img.id, "c0", 0, 0);
  pin(doc, img.id, "c1", 60, 0); // width → 60
  pin(doc, img.id, "c3", 0, 15); // height → 15

  expect(solve(doc).converged).toBe(true);
  expect(img.widthMM).toBeCloseTo(60, 3);
  expect(img.heightMM).toBeCloseTo(15, 3); // aspect deliberately NOT preserved
  expect(img.angle).toBeCloseTo(0, 4);
});

test("scale fit refuses to shear: a stretch-shaped pin set can't be met exactly", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const img = doc.add(new RasterImageEntity("img", { x: 0, y: 0 }, 20, 20, 0));
  img.constraintFit = "scale";
  pin(doc, img.id, "c0", 0, 0);
  pin(doc, img.id, "c1", 60, 0);
  pin(doc, img.id, "c3", 0, 15); // impossible without breaking the 1:1 aspect

  const r = solve(doc);
  expect(r.converged).toBe(false);
  expect(computeEntityDofStatus(doc, r).get(img.id)).toBe("conflict");
  // Still a real image: a best-fit uniform scale, aspect intact, nothing NaN.
  expect(img.widthMM / img.heightMM).toBeCloseTo(1, 9);
  expect(Number.isFinite(img.widthMM) && img.widthMM > 0).toBe(true);
});

test("a corner constraint onto other geometry scales the image to reach it", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const img = doc.add(new RasterImageEntity("img", { x: 0, y: 0 }, 20, 10, 0));
  img.constraintFit = "scale-rotate";
  const hole = doc.add(new CircleEntity({ x: 120, y: 60 }, 4));
  doc.addConstraint(makeConstraint("fixed", { entities: [hole.id] }));
  pin(doc, img.id, "c0", 0, 0);
  doc.addConstraint(
    makeConstraint("coincident", {
      points: [
        { entityId: img.id, key: "c2" },
        { entityId: hole.id, key: "c" },
      ],
    }),
  );

  expect(solve(doc).converged).toBe(true);
  near(img.getPoint("c2"), 120, 60);
  near(img.getPoint("c0"), 0, 0);
  expect(img.widthMM / img.heightMM).toBeCloseTo(2, 9);
});

test("rotate fit: levelling an edge turns the image (a tilted scan straightened)", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const tilt = 0.35; // ~20° off level, as a scan lands on the bed
  const img = doc.add(new RasterImageEntity("img", { x: 20, y: 20 }, 60, 30, tilt));
  img.constraintFit = "rotate";
  // "this edge should be horizontal" — the generic constraint bar builds exactly
  // this for two selected points.
  doc.addConstraint(
    makeConstraint("horizontal", {
      points: [
        { entityId: img.id, key: "c0" },
        { entityId: img.id, key: "c1" },
      ],
    }),
  );

  expect(solve(doc).converged).toBe(true);
  expect(img.angle).toBeCloseTo(0, 4); // turned back to level, the short way
  // Level to the solver's own convergence bar (1e-4 on the constraint residual).
  expect(Math.abs(img.getPoint("c0").y - img.getPoint("c1").y)).toBeLessThan(1e-4);
  expect(img.widthMM).toBeCloseTo(60, 3); // rotation only — size untouched
  expect(img.heightMM).toBeCloseTo(30, 3);
});

test("a free size can satisfy a rotation constraint by collapsing — which is why 'rotate' holds it", () => {
  // The cautionary case behind the narrow fits: `c0.y == c1.y` reads
  // w·sin(angle) = 0, which a free size can satisfy at w→0 as readily as the
  // intended angle→0. Under-constrained, the solver may take either root.
  const doc = new CADDocument({ width: 300, height: 300 });
  const img = doc.add(new RasterImageEntity("img", { x: 20, y: 20 }, 60, 30, 0.35));
  img.constraintFit = "scale-rotate";
  doc.addConstraint(
    makeConstraint("horizontal", {
      points: [
        { entityId: img.id, key: "c0" },
        { entityId: img.id, key: "c1" },
      ],
    }),
  );

  const r = solve(doc);
  expect(r.converged).toBe(true); // the constraint IS met …
  expect(r.dof).toBeGreaterThan(0); // … but the fit was under-constrained,
  expect(computeEntityDofStatus(doc, r).get(img.id)).toBe("under-defined"); // and says so
  expect(img.widthMM / img.heightMM).toBeCloseTo(2, 9); // aspect still exact
});

test("a formula binding still drives size in every fit, including rigid", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const img = doc.add(new RasterImageEntity("img", { x: 0, y: 0 }, 20, 10, 0));
  doc.variables.push({ id: "v1", name: "plateW", expr: "120", value: 120 });
  doc.bindings.push({ id: "b1", entityId: img.id, scalarKey: "w", expr: "plateW/2" });

  // Rigid is about GEOMETRIC constraints; a binding is a driver, not a constraint.
  expect(solve(doc).converged).toBe(true);
  expect(img.widthMM).toBeCloseTo(60, 3);
  expect(img.heightMM).toBeCloseTo(10, 3); // rigid: no aspect coupling

  // In a uniform-scale fit the same binding scales the height with it.
  img.constraintFit = "scale";
  img.widthMM = 20;
  img.heightMM = 10;
  expect(solve(doc).converged).toBe(true);
  expect(img.widthMM).toBeCloseTo(60, 3);
  expect(img.heightMM).toBeCloseTo(30, 3);
});

test("DOF accounting: rigid = 2 (move), scale = 3 (+ size), scale-rotate = 4, stretch = 5", () => {
  const dofFor = (fit: ImageConstraintFit) => {
    const doc = new CADDocument({ width: 300, height: 300 });
    const img = doc.add(new RasterImageEntity("img", { x: 0, y: 0 }, 20, 10, 0));
    img.constraintFit = fit;
    // One coincident constraint to a fixed hole = 2 equations, so the reported
    // DOF is the image's own freedom minus 2.
    const hole = doc.add(new CircleEntity({ x: 50, y: 50 }, 4));
    doc.addConstraint(makeConstraint("fixed", { entities: [hole.id] }));
    doc.addConstraint(
      makeConstraint("coincident", {
        points: [
          { entityId: img.id, key: "c0" },
          { entityId: hole.id, key: "c" },
        ],
      }),
    );
    return solve(doc).dof + 2;
  };
  expect(dofFor("rigid")).toBe(2);
  expect(dofFor("scale")).toBe(3);
  expect(dofFor("scale-rotate")).toBe(4);
  expect(dofFor("stretch")).toBe(5);
});

test("the fit mode round-trips through save/load (and rigid stays out of the file)", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const img = doc.add(new RasterImageEntity("img", { x: 0, y: 0 }, 20, 10, 0));
  img.constraintFit = "scale";
  pin(doc, img.id, "c0", 30, 40);
  pin(doc, img.id, "c1", 90, 40);

  const file = serializeDoc(doc, "fit");
  const doc2 = new CADDocument({ width: 1, height: 1 });
  applyFile(doc2, file);
  const img2 = doc2.entities.find((e) => e.type === "image") as RasterImageEntity;
  expect(img2.constraintFit).toBe("scale");
  expect(solve(doc2).converged).toBe(true);
  expect(img2.widthMM).toBeCloseTo(60, 3);

  // Default stays absent, so existing files are byte-identical and legacy files
  // (no field) load as rigid.
  img.constraintFit = "rigid";
  const rigidEnt = JSON.parse(JSON.stringify(serializeDoc(doc, "fit"))).entities.find(
    (e: { type: string }) => e.type === "image",
  );
  expect(rigidEnt.constraintFit).toBeUndefined();
  const doc3 = new CADDocument({ width: 1, height: 1 });
  applyFile(doc3, serializeDoc(doc, "fit"));
  expect((doc3.entities.find((e) => e.type === "image") as RasterImageEntity).constraintFit).toBe(
    "rigid",
  );
});

test("an unknown fit in a hand-written file loads as rigid, not as a broken solve", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  doc.add(new RasterImageEntity("img", { x: 0, y: 0 }, 20, 10, 0));
  const file = serializeDoc(doc, "fit") as unknown as {
    entities: { type: string; constraintFit?: string }[];
  };
  file.entities.find((e) => e.type === "image")!.constraintFit = "squish";

  const doc2 = new CADDocument({ width: 1, height: 1 });
  applyFile(doc2, file as unknown as Parameters<typeof applyFile>[1]);
  const img2 = doc2.entities.find((e) => e.type === "image") as RasterImageEntity;
  expect(img2.constraintFit).toBe("rigid");
  expect(() => solve(doc2)).not.toThrow();
});

test("duplicating an image carries its fit mode", () => {
  const img = new RasterImageEntity("img", { x: 0, y: 0 }, 20, 10, 0);
  img.constraintFit = "stretch";
  expect(img.duplicate().constraintFit).toBe("stretch");
});

test("scale fit leaves an unconstrained image exactly where it is", () => {
  const doc = new CADDocument({ width: 300, height: 300 });
  const img = doc.add(new RasterImageEntity("img", { x: 5, y: 7 }, 20, 10, 0.3));
  img.constraintFit = "scale";
  solve(doc);
  near(img.position, 5, 7, 6);
  expect(img.widthMM).toBeCloseTo(20, 6);
  expect(img.heightMM).toBeCloseTo(10, 6);
  expect(img.angle).toBeCloseTo(0.3, 6);
});
