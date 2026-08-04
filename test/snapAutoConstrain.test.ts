import { describe, expect, test } from "vitest";
import { CADDocument } from "../src/model/document";
import { makeConstraint } from "../src/model/constraints";
import {
  ArcEntity,
  CircleEntity,
  LineEntity,
  RectEntity,
  type SnapPoint,
} from "../src/model/entities";
import { intersectionsNear } from "../src/core/intersect";
import { autoJoin } from "../src/tools/lineTool";
import { solve } from "../src/solver/solver";
import type { ToolContext } from "../src/tools/tool";

/**
 * Snapping to a crossing must CONSTRAIN to it, not merely land on it.
 *
 * Reported from a real file: a circle drawn on the intersection of two
 * construction lines had its centre at exactly the right coordinates and not a
 * single constraint referencing it. The position was a coincidence of numbers,
 * so the first edit to either line left the circle behind — the drawing looked
 * parametric and was not.
 *
 * Three things had to be true and only the first was:
 *   1. the snap finds the crossing,
 *   2. the snap REMEMBERS what crossed (it reported `entityId: ""`),
 *   3. the tool turns that into constraints (circleTool kept only snaps with an
 *      exact point `key`, discarding on-line and crossing snaps entirely).
 *
 * So the assertions here are about the SOLVER holding the point, not about a
 * constraint object existing: a constraint that names the wrong thing — a bare
 * rectangle id, say — is silently inert, which is the failure being guarded.
 */

/** Minimal ToolContext: autoJoin only ever touches the document. */
const ctxFor = (doc: CADDocument) => ({ doc }) as unknown as ToolContext;

/** A cross of two lines meeting at (50, 50). */
function cross() {
  const doc = new CADDocument({ width: 200, height: 150 }, "mm");
  const vert = doc.add(new LineEntity({ x: 50, y: 0 }, { x: 50, y: 120 }));
  const horiz = doc.add(new LineEntity({ x: 0, y: 50 }, { x: 150, y: 50 }));
  return { doc, vert, horiz };
}

describe("the crossing remembers what crossed", () => {
  test("intersectionsNear reports both entity ids", () => {
    const { doc, vert, horiz } = cross();
    const hits = intersectionsNear(doc.entities, { x: 50, y: 50 }, 2);

    expect(hits).toHaveLength(1);
    expect(hits[0].pos.x).toBeCloseTo(50);
    expect(hits[0].pos.y).toBeCloseTo(50);
    expect([...hits[0].ids].sort()).toEqual([vert.id, horiz.id].sort());
  });
});

describe("autoJoin on an intersection", () => {
  test("adds one constraint per crossed entity, and the solver holds the point", () => {
    const { doc, vert, horiz } = cross();
    const circle = doc.add(new CircleEntity({ x: 50, y: 50 }, 10));
    const snap: SnapPoint = {
      pos: { x: 50, y: 50 },
      kind: "intersection",
      entityId: "",
      crossIds: [vert.id, horiz.id],
    };

    autoJoin(ctxFor(doc), circle.id, "c", snap);

    expect(doc.constraints).toHaveLength(2);
    expect(doc.constraints.every((c) => c.type === "pointOnLine")).toBe(true);
    // `entities` is the TARGET side; constraintEntityIds would also include the
    // circle itself (it owns the constrained point), which is not what is
    // being asserted here.
    expect(doc.constraints.flatMap((c) => c.entities).sort()).toEqual(
      [vert.id, horiz.id].sort(),
    );

    // The point of the exercise: move a line and the centre FOLLOWS.
    //
    // The moved line is FIXED at its new place with real constraints. Note the
    // solver's `pins` argument does the opposite of what its name suggests here
    // — it releases a point from anchoring because the user is dragging it —
    // so pinning would have let the solver drag the line back and prove nothing.
    horiz.a = { x: 0, y: 90 };
    horiz.b = { x: 150, y: 90 };
    doc.addConstraint(
      makeConstraint("fixedPoint", {
        points: [{ entityId: horiz.id, key: "a" }],
        params: [0, 90],
      }),
    );
    doc.addConstraint(
      makeConstraint("fixedPoint", {
        points: [{ entityId: horiz.id, key: "b" }],
        params: [150, 90],
      }),
    );
    solve(doc);
    expect(circle.center.y, "centre followed the horizontal line").toBeCloseTo(90, 3);
    expect(circle.center.x, "and stayed on the vertical one").toBeCloseTo(50, 3);
  });

  test("picks the constraint that suits what was crossed", () => {
    const doc = new CADDocument({ width: 200, height: 150 }, "mm");
    const line = doc.add(new LineEntity({ x: 0, y: 50 }, { x: 150, y: 50 }));
    const circ = doc.add(new CircleEntity({ x: 50, y: 50 }, 20));
    const arc = doc.add(new ArcEntity({ x: 50, y: 50 }, 30, 0, Math.PI));
    const dot = doc.add(new CircleEntity({ x: 70, y: 50 }, 1));

    autoJoin(ctxFor(doc), dot.id, "c", {
      pos: { x: 70, y: 50 },
      kind: "intersection",
      entityId: "",
      crossIds: [line.id, circ.id],
    });
    expect(doc.constraints.map((c) => c.type).sort()).toEqual(["pointOnCircle", "pointOnLine"]);

    doc.constraints = [];
    autoJoin(ctxFor(doc), dot.id, "c", {
      pos: { x: 80, y: 50 },
      kind: "intersection",
      entityId: "",
      crossIds: [line.id, arc.id],
    });
    expect(doc.constraints.map((c) => c.type).sort()).toEqual(["pointOnArc", "pointOnLine"]);
  });

  test("skips an entity whose crossing cannot be named to one curve", () => {
    // A rectangle id names four edges, and `pointOnLine` against it resolves to
    // nothing — an inert constraint that LOOKS like the point is held. Adding
    // none is the honest outcome until the edge can be identified.
    const doc = new CADDocument({ width: 200, height: 150 }, "mm");
    const line = doc.add(new LineEntity({ x: 0, y: 50 }, { x: 150, y: 50 }));
    const rect = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 100, y: 80 }));
    const dot = doc.add(new CircleEntity({ x: 20, y: 50 }, 1));

    autoJoin(ctxFor(doc), dot.id, "c", {
      pos: { x: 20, y: 50 },
      kind: "intersection",
      entityId: "",
      crossIds: [line.id, rect.id],
    });

    // The line half is still held; the rectangle half is skipped rather than
    // faked.
    expect(doc.constraints).toHaveLength(1);
    expect(doc.constraints[0].entities).toEqual([line.id]);
  });
});
