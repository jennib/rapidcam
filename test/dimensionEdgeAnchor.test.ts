/**
 * Dimension picking, and what each pair of picks MEANS.
 *
 * The reported bug: "I can only attach a distance dimension from the midpoint of
 * a line... there are three dimensions all on the midpoint of the lines and they
 * overlap." A line's pickable points are its two ends and its midpoint, and a
 * rectangle's are its corners, edge midpoints and centre — so the tool's
 * "nearest pickable point" fallback turned any click along an edge into that
 * edge's midpoint. Every dimension measured to one edge then started from the
 * same point, and moving one could not separate them: `offset` slides the
 * shaft, never the anchor.
 *
 * Two things came out of that. A click anywhere on an object is now a point ON
 * it, carried by the `<edgeKey>@<t>` point key (see EDGE_ANCHOR_SEP) and by
 * `curve@<t>` for a Bézier. And each PAIR of picks resolves to what the CAD
 * tools this app is modelled on would report:
 *
 *   point + point            → distance / Δx / Δy, chosen by the drag
 *   point + edge             → the PERPENDICULAR distance to that edge
 *   parallel edge + edge     → the gap, positioned where you clicked
 *   crossing edge + edge     → the angle between them
 *   one edge + open space    → that edge's own length (Tab: a line's angle)
 */

import { describe, expect, it } from "vitest";
import type { Vec2 } from "../src/core/vec2";
import { SnapEngine } from "../src/input/snapping";
import {
  dimensionLayout,
  dimensionMeasure,
  dimensionSlideAnchors,
  dragDimensionTo,
  findDrivingDuplicate,
  makeDimension,
} from "../src/model/dimensions";
import { CADDocument } from "../src/model/document";
import {
  baseAnchorKey,
  BezierEntity,
  bezierPointAt,
  CircleEntity,
  curveAnchorT,
  edgeAnchorKey,
  edgeAnchorT,
  isEdgeAnchorKey,
  LineEntity,
  PolylineEntity,
  RectEntity,
} from "../src/model/entities";
import { solve } from "../src/solver/solver";
import { DimensionTool } from "../src/tools/dimensionTool";
import type { ToolContext, ToolPointerEvent } from "../src/tools/tool";
import { type Geo, SEGMENT_SEP } from "../src/model/constraints";

function makeCtx(doc: CADDocument): ToolContext {
  return {
    doc,
    view: { scale: 1, toWorldLen: (px: number) => px } as ToolContext["view"],
    requestRender() {},
    solve() {},
    pushHistory() {},
    openDimEditor() {},
    currentDof: () => 5,
    openTypeToDraw() {},
    activateTool() {},
    closeTypeToDraw() {},
    notify() {},
    setHint() {},
    snap: new SnapEngine(),
  };
}

function event(pos: Vec2): ToolPointerEvent {
  return {
    world: pos,
    worldRaw: pos,
    screen: pos,
    snap: null,
    button: 0,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
  };
}
const click = (t: DimensionTool, c: ToolContext, p: Vec2) => t.onPointerDown(event(p), c);
const move = (t: DimensionTool, c: ToolContext, p: Vec2) => t.onPointerMove(event(p), c);

const geoOf = (doc: CADDocument): Geo => {
  const m = new Map(doc.entities.map((e) => [e.id, e]));
  return (id) => m.get(id);
};

/**
 * Where the dimension's anchor ON `entityId` actually lands, read back out of
 * the layout — with NO viewport scale, so the drafting furniture (the witness
 * line's gap off the geometry, its overshoot past the dimension line) is off
 * and a segment's first end is the anchor itself. `witnessGapAndOvershoot`
 * below covers that furniture on its own.
 *
 * Read back out of the rendered layout — the extension lines are `[points[0], …]` then
 * `[points[1], …]`, so the anchor is that segment's first end.
 *
 * Read by INDEX of the matching ref rather than assuming the interesting
 * anchor is points[0]: a first draft asserted on `segments[0][0]` and was
 * silently reading the OTHER end of the dimension, which passed for reasons
 * that had nothing to do with edge anchors.
 */
function anchorPosOn(doc: CADDocument, dim: (typeof doc.dimensions)[number], entityId: string): Vec2 {
  const i = dim.points.findIndex((p) => p.entityId === entityId);
  if (i < 0) throw new Error(`dimension does not reference ${entityId}`);
  const layout = dimensionLayout(dim, geoOf(doc), "mm");
  if (!layout) throw new Error("no layout");
  return layout.segments[i][0];
}

// ---------------------------------------------------------------------------
// The key encoding

describe("edge anchor keys", () => {
  it("spells the midpoint the legacy way, so old files need no migration", () => {
    expect(edgeAnchorKey("mid_b", 0.5)).toBe("mid_b");
    expect(edgeAnchorKey("mid", 0.5)).toBe("mid");
    // ...and a plain key still reads back as the midpoint.
    expect(edgeAnchorT("mid_b")).toBe(0.5);
  });

  it("round-trips a fraction and strips back to the bare edge key", () => {
    const k = edgeAnchorKey("mid_b", 0.25);
    expect(k).toBe("mid_b@0.25");
    expect(edgeAnchorT(k)).toBeCloseTo(0.25);
    expect(baseAnchorKey(k)).toBe("mid_b");
    expect(isEdgeAnchorKey(k)).toBe(true);
  });

  it("clamps out of range and never treats a real DOF point as slidable", () => {
    expect(edgeAnchorT(edgeAnchorKey("mid", 1.4))).toBe(1);
    expect(edgeAnchorT(edgeAnchorKey("mid", -3))).toBe(0);
    // A line's endpoints and a rect's corners are the geometry being measured.
    expect(isEdgeAnchorKey("a")).toBe(false);
    expect(isEdgeAnchorKey("bl")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Resolving to a world point

describe("resolving an edge anchor", () => {
  /** Extension line 1 starts AT the anchor, so its first point is the anchor. */
  function anchorOf(doc: CADDocument, key: string, rect: RectEntity, other: Vec2): Vec2 {
    const dot = doc.add(new CircleEntity(other, 1));
    const dim = makeDimension("vertical", {
      points: [
        { entityId: rect.id, key },
        { entityId: dot.id, key: "c" },
      ],
      value: 0,
      offset: 20,
    });
    const layout = dimensionLayout(dim, geoOf(doc), "mm");
    if (!layout) throw new Error("no layout");
    return layout.segments[0][0];
  }

  it("a plain mid_b still lands on the midpoint", () => {
    const doc = new CADDocument({ width: 300, height: 200 });
    // bl (20,20) → tr (120,80): bottom edge runs (20,20) → (120,20).
    const r = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 120, y: 80 })) as RectEntity;
    const p = anchorOf(doc, "mid_b", r, { x: 200, y: 150 });
    expect(p.x).toBeCloseTo(70);
    expect(p.y).toBeCloseTo(20);
  });

  it("mid_b@0.25 lands a quarter of the way along that same edge", () => {
    const doc = new CADDocument({ width: 300, height: 200 });
    const r = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 120, y: 80 })) as RectEntity;
    const p = anchorOf(doc, "mid_b@0.25", r, { x: 200, y: 150 });
    expect(p.x).toBeCloseTo(45); // 20 + 0.25 * 100
    expect(p.y).toBeCloseTo(20);
  });

  it("follows the geometry — the fraction is parametric, not a frozen position", () => {
    const doc = new CADDocument({ width: 300, height: 200 });
    const r = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 120, y: 80 })) as RectEntity;
    r.translate({ x: 30, y: 10 });
    const p = anchorOf(doc, "mid_b@0.25", r, { x: 200, y: 150 });
    expect(p.x).toBeCloseTo(75);
    expect(p.y).toBeCloseTo(30);
  });
});

// ---------------------------------------------------------------------------
// The reported bug

describe("two dimensions to the same edge (the reported bug)", () => {
  /**
   * A tall rectangle plus two circles at different heights, each dimensioned
   * horizontally to the rectangle's LEFT edge. Both clicks land on that edge,
   * well clear of its corners and its midpoint — the gesture that used to
   * collapse onto `mid_l`.
   */
  function twoDimsToLeftEdge(): { doc: CADDocument; rectId: string } {
    const doc = new CADDocument({ width: 400, height: 400 });
    const r = doc.add(new RectEntity({ x: 50, y: 20 }, { x: 250, y: 320 })); // left edge x=50, y 20→320
    const c1 = doc.add(new CircleEntity({ x: 150, y: 80 }, 10));
    const c2 = doc.add(new CircleEntity({ x: 150, y: 260 }, 10));
    const ctx = makeCtx(doc);

    for (const [c, edgeY] of [
      [c1, 80],
      [c2, 260],
    ] as const) {
      const tool = new DimensionTool();
      click(tool, ctx, { x: c.center.x, y: c.center.y }); // the circle's centre
      click(tool, ctx, { x: 50, y: edgeY }); // the left edge, at the circle's height
      move(tool, ctx, { x: 100, y: edgeY - 40 });
      click(tool, ctx, { x: 100, y: edgeY - 40 }); // place
    }
    return { doc, rectId: r.id };
  }

  it("lands each dimension on its own foot on the edge, never a shared midpoint", () => {
    const { doc, rectId } = twoDimsToLeftEdge();
    expect(doc.dimensions).toHaveLength(2);

    // A point and an edge is a perpendicular distance, so the edge is named as
    // a whole edge and the dimension lands at the FOOT of the perpendicular —
    // a different place for each circle, by construction.
    expect(doc.dimensions.every((d) => d.type === "point-line-distance")).toBe(true);
    expect(
      doc.dimensions.every((d) => d.entities[0] === `${rectId}${SEGMENT_SEP}mid_l`),
    ).toBe(true);
    // The two feet: on the left edge (x=50), at each circle's own height, and
    // NEITHER at that edge's midpoint (y=170), which is where both used to sit.
    const feet = doc.dimensions.map(
      (d) => dimensionLayout(d, geoOf(doc), "mm")!.arrows[1].tip,
    );
    expect(feet[0].x).toBeCloseTo(50);
    expect(feet[1].x).toBeCloseTo(50);
    expect(feet[0].y).toBeCloseTo(80);
    expect(feet[1].y).toBeCloseTo(260);
  });

  it("still refuses a second DRIVING dimension of the same measurement", () => {
    // Two dims measuring rect-left-edge → the same circle, anchored at different
    // points along that edge, are one measurement: only one may drive it.
    const doc = new CADDocument({ width: 400, height: 400 });
    const r = doc.add(new RectEntity({ x: 50, y: 20 }, { x: 250, y: 320 }));
    const c = doc.add(new CircleEntity({ x: 150, y: 80 }, 10));
    const mk = (key: string) =>
      makeDimension("horizontal", {
        points: [
          { entityId: r.id, key },
          { entityId: c.id, key: "c" },
        ],
        value: 100,
        offset: 20,
      });
    const first = mk("mid_l@0.2");
    doc.addDimension(first);
    expect(findDrivingDuplicate(mk("mid_l@0.8"), doc.dimensions)).toBe(first);
    // A different measurement is still not a duplicate.
    expect(findDrivingDuplicate(mk("mid_r@0.8"), doc.dimensions)).toBe(null);
  });
});

describe("dimensioning to a line's body", () => {
  it("anchors where the line was clicked instead of snapping to its midpoint", () => {
    const doc = new CADDocument({ width: 300, height: 300 });
    const l = doc.add(new LineEntity({ x: 20, y: 200 }, { x: 220, y: 200 })) as LineEntity;
    const c = doc.add(new CircleEntity({ x: 60, y: 60 }, 8));
    const ctx = makeCtx(doc);
    const tool = new DimensionTool();

    click(tool, ctx, { x: c.center.x, y: c.center.y });
    click(tool, ctx, { x: 60, y: 200 }); // on the line, 60 units left of its midpoint
    move(tool, ctx, { x: 30, y: 130 });
    click(tool, ctx, { x: 30, y: 130 });

    expect(doc.dimensions).toHaveLength(1);
    const d = doc.dimensions[0];
    expect(d.type).toBe("point-line-distance");
    expect(d.entities).toEqual([l.id]);
    // The foot of the perpendicular from the circle's centre (60,60) onto the
    // horizontal line — x=60, NOT the line's midpoint at x=120.
    const foot = dimensionLayout(d, geoOf(doc), "mm")!.arrows[1].tip;
    expect(foot.x).toBeCloseTo(60);
    expect(foot.y).toBeCloseTo(200);
  });
});

// ---------------------------------------------------------------------------
// Sliding on drag

describe("sliding an edge anchor by dragging the dimension", () => {
  function verticalDimToBottomEdge(): { doc: CADDocument; geo: Geo; dimId: string } {
    const doc = new CADDocument({ width: 400, height: 400 });
    // Bottom edge (20,20) → (220,20) is HORIZONTAL; a vertical dim measures Δy,
    // so sliding along x cannot change what it reports.
    const r = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 220, y: 120 }));
    const c = doc.add(new CircleEntity({ x: 120, y: 300 }, 10));
    const dim = makeDimension("vertical", {
      points: [
        { entityId: r.id, key: "mid_b" },
        { entityId: c.id, key: "c" },
      ],
      value: 280,
      offset: 40,
    });
    doc.addDimension(dim);
    return { doc, geo: geoOf(doc), dimId: dim.id };
  }

  it("slides along the free axis and leaves the measured value untouched", () => {
    const { doc, geo, dimId } = verticalDimToBottomEdge();
    const dim = doc.dimensions.find((d) => d.id === dimId)!;
    const before = dimensionMeasure(dim, geo)!;

    dragDimensionTo(dim, geo, { x: 60, y: 160 });

    const anchor = dim.points[0];
    expect(anchor.key).not.toBe("mid_b");
    const p = anchorPosOn(doc, dim, anchor.entityId);
    expect(p.x).toBeCloseTo(60); // followed the cursor along the edge
    expect(p.y).toBeCloseTo(20); // still ON the edge
    expect(dimensionMeasure(dim, geo)!).toBeCloseTo(before); // and measures the same
  });

  it("clamps to the edge's own extent rather than running off the end", () => {
    const { doc, geo, dimId } = verticalDimToBottomEdge();
    const dim = doc.dimensions.find((d) => d.id === dimId)!;
    dragDimensionTo(dim, geo, { x: -500, y: 160 });
    const p = anchorPosOn(doc, dim, dim.points[0].entityId);
    expect(p.x).toBeCloseTo(20); // the edge's own left end
  });

  it("does NOT slide an anchor whose edge runs along the measured direction", () => {
    // A vertical dim reports Δy; the LEFT edge is vertical, so sliding along it
    // would silently re-measure — on a driving dim, that edits the part.
    const doc = new CADDocument({ width: 400, height: 400 });
    const r = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 220, y: 120 }));
    const c = doc.add(new CircleEntity({ x: 300, y: 300 }, 10));
    const dim = makeDimension("vertical", {
      points: [
        { entityId: r.id, key: "mid_l" },
        { entityId: c.id, key: "c" },
      ],
      value: 0,
      offset: 40,
    });
    doc.addDimension(dim);
    const geo = geoOf(doc);
    expect(dimensionSlideAnchors(dim, geo, { x: 100, y: 30 })).toBe(null);
  });

  it("never slides an anchor that is a real DOF point", () => {
    const doc = new CADDocument({ width: 400, height: 400 });
    const l = doc.add(new LineEntity({ x: 20, y: 20 }, { x: 220, y: 20 })) as LineEntity;
    const dim = makeDimension("horizontal", {
      points: [
        { entityId: l.id, key: "a" },
        { entityId: l.id, key: "b" },
      ],
      value: 200,
      offset: 30,
    });
    doc.addDimension(dim);
    expect(dimensionSlideAnchors(dim, geoOf(doc), { x: 100, y: 90 })).toBe(null);
  });

  it("leaves an aligned (distance) dimension alone — every direction re-measures it", () => {
    const doc = new CADDocument({ width: 400, height: 400 });
    const r = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 220, y: 120 }));
    const c = doc.add(new CircleEntity({ x: 300, y: 300 }, 10));
    const dim = makeDimension("distance", {
      points: [
        { entityId: r.id, key: "mid_b" },
        { entityId: c.id, key: "c" },
      ],
      value: 0,
      offset: 40,
    });
    doc.addDimension(dim);
    expect(dimensionSlideAnchors(dim, geoOf(doc), { x: 60, y: 160 })).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// It still drives, and it still saves

describe("an off-midpoint anchor is a first-class dimension", () => {
  it("drives the geometry through the solver", () => {
    const doc = new CADDocument({ width: 400, height: 400 });
    const r = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 220, y: 120 }));
    const c = doc.add(new CircleEntity({ x: 120, y: 300 }, 10)) as CircleEntity;
    doc.addDimension(
      makeDimension("vertical", {
        points: [
          { entityId: r.id, key: "mid_b@0.13" },
          { entityId: c.id, key: "c" },
        ],
        value: 200,
        offset: 40,
      }),
    );
    const before = dimensionMeasure(doc.dimensions[0], geoOf(doc))!;
    expect(before).toBeCloseTo(280); // the sketch as drawn
    const res = solve(doc);
    expect(res.converged).toBe(true);
    // The solver is free to move either side, so assert the MEASUREMENT, not
    // which piece of geometry gave way.
    expect(dimensionMeasure(doc.dimensions[0], geoOf(doc))!).toBeCloseTo(200, 2);
    expect(c.center.y).not.toBeCloseTo(300); // ...and something did move
  });

  it("survives a snapshot/restore round trip", () => {
    const doc = new CADDocument({ width: 400, height: 400 });
    const r = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 220, y: 120 }));
    const c = doc.add(new CircleEntity({ x: 120, y: 300 }, 10));
    doc.addDimension(
      makeDimension("vertical", {
        points: [
          { entityId: r.id, key: "mid_b@0.13" },
          { entityId: c.id, key: "c" },
        ],
        value: 200,
        offset: 40,
      }),
    );
    const snap = doc.snapshot();
    doc.dimensions[0].points[0].key = "mid_b";
    doc.restore(snap);
    expect(doc.dimensions[0].points[0].key).toBe("mid_b@0.13");
  });
});

// ---------------------------------------------------------------------------
// The same rule, for every other kind of object

describe("anchoring anywhere on any object", () => {
  /** Click `at`, then `then`, then place — and report the resulting dimension. */
  function twoClickDim(doc: CADDocument, at: Vec2, then: Vec2, place: Vec2) {
    const ctx = makeCtx(doc);
    const tool = new DimensionTool();
    click(tool, ctx, at);
    click(tool, ctx, then);
    move(tool, ctx, place);
    click(tool, ctx, place);
    return doc.dimensions;
  }

  it("a polyline segment takes an anchor where it was clicked", () => {
    const doc = new CADDocument({ width: 400, height: 400 });
    // An L: (20,20) → (220,20) → (220,180). The first segment is horizontal.
    const pl = doc.add(
      new PolylineEntity([
        { x: 20, y: 20 },
        { x: 220, y: 20 },
        { x: 220, y: 180 },
      ]),
    ) as PolylineEntity;
    const c = doc.add(new CircleEntity({ x: 100, y: 300 }, 5));

    const dims = twoClickDim(doc, { x: 60, y: 20 }, c.center, { x: 40, y: 160 });
    expect(dims).toHaveLength(1);
    // Named by the STABLE id of the segment's start vertex, so the reference
    // survives a vertex inserted ahead of it.
    expect(dims[0].type).toBe("point-line-distance");
    expect(dims[0].entities).toEqual([`${pl.id}${SEGMENT_SEP}mid_${pl.vertexIds[0]}`]);
    // Resolving that ref at all is the test: a segment ref the layout cannot
    // read draws NOTHING, silently.
    const foot = dimensionLayout(dims[0], geoOf(doc), "mm")!.arrows[1].tip;
    expect(foot.x).toBeCloseTo(100); // the perpendicular foot from (100,300)
    expect(foot.y).toBeCloseTo(20);
  });

  it("a polyline anchor follows its segment, not a frozen coordinate", () => {
    const doc = new CADDocument({ width: 400, height: 400 });
    const pl = doc.add(
      new PolylineEntity([
        { x: 20, y: 20 },
        { x: 220, y: 20 },
        { x: 220, y: 180 },
      ]),
    ) as PolylineEntity;
    const c = doc.add(new CircleEntity({ x: 100, y: 300 }, 5));
    const dims = twoClickDim(doc, { x: 60, y: 20 }, c.center, { x: 40, y: 160 });
    const before = dimensionMeasure(dims[0], geoOf(doc))!;
    expect(before).toBeCloseTo(280); // (100,300) down to the segment at y=20
    pl.translate({ x: 15, y: 25 });
    // The reference is parametric, so the measurement follows the segment.
    expect(dimensionMeasure(dims[0], geoOf(doc))!).toBeCloseTo(255);
  });

  it("a Bézier takes a point ON the curve, not one of its control points", () => {
    const doc = new CADDocument({ width: 400, height: 400 });
    // A symmetric arch; its two middle control points are well off the curve.
    const bz = doc.add(
      new BezierEntity({ x: 20, y: 20 }, { x: 20, y: 220 }, { x: 220, y: 220 }, { x: 220, y: 20 }),
    ) as BezierEntity;
    const c = doc.add(new CircleEntity({ x: 120, y: 300 }, 5));
    // t = 0.25, deliberately NOT the apex: a picker that ignored the click and
    // answered 0.5 would be indistinguishable from a correct one at the apex.
    const on = bezierPointAt(bz.p0, bz.p1, bz.p2, bz.p3, 0.25);

    const dims = twoClickDim(doc, on, c.center, { x: 300, y: 240 });
    expect(dims).toHaveLength(1);
    const anchor = dims[0].points.find((p) => p.entityId === bz.id)!;
    const t = curveAnchorT(anchor.key);
    expect(t, `expected a curve@ anchor, got ${anchor.key}`).not.toBe(null);
    expect(t!).toBeCloseTo(0.25, 2);
    const p = anchorPosOn(doc, dims[0], bz.id);
    expect(p.x).toBeCloseTo(on.x, 1);
    expect(p.y).toBeCloseTo(on.y, 1);
  });

  it("clicking one rectangle side twice dimensions THAT side, end to end", () => {
    const doc = new CADDocument({ width: 400, height: 400 });
    const r = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 220, y: 120 }));
    // Two clicks on the bottom edge, both clear of the corners and the midpoint.
    const dims = twoClickDim(doc, { x: 60, y: 20 }, { x: 180, y: 20 }, { x: 120, y: -20 });
    expect(dims).toHaveLength(1);
    expect(dims[0].value).toBeCloseTo(200); // the full width, not the 120 clicked
    // Witnessed at the edge's real corners, so the dimension can drive them.
    expect(dims[0].points.map((p) => p.key).sort()).toEqual(["bl", "br"]);
    expect(dims[0].points.every((p) => p.entityId === r.id)).toBe(true);
  });

  it("two DIFFERENT sides of one rectangle give the ANGLE between them", () => {
    const doc = new CADDocument({ width: 400, height: 400 });
    const r = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 220, y: 120 }));
    // Bottom edge, then LEFT edge. Two edges that are not parallel have an
    // angle between them and no canonical distance — Fusion, SolidWorks and
    // AutoCAD's DIMANGULAR all answer this pick with the angle.
    const dims = twoClickDim(doc, { x: 60, y: 20 }, { x: 20, y: 90 }, { x: 120, y: 60 });
    expect(dims).toHaveLength(1);
    expect(dims[0].type).toBe("angle");
    expect(dims[0].value).toBeCloseTo(Math.PI / 2, 4); // radians
    expect(dims[0].entities.sort()).toEqual([
      `${r.id}${SEGMENT_SEP}mid_b`,
      `${r.id}${SEGMENT_SEP}mid_l`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// A point measured to an edge is measured ACROSS it

describe("point-to-edge dimensions measure the perpendicular", () => {
  /** Click `at`, then `then`, then place at `place`; return the dimension. */
  function dim(doc: CADDocument, at: Vec2, then: Vec2, place: Vec2) {
    const ctx = makeCtx(doc);
    const tool = new DimensionTool();
    click(tool, ctx, at);
    click(tool, ctx, then);
    move(tool, ctx, place);
    click(tool, ctx, place);
    return doc.dimensions[doc.dimensions.length - 1];
  }

  it("measures the perpendicular drop to a horizontal line, whatever the cursor says", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const c = doc.add(new CircleEntity({ x: 30, y: 20 }, 5)) as CircleEntity;
    const l = doc.add(new LineEntity({ x: 0, y: 60 }, { x: 100, y: 60 }));

    // Placed straight above, which chooseLinearType would read as "horizontal"
    // — i.e. Δx, the gap between the circle and WHEREVER ON THE LINE was
    // clicked. That number is not a property of the geometry: click the line 10
    // further along and it changes by 10 with nothing having moved.
    const d = dim(doc, c.center, { x: 25, y: 60 }, { x: 28, y: 110 });
    expect(d.type).toBe("point-line-distance");
    expect(d.value).toBeCloseTo(40, 3); // the perpendicular drop
    expect(d.points.map((p) => p.key)).toEqual(["c"]);
    expect(d.entities).toEqual([l.id]);
  });

  it("measures the perpendicular to a DIAGONAL line — the case Δx and Δy both get wrong", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const c = doc.add(new CircleEntity({ x: 20, y: 90 }, 5)) as CircleEntity;
    doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 100 }));

    // Perpendicular from (20,90) to y = x is |90 − 20| / √2 = 49.497.
    const d = dim(doc, c.center, { x: 30, y: 30 }, { x: 25, y: 140 });
    expect(d.type).toBe("point-line-distance");
    expect(d.value).toBeCloseTo(70 / Math.SQRT2, 3);
  });

  it("draws as ONE straight run from the point to its foot, arrows on both", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const c = doc.add(new CircleEntity({ x: 20, y: 90 }, 5)) as CircleEntity;
    doc.add(new LineEntity({ x: 0, y: 0 }, { x: 100, y: 100 }));
    const d = dim(doc, c.center, { x: 30, y: 30 }, { x: 25, y: 140 });

    const layout = dimensionLayout(d, geoOf(doc), "mm")!;
    // The three-segment shape — witness, offset shaft, witness — is what this
    // type exists to replace. One segment, unless a label leader is needed.
    const shaft = layout.segments[0];
    expect(shaft[0].x).toBeCloseTo(20); // starts AT the point
    expect(shaft[0].y).toBeCloseTo(90);
    expect(shaft[1].x).toBeCloseTo(55); // ...and ends at the foot on y = x
    expect(shaft[1].y).toBeCloseTo(55);
    // Both arrows sit on those same two ends: nothing is offset sideways.
    expect(layout.arrows).toHaveLength(2);
    expect(layout.arrows[0].tip.x).toBeCloseTo(20);
    expect(layout.arrows[0].tip.y).toBeCloseTo(90);
    expect(layout.arrows[1].tip.x).toBeCloseTo(55);
    expect(layout.arrows[1].tip.y).toBeCloseTo(55);
  });

  it("drives the geometry, and keeps driving after the line moves", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const c = doc.add(new CircleEntity({ x: 30, y: 20 }, 5)) as CircleEntity;
    doc.add(new LineEntity({ x: 0, y: 60 }, { x: 100, y: 60 }));
    const d = dim(doc, c.center, { x: 25, y: 60 }, { x: 28, y: 110 });
    d.driving = true;
    d.value = 25;
    solve(doc);
    expect(dimensionMeasure(doc.dimensions[0], geoOf(doc))!).toBeCloseTo(25, 2);
  });

  it("still leaves two EDGES alone — parallel ones become a gap dimension", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    doc.add(new LineEntity({ x: 0, y: 20 }, { x: 100, y: 20 }));
    doc.add(new LineEntity({ x: 0, y: 80 }, { x: 100, y: 80 }));
    const d = dim(doc, { x: 25, y: 20 }, { x: 25, y: 80 }, { x: 25, y: 50 });
    expect(d.type).toBe("line-distance");
    expect(d.value).toBeCloseTo(60, 2);
  });
});

// ---------------------------------------------------------------------------
// Drafting furniture: witness-line gaps, and arrows that flip when squeezed

describe("witness lines and arrowheads follow the drafting standard", () => {
  /** A 60mm horizontal dim between two line endpoints, offset 20mm below. */
  function horizontalDim(doc: CADDocument, span: number) {
    const l = doc.add(new LineEntity({ x: 20, y: 100 }, { x: 20 + span, y: 100 }));
    return makeDimension("horizontal", {
      points: [
        { entityId: l.id, key: "a" },
        { entityId: l.id, key: "b" },
      ],
      value: span,
      offset: -20,
    });
  }

  it("starts the witness line off the geometry and runs it past the dimension line", () => {
    const doc = new CADDocument({ width: 300, height: 200 });
    const dim = horizontalDim(doc, 60);
    // 2 px per mm, so the 4px gap is 2mm of world and the 5px overshoot 2.5mm.
    const layout = dimensionLayout(dim, geoOf(doc), "mm", 2)!;
    const [start, end] = layout.segments[0];
    // The measured point is (20,100); the dimension line sits at y = 80.
    expect(start.x).toBeCloseTo(20);
    expect(start.y).toBeCloseTo(98); // 2mm gap OFF the geometry, toward the shaft
    expect(end.y).toBeCloseTo(77.5); // 2.5mm PAST the shaft at y=80
  });

  it("draws the bare segment when there is no viewport scale to size the gap in", () => {
    // Screen-space furniture needs a screen. Headless callers must still get
    // geometry they can measure, not a gap sized off an invented scale.
    const doc = new CADDocument({ width: 300, height: 200 });
    const layout = dimensionLayout(horizontalDim(doc, 60), geoOf(doc), "mm")!;
    expect(layout.segments[0][0].y).toBeCloseTo(100); // right on the geometry
    expect(layout.segments[0][1].y).toBeCloseTo(80); // stops at the shaft
  });

  it("points the arrows outward when the span can hold them", () => {
    const doc = new CADDocument({ width: 300, height: 200 });
    const layout = dimensionLayout(horizontalDim(doc, 60), geoOf(doc), "mm", 2)!;
    // 60mm at 2px/mm is 120px — plenty for two 9px heads.
    expect(layout.arrows[0].dir.x).toBeCloseTo(-1); // at the left end, pointing left
    expect(layout.arrows[1].dir.x).toBeCloseTo(1);
    expect(layout.segments).toHaveLength(3); // two witness lines + the shaft
  });

  it("flips them outside, on stubs, when it cannot", () => {
    const doc = new CADDocument({ width: 300, height: 200 });
    // 2mm at 2px/mm is 4px — the two heads would meet and fill the span.
    const layout = dimensionLayout(horizontalDim(doc, 2), geoOf(doc), "mm", 2)!;
    expect(layout.arrows[0].dir.x).toBeCloseTo(1); // at the left end, pointing IN
    expect(layout.arrows[1].dir.x).toBeCloseTo(-1);
    // ...and the dimension line grew a stub past each end to carry them.
    const stubs = layout.segments.filter(
      ([a, b]) => Math.abs(a.y - 80) < 1e-6 && Math.abs(b.y - 80) < 1e-6,
    );
    expect(stubs.length).toBeGreaterThanOrEqual(3); // the shaft plus two stubs
    const xs = stubs.flatMap(([a, b]) => [a.x, b.x]);
    expect(Math.min(...xs)).toBeLessThan(20); // reaches left of the left end
    expect(Math.max(...xs)).toBeGreaterThan(22); // and right of the right end
  });

  it("flips a gap dimension's arrows too — the narrow gap is exactly when it matters", () => {
    const doc = new CADDocument({ width: 300, height: 200 });
    const a = doc.add(new LineEntity({ x: 20, y: 100 }, { x: 120, y: 100 }));
    const b = doc.add(new LineEntity({ x: 20, y: 102 }, { x: 120, y: 102 }));
    const dim = makeDimension("line-distance", {
      entities: [a.id, b.id],
      anchors: [0.5, 0.5],
      value: 2,
      offset: 0,
    });
    const layout = dimensionLayout(dim, geoOf(doc), "mm", 2)!;
    expect(layout.arrows[0].dir.y).toBeCloseTo(1); // pointing across the gap, from outside
    expect(layout.arrows[1].dir.y).toBeCloseTo(-1);
  });
});
