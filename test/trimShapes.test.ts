import { describe, it, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import {
  LineEntity, CircleEntity, ArcEntity, PolylineEntity, RectEntity, BezierEntity,
} from "../src/model/entities";
import { TrimTool } from "../src/tools/trimTool";
import { ToolContext, ToolPointerEvent } from "../src/tools/tool";
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

  it("erases an uncrossed bezier, leaves a crossed one alone", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const lone = new BezierEntity({ x: 0, y: 50 }, { x: 10, y: 70 }, { x: 30, y: 70 }, { x: 40, y: 50 });
    doc.add(lone);
    click(doc, { x: 20, y: 65 });
    expect(doc.entities.includes(lone)).toBe(false);

    const crossed = new BezierEntity({ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 30, y: 20 }, { x: 40, y: 0 });
    doc.add(crossed);
    doc.add(new LineEntity({ x: 20, y: -10 }, { x: 20, y: 30 }));
    click(doc, { x: 20, y: 15 });
    expect(doc.entities.includes(crossed)).toBe(true); // partial bezier trim unsupported
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
