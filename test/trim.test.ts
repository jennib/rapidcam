import { describe, it, expect } from "vitest";
import { segCircleIntersect, circleCircleIntersect, TAU } from "../src/core/geom";
import { LineEntity, CircleEntity, ArcEntity } from "../src/model/entities";
import { CADDocument } from "../src/model/document";
import { TrimTool } from "../src/tools/trimTool";
import { ToolContext, ToolPointerEvent } from "../src/tools/tool";
import { Vec2 } from "../src/core/vec2";

// --- geometry helpers -------------------------------------------------------

describe("segCircleIntersect", () => {
  it("finds two crossings of a diameter line", () => {
    const hits = segCircleIntersect({ x: -20, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 0 }, 10);
    expect(hits.length).toBe(2);
    const xs = hits.map(h => h.point.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(-10);
    expect(xs[1]).toBeCloseTo(10);
  });

  it("ignores crossings outside the segment", () => {
    const hits = segCircleIntersect({ x: -20, y: 0 }, { x: -15, y: 0 }, { x: 0, y: 0 }, 10);
    expect(hits.length).toBe(0);
  });

  it("returns a single hit for a tangent line", () => {
    const hits = segCircleIntersect({ x: -20, y: 10 }, { x: 20, y: 10 }, { x: 0, y: 0 }, 10);
    expect(hits.length).toBe(1);
    expect(hits[0].point.x).toBeCloseTo(0);
    expect(hits[0].point.y).toBeCloseTo(10);
  });

  it("reports the angle of each hit on the circle", () => {
    const hits = segCircleIntersect({ x: 0, y: -20 }, { x: 0, y: 20 }, { x: 0, y: 0 }, 10);
    const thetas = hits.map(h => h.theta).sort((a, b) => a - b);
    expect(thetas[0]).toBeCloseTo(-Math.PI / 2);
    expect(thetas[1]).toBeCloseTo(Math.PI / 2);
  });
});

describe("circleCircleIntersect", () => {
  it("finds two intersection points of overlapping circles", () => {
    const pts = circleCircleIntersect({ x: 0, y: 0 }, 10, { x: 10, y: 0 }, 10);
    expect(pts.length).toBe(2);
    for (const p of pts) {
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(10);
      expect(Math.hypot(p.x - 10, p.y)).toBeCloseTo(10);
    }
  });

  it("returns one point for externally tangent circles", () => {
    const pts = circleCircleIntersect({ x: 0, y: 0 }, 5, { x: 10, y: 0 }, 5);
    expect(pts.length).toBe(1);
    expect(pts[0].x).toBeCloseTo(5);
    expect(pts[0].y).toBeCloseTo(0);
  });

  it("returns nothing for separate or concentric circles", () => {
    expect(circleCircleIntersect({ x: 0, y: 0 }, 5, { x: 100, y: 0 }, 5).length).toBe(0);
    expect(circleCircleIntersect({ x: 0, y: 0 }, 5, { x: 0, y: 0 }, 3).length).toBe(0);
  });
});

// --- trim tool ---------------------------------------------------------------

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

function click(tool: TrimTool, ctx: ToolContext, pos: Vec2): void {
  const e: ToolPointerEvent = {
    world: pos, worldRaw: pos, screen: pos, snap: null,
    button: 0, shiftKey: false, ctrlKey: false, altKey: false,
  };
  tool.onPointerDown(e, ctx);
}

describe("TrimTool on circles", () => {
  it("trims a circle to an arc between two line crossings", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const circle = new CircleEntity({ x: 0, y: 0 }, 10);
    doc.add(circle);
    // Vertical line through the circle at x=0: crossings at ±π/2.
    doc.add(new LineEntity({ x: 0, y: -20 }, { x: 0, y: 20 }));

    const ctx = makeCtx(doc);
    // Click the right half (angle 0) → remove the span -π/2 → π/2.
    click(new TrimTool(), ctx, { x: 10, y: 0 });

    expect(doc.entities.find(e => e instanceof CircleEntity)).toBeUndefined();
    const arc = doc.entities.find(e => e instanceof ArcEntity) as ArcEntity;
    expect(arc).toBeDefined();
    expect(arc.radius).toBeCloseTo(10);
    // Kept span runs CCW from π/2 around the left side to -π/2 (i.e. 3π/2 normalized).
    const span = ((arc.endAngle - arc.startAngle) % TAU + TAU) % TAU;
    expect(span).toBeCloseTo(Math.PI);
    expect(Math.cos(arc.startAngle)).toBeCloseTo(0);
    expect(arc.startPoint.y).toBeCloseTo(10);
    expect(arc.endPoint.y).toBeCloseTo(-10);
  });

  it("trims a circle against another circle (two-circle case)", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const c1 = new CircleEntity({ x: 0, y: 0 }, 10);
    doc.add(c1);
    doc.add(new CircleEntity({ x: 10, y: 0 }, 10));

    const ctx = makeCtx(doc);
    // Click c1's rightmost point (inside c2) → remove the lens-side span.
    click(new TrimTool(), ctx, { x: 10, y: 0 });

    const arcs = doc.entities.filter(e => e instanceof ArcEntity) as ArcEntity[];
    expect(arcs.length).toBe(1);
    // The cutter circle must survive untouched.
    const survivors = doc.entities.filter(e => e instanceof CircleEntity) as CircleEntity[];
    expect(survivors.length).toBe(1);
    expect(survivors[0].center.x).toBeCloseTo(10);
    // Removed span sits between the two intersections at ±π/3 (cos θ = 5/10).
    const arc = arcs[0];
    expect(arc.startPoint.x).toBeCloseTo(5);
    expect(arc.startPoint.y).toBeCloseTo(Math.sqrt(75));
    expect(arc.endPoint.x).toBeCloseTo(5);
    expect(arc.endPoint.y).toBeCloseTo(-Math.sqrt(75));
  });

  it("does not trim a circle with fewer than two intersections", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    doc.add(new CircleEntity({ x: 0, y: 0 }, 10));
    // Tangent line touches at exactly one point.
    doc.add(new LineEntity({ x: -20, y: 10 }, { x: 20, y: 10 }));

    const ctx = makeCtx(doc);
    click(new TrimTool(), ctx, { x: 10, y: 0 });

    expect(doc.entities.find(e => e instanceof CircleEntity)).toBeDefined();
    expect(doc.entities.find(e => e instanceof ArcEntity)).toBeUndefined();
  });
});

describe("TrimTool on arcs", () => {
  // Half-circle arc on top: CCW from 0 to π, radius 10.
  function arcDoc(): { doc: CADDocument; arc: ArcEntity } {
    const doc = new CADDocument({ width: 200, height: 200 });
    const arc = new ArcEntity({ x: 0, y: 0 }, 10, 0, Math.PI);
    doc.add(arc);
    // Vertical line crossing the arc at π/2 (top).
    doc.add(new LineEntity({ x: 0, y: -20 }, { x: 0, y: 20 }));
    return { doc, arc };
  }

  it("shortens an arc from its start when clicking before the intersection", () => {
    const { doc, arc } = arcDoc();
    // Click near angle ~π/4 (between start 0 and the crossing at π/2).
    click(new TrimTool(), makeCtx(doc), { x: 7.07, y: 7.07 });
    expect(arc.startAngle).toBeCloseTo(Math.PI / 2);
    expect(arc.endAngle).toBeCloseTo(Math.PI);
  });

  it("shortens an arc from its end when clicking after the intersection", () => {
    const { doc, arc } = arcDoc();
    click(new TrimTool(), makeCtx(doc), { x: -7.07, y: 7.07 });
    expect(arc.startAngle).toBeCloseTo(0);
    expect(arc.endAngle).toBeCloseTo(Math.PI / 2);
  });

  it("splits an arc crossed twice into two arcs", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const arc = new ArcEntity({ x: 0, y: 0 }, 10, 0, Math.PI);
    doc.add(arc);
    // Two vertical lines crossing the arc at π/3 and 2π/3.
    doc.add(new LineEntity({ x: 5, y: -20 }, { x: 5, y: 20 }));
    doc.add(new LineEntity({ x: -5, y: -20 }, { x: -5, y: 20 }));

    // Click the top of the arc, between the two crossings.
    click(new TrimTool(), makeCtx(doc), { x: 0, y: 10 });

    const arcs = doc.entities.filter(e => e instanceof ArcEntity) as ArcEntity[];
    expect(arcs.length).toBe(2);
    expect(arc.startAngle).toBeCloseTo(0);
    expect(arc.endAngle).toBeCloseTo(Math.PI / 3);
    const arc2 = arcs.find(a => a !== arc)!;
    expect(arc2.startAngle).toBeCloseTo((2 * Math.PI) / 3);
    expect(arc2.endAngle).toBeCloseTo(Math.PI);
  });
});

describe("TrimTool on lines (circle as cutter)", () => {
  it("splits a line where a circle crosses it", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const line = new LineEntity({ x: -20, y: 0 }, { x: 20, y: 0 });
    doc.add(line);
    doc.add(new CircleEntity({ x: 0, y: 0 }, 10));

    // Click the middle of the line, inside the circle.
    click(new TrimTool(), makeCtx(doc), { x: 0, y: 0 });

    const lines = doc.entities.filter(e => e instanceof LineEntity) as LineEntity[];
    expect(lines.length).toBe(2);
    expect(line.a.x).toBeCloseTo(-20);
    expect(line.b.x).toBeCloseTo(-10);
    const line2 = lines.find(l => l !== line)!;
    expect(line2.a.x).toBeCloseTo(10);
    expect(line2.b.x).toBeCloseTo(20);
  });

  it("shortens a line up to an arc crossing", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const line = new LineEntity({ x: 0, y: 0 }, { x: 20, y: 0 });
    doc.add(line);
    // Arc spanning only the right side (-π/2 → π/2) crosses the line at x=10.
    doc.add(new ArcEntity({ x: 0, y: 0 }, 10, -Math.PI / 2, Math.PI / 2));

    // Click past the crossing → trim from endpoint b.
    click(new TrimTool(), makeCtx(doc), { x: 15, y: 0 });
    expect(line.a.x).toBeCloseTo(0);
    expect(line.b.x).toBeCloseTo(10);
  });

  it("ignores arc cutters whose span does not reach the line", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const line = new LineEntity({ x: 0, y: 0 }, { x: 20, y: 0 });
    doc.add(line);
    // Top-half arc never touches the +x axis.
    doc.add(new ArcEntity({ x: 0, y: 0 }, 10, Math.PI / 4, (3 * Math.PI) / 4));

    click(new TrimTool(), makeCtx(doc), { x: 15, y: 0 });
    // No intersections → nothing happens.
    expect(line.b.x).toBeCloseTo(20);
  });
});
