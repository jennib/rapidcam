import { describe, expect, it, vi } from "vitest";
import { CADDocument } from "../src/model/document";
import {
  CORNER_TYPES,
  type CornerType,
  PolylineEntity,
  RectEntity,
  cornerSetback,
  cornerWedge,
} from "../src/model/entities";
import { applyFlipH, applyRotate, applyScale } from "../src/core/transform";

/**
 * Polyline corners as a property.
 *
 * The load-bearing claim is an IDENTITY, not a formula: at a 90° corner a
 * polyline's boundary must be exactly a rectangle's. That single assertion pins
 * the centre, the radius, the sweep direction and the tangent points of all
 * three treatments against ~34 rectangle tests that already passed, and it
 * cannot be satisfied by geometry that is merely self-consistent.
 *
 * Away from 90° there is no rectangle to compare with, so the checks there are
 * closed-form areas and tangency — chosen because they fail differently for a
 * mis-centred arc, a reversed sweep, and a treatment applied as its opposite.
 */

const W = 80;
const H = 60;
const R = 12;
const square = (): PolylineEntity =>
  new PolylineEntity(
    [
      { x: 0, y: 0 },
      { x: W, y: 0 },
      { x: W, y: H },
      { x: 0, y: H },
    ],
    true,
  );

function signedArea(pts: { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

describe("a polyline's corners are a rectangle's, at 90°", () => {
  for (const type of CORNER_TYPES) {
    it(`${type}: the boundary is identical to the same rectangle's`, () => {
      const pl = square();
      pl.cornerType = type;
      pl.setAllCornerValues(R);

      const rect = new RectEntity({ x: 0, y: 0 }, { x: W, y: H });
      rect.cornerType = type;
      rect.cornerRadii = [R, R, R, R];

      const a = pl.outlinePoints(0.001);
      const b = rect.outlinePoints(0.001);
      expect(a.length, `${type}: same number of points`).toBe(b.length);
      // Point-wise to 1e-9mm rather than toEqual. The rectangle is axis-aligned,
      // so it takes its edge directions as exact ±1/0 and its setback straight
      // from the radius; the general path goes through acos and tan, and
      // `tan(π/4)` is 0.9999999999999999. The two are algebraically identical
      // and differ in the last bit or two — 2e-16mm, which is not a claim the
      // design makes either way, whereas "the same boundary" is.
      for (let i = 0; i < a.length; i++) {
        expect(a[i].x, `${type} pt${i}.x`).toBeCloseTo(b[i].x, 9);
        expect(a[i].y, `${type} pt${i}.y`).toBeCloseTo(b[i].y, 9);
      }
    });
  }

  it("and so the closed-form areas hold", () => {
    // Independent of the rectangle: a mis-centred arc or an inverted-for-round
    // swap lands on a different number here, not just a different point list.
    const want: Record<CornerType, number> = {
      round: W * H - R * R * (4 - Math.PI),
      inverted: W * H - Math.PI * R * R,
      chamfer: W * H - 2 * R * R,
    };
    for (const type of CORNER_TYPES) {
      const pl = square();
      pl.cornerType = type;
      pl.setAllCornerValues(R);
      // Tessellation makes the ring inscribe (round) or circumscribe (inverted)
      // the true arc, so the tolerance is the flattening budget, not slack.
      expect(signedArea(pl.outlinePoints(0.001)), type).toBeCloseTo(want[type], 1);
    }
  });

  it("keeps the CCW winding CAM compensates from", () => {
    for (const type of CORNER_TYPES) {
      const pl = square();
      pl.cornerType = type;
      pl.setAllCornerValues(R);
      expect(Math.sign(signedArea(pl.outlinePoints())), type).toBe(
        Math.sign(signedArea(pl.points)),
      );
    }
  });
});

describe("away from 90°, a radius and a setback are different numbers", () => {
  // The one real difference from a rectangle, and the thing most likely to be
  // got wrong: `cornerSetback` is what every fit check and clamp goes through.
  const wedgeAt = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    return cornerWedge({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100 * Math.cos(a), y: 100 * Math.sin(a) })!;
  };

  it("a fillet's setback is r/tan(θ/2); a chamfer's is the value itself", () => {
    for (const deg of [30, 60, 90, 120, 150]) {
      const w = wedgeAt(deg);
      const want = 10 / Math.tan(w.angle / 2);
      expect(cornerSetback(w, 10, "round"), `${deg}°`).toBeCloseTo(want, 9);
      expect(cornerSetback(w, 10, "chamfer"), `${deg}°`).toBe(10);
      // The cove is centred ON the vertex, so its tangent points are at r.
      expect(cornerSetback(w, 10, "inverted"), `${deg}°`).toBe(10);
    }
  });

  it("they agree only at 90° — which is why a rectangle needs one number", () => {
    expect(cornerSetback(wedgeAt(90), 10, "round")).toBeCloseTo(10, 9);
    expect(cornerSetback(wedgeAt(60), 10, "round")).not.toBeCloseTo(10, 3);
  });

  it("a fillet really is tangent to both legs at an odd angle", () => {
    // Tangency is the defining property of a fillet and is angle-independent:
    // the arc centre must sit exactly `radius` from each leg line.
    const pl = new PolylineEntity(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 50, y: 90 },
      ],
      true,
    );
    pl.setAllCornerValues(10);
    const parts = pl.outlineParts()!;
    const arcs = parts.filter((p) => p.kind === "arc");
    expect(arcs).toHaveLength(3);
    const distToLine = (p: { x: number; y: number }, a: typeof p, b: typeof p) =>
      Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / Math.hypot(b.x - a.x, b.y - a.y);
    for (const arc of arcs) {
      if (arc.kind !== "arc") continue;
      // Distance to the NEAREST two legs must both equal the radius.
      const legs: [typeof arc.center, typeof arc.center][] = [
        [pl.points[0], pl.points[1]],
        [pl.points[1], pl.points[2]],
        [pl.points[2], pl.points[0]],
      ];
      const ds = legs.map(([a, b]) => distToLine(arc.center, a, b)).sort((x, y) => x - y);
      expect(ds[0]).toBeCloseTo(arc.radius, 6);
      expect(ds[1]).toBeCloseTo(arc.radius, 6);
    }
  });
});

describe("a corner belongs to its vertex, not to an array slot", () => {
  it("survives an insert ahead of it", () => {
    const pl = square();
    pl.setCornerValue(2, 5);
    const shapedAt = { ...pl.points[2] };
    pl.spliceVertices(0, 0, { x: -10, y: -10 });
    const i = pl.points.findIndex((p) => p.x === shapedAt.x && p.y === shapedAt.y);
    expect(i).toBe(3);
    expect(pl.cornerValueAt(3)).toBe(5);
  });

  it("survives the winding reversal a flip performs", () => {
    const pl = square();
    pl.setCornerValue(1, 5);
    const shapedAt = { ...pl.points[1] };
    applyFlipH([pl], 0);
    const i = pl.points.findIndex((p) => Math.abs(p.x + shapedAt.x) < 1e-9 && p.y === shapedAt.y);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(pl.cornerValueAt(i)).toBe(5);
  });

  it("is dropped when its vertex is", () => {
    const pl = square();
    pl.setCornerValue(2, 5);
    pl.spliceVertices(2, 1);
    expect(pl.cornerRadii.size).toBe(0);
  });

  it("scales with the shape but does not turn with it", () => {
    const s = square();
    s.setAllCornerValues(5);
    applyScale([s], 0, 0, 2, 2);
    expect(s.cornerValueAt(0)).toBe(10);

    const r = square();
    r.setAllCornerValues(5);
    applyRotate([r], 0, 0, Math.PI / 3);
    // A radius is a length: rotating the shape cannot change it, and keying by
    // id means there is no permutation to get wrong either.
    expect(r.cornerValueAt(0)).toBe(5);
  });
});

describe("what cannot be shaped, and what will not fit", () => {
  it("an open polyline's ends are not corners", () => {
    const pl = new PolylineEntity(
      [
        { x: 0, y: 0 },
        { x: 50, y: 0 },
        { x: 50, y: 50 },
      ],
      false,
    );
    pl.setAllCornerValues(8);
    expect(pl.cornerValueAt(0)).toBe(0);
    expect(pl.cornerValueAt(2)).toBe(0);
    expect(pl.cornerValueAt(1)).toBe(8);
    // The chain still starts and ends exactly where it always did.
    const o = pl.outlinePoints();
    expect(o[0]).toEqual(pl.points[0]);
    expect(o[o.length - 1]).toEqual(pl.points[2]);
  });

  it("refuses a value the shared edge cannot hold, and says so by returning false", () => {
    const pl = square();
    pl.setCornerValue(0, 70); // 70 of an 80mm bottom edge
    expect(pl.fitsCornerValue(1, 20)).toBe(false); // 70 + 20 > 80
    expect(pl.fitsCornerValue(1, 8)).toBe(true); // positive control
  });

  it("clamps for DRAWING only — the stored value survives a temporary squeeze", () => {
    const pl = square();
    pl.setAllCornerValues(40);
    expect(pl.effectiveCornerValues()[0]).toBeCloseTo(W / 2 > H / 2 ? H / 2 : W / 2, 6);
    expect(pl.cornerRadii.get("0"), "the asked-for value is untouched").toBe(40);

    // Grow it back past the clamp: the corner returns at its full size.
    for (const p of pl.points) {
      p.x *= 4;
      p.y *= 4;
    }
    expect(pl.effectiveCornerValues()[0]).toBe(40);
  });

  it("a shape with no drawable corner produces exactly its vertex list", () => {
    const pl = square();
    expect(pl.outlineParts()).toBeNull();
    expect(pl.outlinePoints()).toEqual(pl.points);
    // And a zeroed corner returns it to that state rather than to something
    // almost-but-not-quite the same.
    pl.setAllCornerValues(5);
    expect(pl.outlinePoints()).not.toEqual(pl.points);
    pl.setAllCornerValues(0);
    expect(pl.outlinePoints()).toEqual(pl.points);
  });
});

describe("the rest of the entity keeps up", () => {
  it("picking follows the arc, not the tessellation", () => {
    const pl = square();
    pl.setAllCornerValues(R);
    // A point on the true corner arc, at 45° from the bottom-left arc centre.
    const c = { x: R, y: R };
    const on = { x: c.x - R * Math.SQRT1_2, y: c.y - R * Math.SQRT1_2 };
    expect(pl.distanceTo(on)).toBeCloseTo(0, 9);
    // The vertex it replaced is now well off the boundary.
    expect(pl.distanceTo({ x: 0, y: 0 })).toBeGreaterThan(R * 0.4);
  });

  it("a duplicate carries its corners", () => {
    const pl = square();
    pl.cornerType = "chamfer";
    pl.setCornerValue(1, 7);
    const copy = pl.duplicate();
    expect(copy.cornerType).toBe("chamfer");
    expect(copy.cornerValueAt(1)).toBe(7);
    expect(copy.outlinePoints()).toEqual(pl.outlinePoints());
  });

  it("exposes `cr` as a scalar DOF, reporting the largest when they differ", () => {
    const pl = square();
    pl.setCornerValue(1, 4);
    pl.setCornerValue(2, 9);
    expect(pl.dofScalars()).toEqual([{ key: "cr", value: 9 }]);
    pl.setScalar("cr", 6);
    expect(pl.points.map((_, i) => pl.cornerValueAt(i))).toEqual([6, 6, 6, 6]);
  });

  it("bounds are unchanged: every treatment cuts INTO the shape", () => {
    // Including at a REFLEX vertex, which a rectangle cannot have and where the
    // arc sits on the far side of the bisector. An inverted corner is the case
    // to watch: it is centred ON the vertex, so if any treatment could push the
    // boundary outside the vertex hull it would be that one.
    const shapes: [string, PolylineEntity][] = [
      ["convex", square()],
      [
        "reflex",
        new PolylineEntity(
          [
            { x: 0, y: 0 },
            { x: 60, y: 0 },
            { x: 60, y: 30 },
            { x: 30, y: 30 }, // reflex
            { x: 30, y: 60 },
            { x: 0, y: 60 },
          ],
          true,
        ),
      ],
    ];
    for (const [name, pl] of shapes) {
      const before = pl.bounds();
      pl.setAllCornerValues(8);
      for (const type of CORNER_TYPES) {
        pl.cornerType = type;
        expect(pl.bounds(), `${name}/${type}`).toEqual(before);
        for (const p of pl.outlinePoints()) {
          expect(p.x, `${name}/${type} x`).toBeGreaterThanOrEqual(before.min.x - 1e-9);
          expect(p.x, `${name}/${type} x`).toBeLessThanOrEqual(before.max.x + 1e-9);
          expect(p.y, `${name}/${type} y`).toBeGreaterThanOrEqual(before.min.y - 1e-9);
          expect(p.y, `${name}/${type} y`).toBeLessThanOrEqual(before.max.y + 1e-9);
        }
      }
    }
  });

  it("hit-testing costs what the corners cost, not what the vertices cost", () => {
    // Hit-testing calls distanceTo for every entity on every pointer move, and
    // a corner costs an acos. The first cut of this built a wedge for EVERY
    // vertex, so a 20,000-point imported trace with one filleted corner paid
    // for 20,000 corners it did not have — 23ms per mouse move, measured.
    //
    // Counted rather than timed: a wall-clock threshold is the flakiest kind of
    // test, and the number of acos calls is the actual claim.
    const big = new PolylineEntity(
      Array.from({ length: 500 }, (_, i) => {
        const a = (i / 500) * Math.PI * 2;
        return { x: 100 * Math.cos(a), y: 100 * Math.sin(a) };
      }),
      true,
    );
    const count = (fn: () => void): number => {
      const spy = vi.spyOn(Math, "acos");
      try {
        fn();
        return spy.mock.calls.length;
      } finally {
        spy.mockRestore();
      }
    };

    expect(count(() => big.distanceTo({ x: 7, y: 3 })), "sharp: no corner work").toBe(0);
    big.setCornerValue(3, 0.2);
    // One shaped vertex: one wedge (built twice — once to clamp, once to cut).
    expect(count(() => big.distanceTo({ x: 7, y: 3 })), "one corner").toBeLessThanOrEqual(4);
    // Positive control: it really does scale with the corners, so the assertion
    // above is measuring something rather than a path that never runs.
    big.setAllCornerValues(0.2);
    expect(count(() => big.distanceTo({ x: 7, y: 3 }))).toBeGreaterThan(500);
  });

  it("a shaped polyline still solves and serialises inside a document", () => {
    const doc = new CADDocument({ width: 200, height: 200 }, "mm");
    const pl = doc.add(square());
    pl.setAllCornerValues(R);
    // The `cr` scalar must not become a solver freedom — see freeScalarKeys.
    // A phantom DOF here is what turned a bundled example blue.
    expect(pl.dofScalars()).toHaveLength(1);
    expect(doc.entities).toContain(pl);
  });
});
