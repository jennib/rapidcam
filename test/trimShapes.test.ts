import { describe, it, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import {
  LineEntity, CircleEntity, ArcEntity, PolylineEntity, RectEntity, BezierEntity,
} from "../src/model/entities";
import { TrimTool } from "../src/tools/trimTool";
import { ToolContext, ToolPointerEvent } from "../src/tools/tool";
import { evalBezier, splitBezier } from "../src/core/geom";
import { Vec2 } from "../src/core/vec2";

function makeCtx(doc: CADDocument): ToolContext {
  return {
    doc,
    view: { scale: 1 } as ToolContext["view"],
    requestRender() {},
    solve() {},
    pushHistory() {},
    openDimEditor() {},
    currentDof: () => 0,
    openValueEditor() {},
    closeValueEditor() {},
  };
}

function click(doc: CADDocument, pos: Vec2): void {
  const e: ToolPointerEvent = {
    world: pos, worldRaw: pos, screen: pos, snap: null,
    button: 0, shiftKey: false, ctrlKey: false, altKey: false,
  };
  new TrimTool().onPointerDown(e, makeCtx(doc));
}

const lines = (doc: CADDocument) => doc.entities.filter((e): e is LineEntity => e instanceof LineEntity);
const polys = (doc: CADDocument) => doc.entities.filter((e): e is PolylineEntity => e instanceof PolylineEntity);

describe("whole-entity erase when nothing bounds the clicked piece", () => {
  it("erases a slot end cap swallowed by a concentric circle (keyhole)", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    // Right end cap of a slot at (40,0): arc r=10 from -90° to 90°.
    const cap = new ArcEntity({ x: 40, y: 0 }, 10, -Math.PI / 2, Math.PI / 2);
    doc.add(cap);
    doc.add(new CircleEntity({ x: 40, y: 0 }, 15)); // concentric, bigger — no intersections
    click(doc, { x: 50, y: 0 }); // cap apex
    expect(doc.entities.includes(cap)).toBe(false);
    expect(doc.entities.find(e => e instanceof CircleEntity)).toBeDefined();
  });

  it("erases a lone line with no intersections", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const l = new LineEntity({ x: 0, y: 0 }, { x: 50, y: 0 });
    doc.add(l);
    click(doc, { x: 25, y: 0 });
    expect(doc.entities.includes(l)).toBe(false);
  });

  it("erases an uncrossed bezier", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const lone = new BezierEntity({ x: 0, y: 50 }, { x: 10, y: 70 }, { x: 30, y: 70 }, { x: 40, y: 50 });
    doc.add(lone);
    click(doc, { x: 20, y: 65 });
    expect(doc.entities.includes(lone)).toBe(false);
  });
});

describe("splitBezier", () => {
  it("both halves trace the original curve exactly", () => {
    const p0 = { x: 0, y: 0 }, p1 = { x: 10, y: 20 }, p2 = { x: 30, y: 20 }, p3 = { x: 40, y: 0 };
    const t = 0.3;
    const { left, right } = splitBezier(p0, p1, p2, p3, t);
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      const l = evalBezier(left[0], left[1], left[2], left[3], u);
      const ol = evalBezier(p0, p1, p2, p3, t * u);
      expect(l.x).toBeCloseTo(ol.x, 9);
      expect(l.y).toBeCloseTo(ol.y, 9);
      const r = evalBezier(right[0], right[1], right[2], right[3], u);
      const or_ = evalBezier(p0, p1, p2, p3, t + (1 - t) * u);
      expect(r.x).toBeCloseTo(or_.x, 9);
      expect(r.y).toBeCloseTo(or_.y, 9);
    }
  });
});

describe("trimming beziers", () => {
  // Symmetric arch from (0,0) to (40,0), apex (20,15) at t=0.5.
  const arch = () => new BezierEntity({ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 30, y: 20 }, { x: 40, y: 0 });
  const beziers = (doc: CADDocument) =>
    doc.entities.filter((e): e is BezierEntity => e instanceof BezierEntity);

  it("shortens a bezier to the crossing when clicking past it", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const bez = arch();
    doc.add(bez);
    doc.add(new LineEntity({ x: 20, y: -10 }, { x: 20, y: 30 })); // crosses at t=0.5 → (20,15)
    click(doc, { x: 30.9, y: 11.25 }); // on the curve at t≈0.75 — right of the crossing
    expect(doc.entities.includes(bez)).toBe(true);
    expect(bez.p0.x).toBeCloseTo(0);
    expect(bez.p3.x).toBeCloseTo(20, 3); // new end sits on the cutter line
    expect(bez.p3.y).toBeCloseTo(15, 3);
  });

  it("splits a bezier crossed twice into two exact sub-curves", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    doc.add(arch());
    doc.add(new LineEntity({ x: 12, y: -10 }, { x: 12, y: 30 }));
    doc.add(new LineEntity({ x: 28, y: -10 }, { x: 28, y: 30 }));
    click(doc, { x: 20, y: 15 }); // apex, between the crossings
    const bs = beziers(doc);
    expect(bs.length).toBe(2);
    const sorted = bs.sort((a, b) => a.p0.x - b.p0.x);
    expect(sorted[0].p0.x).toBeCloseTo(0);
    expect(sorted[0].p3.x).toBeCloseTo(12, 3);
    expect(sorted[1].p0.x).toBeCloseTo(28, 3);
    expect(sorted[1].p3.x).toBeCloseTo(40);
    expect(sorted[1].p3.y).toBeCloseTo(0);
  });

  it("trims a bezier against a circle", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const bez = arch();
    doc.add(bez);
    doc.add(new CircleEntity({ x: 40, y: 0 }, 10)); // swallows the tail of the arch
    click(doc, { x: 38, y: 1 }); // near the p3 end, inside the circle
    expect(doc.entities.includes(bez)).toBe(true);
    // New end lands on the circle.
    const d = Math.hypot(bez.p3.x - 40, bez.p3.y - 0);
    expect(d).toBeCloseTo(10, 3);
  });
});

describe("polylines as cutting geometry", () => {
  it("splits a line where a closed polyline (triangle) crosses it", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const l = new LineEntity({ x: -20, y: 5 }, { x: 60, y: 5 });
    doc.add(l);
    doc.add(new PolylineEntity([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 20, y: 30 }], true));
    click(doc, { x: 20, y: 5 }); // inside the triangle
    const ls = lines(doc);
    expect(ls.length).toBe(2);
    const xs = ls.flatMap(e => [e.a.x, e.b.x]).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(-20);
    expect(xs[3]).toBeCloseTo(60);
    // The middle endpoints sit on the triangle's slanted edges at y=5.
    expect(xs[1]).toBeGreaterThan(0);
    expect(xs[2]).toBeLessThan(40);
  });

  it("trims a circle span inside a rectangle entity", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    doc.add(new CircleEntity({ x: 0, y: 0 }, 10));
    doc.add(new RectEntity({ x: 5, y: -20 }, { x: 40, y: 20 }));
    click(doc, { x: 10, y: 0 }); // circle's right side, inside the rect
    expect(doc.entities.find(e => e instanceof CircleEntity)).toBeUndefined();
    const arc = doc.entities.find(e => e instanceof ArcEntity) as ArcEntity;
    expect(arc).toBeDefined();
    // Removed span is between the crossings with the rect's left edge (x=5).
    expect(arc.startPoint.x).toBeCloseTo(5);
    expect(arc.endPoint.x).toBeCloseTo(5);
  });
});

describe("trimming polylines", () => {
  it("splits an open polyline crossed twice into two pieces", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    // Horizontal 3-segment path 0→60 at y=0.
    doc.add(new PolylineEntity([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 40, y: 0 }, { x: 60, y: 0 }], false));
    doc.add(new LineEntity({ x: 10, y: -10 }, { x: 10, y: 10 }));
    doc.add(new LineEntity({ x: 50, y: -10 }, { x: 50, y: 10 }));
    click(doc, { x: 30, y: 0 }); // between the crossings
    const pieces = [...polys(doc), ...lines(doc).filter(l => Math.abs(l.a.y) < 1 && Math.abs(l.b.y) < 1)];
    // Two kept pieces: 0→10 (line, 2 pts) and 50→60 (line, 2 pts)
    const kept = doc.entities.filter(e =>
      (e instanceof PolylineEntity || e instanceof LineEntity));
    const horizontal = kept.filter(e => {
      if (e instanceof LineEntity) return Math.abs(e.a.y) < 1e-6 && Math.abs(e.b.y) < 1e-6;
      return false;
    }) as LineEntity[];
    expect(horizontal.length).toBe(2);
    const spans = horizontal.map(l => [Math.min(l.a.x, l.b.x), Math.max(l.a.x, l.b.x)]).sort((a, b) => a[0] - b[0]);
    expect(spans[0][0]).toBeCloseTo(0);
    expect(spans[0][1]).toBeCloseTo(10);
    expect(spans[1][0]).toBeCloseTo(50);
    expect(spans[1][1]).toBeCloseTo(60);
    expect(pieces.length).toBeGreaterThan(0);
  });

  it("keeps interior vertices when shortening an open polyline from one end", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    // L-shaped path: (0,0)→(40,0)→(40,40)
    const pl = new PolylineEntity([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }], false);
    doc.add(pl);
    doc.add(new LineEntity({ x: 30, y: -10 }, { x: 30, y: 10 })); // crosses first segment at x=30
    click(doc, { x: 10, y: 0 }); // before the crossing → trim the start
    expect(doc.entities.includes(pl)).toBe(false);
    const kept = polys(doc);
    expect(kept.length).toBe(1);
    const pts = kept[0].points;
    expect(pts.length).toBe(3); // (30,0), (40,0), (40,40)
    expect(pts[0].x).toBeCloseTo(30);
    expect(pts[0].y).toBeCloseTo(0);
    expect(pts[2].y).toBeCloseTo(40);
    expect(kept[0].closed).toBe(false);
  });

  it("opens a closed polyline (square) between two crossings", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const sq = new PolylineEntity(
      [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }], true);
    doc.add(sq);
    // Vertical line crossing bottom (y=0) and top (y=40) edges at x=20.
    doc.add(new LineEntity({ x: 20, y: -10 }, { x: 20, y: 50 }));
    click(doc, { x: 30, y: 0 }); // bottom edge, right of the crossing
    expect(doc.entities.includes(sq)).toBe(false);
    const kept = polys(doc);
    expect(kept.length).toBe(1);
    expect(kept[0].closed).toBe(false);
    // Kept path runs from (20,40) → (0,40) → (0,0) → (20,0): the long way round.
    const pts = kept[0].points;
    expect(pts[0].x).toBeCloseTo(20);
    expect(pts[0].y).toBeCloseTo(40);
    expect(pts[pts.length - 1].x).toBeCloseTo(20);
    expect(pts[pts.length - 1].y).toBeCloseTo(0);
    expect(pts.length).toBe(4);
  });

  it("trims a rectangle entity into an open path", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const rect = new RectEntity({ x: 0, y: 0 }, { x: 40, y: 40 });
    doc.add(rect);
    doc.add(new LineEntity({ x: 20, y: -10 }, { x: 20, y: 50 }));
    click(doc, { x: 30, y: 0 });
    expect(doc.entities.includes(rect)).toBe(false);
    const kept = polys(doc);
    expect(kept.length).toBe(1);
    expect(kept[0].closed).toBe(false);
  });
});
