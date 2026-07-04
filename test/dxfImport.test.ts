import { test, expect } from "vitest";
import { importDxf } from "../src/io/dxfImport";
import {
  LineEntity, CircleEntity, ArcEntity, PolylineEntity, PointEntity,
} from "../src/model/entities";

// ---------------------------------------------------------------------------
// Fixture helpers — build a minimal DXF around an ENTITIES body.
// DXF is alternating group-code / value lines; arrays keep fixtures readable.
// ---------------------------------------------------------------------------

const dxf = (entityTags: (string | number)[], opts: { units?: number; blocks?: (string | number)[] } = {}): string => {
  const lines: (string | number)[] = [];
  if (opts.units !== undefined) {
    lines.push(0, "SECTION", 2, "HEADER", 9, "$INSUNITS", 70, opts.units, 0, "ENDSEC");
  }
  if (opts.blocks) {
    lines.push(0, "SECTION", 2, "BLOCKS", ...opts.blocks, 0, "ENDSEC");
  }
  lines.push(0, "SECTION", 2, "ENTITIES", ...entityTags, 0, "ENDSEC", 0, "EOF");
  return lines.join("\n");
};

const LINE_00_105 = [0, "LINE", 8, "0", 10, 0, 20, 0, 11, 10, 21, 5];

// ---------------------------------------------------------------------------

test("LINE maps to LineEntity with exact endpoints", () => {
  const { entities, warnings } = importDxf(dxf(LINE_00_105, { units: 4 }));
  expect(entities).toHaveLength(1);
  const l = entities[0] as LineEntity;
  expect(l).toBeInstanceOf(LineEntity);
  expect(l.a).toEqual({ x: 0, y: 0 });
  expect(l.b).toEqual({ x: 10, y: 5 });
  expect(warnings).toEqual([]); // explicit mm units → no unit warning
});

test("CIRCLE and POINT map directly", () => {
  const { entities } = importDxf(dxf([
    0, "CIRCLE", 10, 30, 20, 40, 40, 7.5,
    0, "POINT", 10, 1, 20, 2,
  ], { units: 4 }));
  const c = entities[0] as CircleEntity;
  expect(c).toBeInstanceOf(CircleEntity);
  expect(c.center).toEqual({ x: 30, y: 40 });
  expect(c.radius).toBe(7.5);
  const p = entities[1] as PointEntity;
  expect(p).toBeInstanceOf(PointEntity);
  expect(p.pos).toEqual({ x: 1, y: 2 });
});

test("ARC converts degrees to radians, CCW sweep preserved", () => {
  const { entities } = importDxf(dxf([
    0, "ARC", 10, 0, 20, 0, 40, 5, 50, 90, 51, 180,
  ], { units: 4 }));
  const a = entities[0] as ArcEntity;
  expect(a).toBeInstanceOf(ArcEntity);
  expect(a.center).toEqual({ x: 0, y: 0 });
  expect(a.radius).toBe(5);
  expect(a.startAngle).toBeCloseTo(Math.PI / 2, 10);
  expect(a.endAngle).toBeCloseTo(Math.PI, 10);
  // Start/end points follow the document's CCW convention.
  expect(a.startPoint.x).toBeCloseTo(0, 10);
  expect(a.startPoint.y).toBeCloseTo(5, 10);
  expect(a.endPoint.x).toBeCloseTo(-5, 10);
  expect(a.endPoint.y).toBeCloseTo(0, 10);
});

test("closed LWPOLYLINE without bulges stays one closed polyline", () => {
  const { entities } = importDxf(dxf([
    0, "LWPOLYLINE", 90, 4, 70, 1,
    10, 0, 20, 0,
    10, 100, 20, 0,
    10, 100, 20, 50,
    10, 0, 20, 50,
  ], { units: 4 }));
  expect(entities).toHaveLength(1);
  const pl = entities[0] as PolylineEntity;
  expect(pl).toBeInstanceOf(PolylineEntity);
  expect(pl.closed).toBe(true);
  expect(pl.points).toEqual([
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 },
  ]);
});

test("LWPOLYLINE bulge segment becomes a true arc with correct geometry", () => {
  // Open polyline: (0,0) → bulge 1 (CCW semicircle) → (2,0) → straight → (2,5)
  const { entities } = importDxf(dxf([
    0, "LWPOLYLINE", 90, 3, 70, 0,
    10, 0, 20, 0, 42, 1,
    10, 2, 20, 0,
    10, 2, 20, 5,
  ], { units: 4 }));
  expect(entities).toHaveLength(2);
  const arc = entities.find((e) => e instanceof ArcEntity) as ArcEntity;
  const line = entities.find((e) => e instanceof LineEntity) as LineEntity;
  expect(arc).toBeDefined();
  expect(line).toBeDefined();

  // bulge=1 → θ=π (semicircle): center at chord midpoint, r = chord/2.
  expect(arc.center.x).toBeCloseTo(1, 10);
  expect(arc.center.y).toBeCloseTo(0, 10);
  expect(arc.radius).toBeCloseTo(1, 10);
  // CCW from p1 to p2: start angle π (points at (0,0)), end angle 0 → (2,0).
  expect(arc.startPoint.x).toBeCloseTo(0, 10);
  expect(arc.startPoint.y).toBeCloseTo(0, 10);
  expect(arc.endPoint.x).toBeCloseTo(2, 10);
  expect(arc.endPoint.y).toBeCloseTo(0, 10);
  // CCW sweep from π through 3π/2: the arc's midpoint dips below the chord.
  const span = ((arc.endAngle - arc.startAngle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  const midA = arc.startAngle + span / 2;
  expect(arc.center.y + arc.radius * Math.sin(midA)).toBeCloseTo(-1, 10);

  expect(line.a).toEqual({ x: 2, y: 0 });
  expect(line.b).toEqual({ x: 2, y: 5 });
});

test("negative bulge flips the sweep (CW from p1 → stored as CCW from p2)", () => {
  const { entities } = importDxf(dxf([
    0, "LWPOLYLINE", 90, 2, 70, 0,
    10, 0, 20, 0, 42, -1,
    10, 2, 20, 0,
  ], { units: 4 }));
  const arc = entities[0] as ArcEntity;
  expect(arc).toBeInstanceOf(ArcEntity);
  // CW arc from (0,0) to (2,0) bulges up; stored CCW it runs (2,0) → (0,0).
  expect(arc.startPoint.x).toBeCloseTo(2, 10);
  expect(arc.endPoint.x).toBeCloseTo(0, 10);
  const span = ((arc.endAngle - arc.startAngle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  const midA = arc.startAngle + span / 2;
  expect(arc.center.y + arc.radius * Math.sin(midA)).toBeCloseTo(1, 10);
});

test("legacy POLYLINE/VERTEX/SEQEND parses like LWPOLYLINE", () => {
  const { entities } = importDxf(dxf([
    0, "POLYLINE", 66, 1, 70, 1,
    0, "VERTEX", 10, 0, 20, 0,
    0, "VERTEX", 10, 10, 20, 0,
    0, "VERTEX", 10, 10, 20, 10,
    0, "SEQEND",
  ], { units: 4 }));
  expect(entities).toHaveLength(1);
  const pl = entities[0] as PolylineEntity;
  expect(pl.closed).toBe(true);
  expect(pl.points).toHaveLength(3);
});

test("INSERT expands a block with rotation and uniform scale", () => {
  // Block "b" holds a line (0,0)→(10,0) with base point (0,0).
  // Insert at (100,50), scale 2, rotation 90° → line (100,50)→(100,70).
  const { entities } = importDxf(dxf([
    0, "INSERT", 2, "b", 10, 100, 20, 50, 41, 2, 42, 2, 50, 90,
  ], {
    units: 4,
    blocks: [
      0, "BLOCK", 2, "b", 10, 0, 20, 0,
      0, "LINE", 10, 0, 20, 0, 11, 10, 21, 0,
      0, "ENDBLK",
    ],
  }));
  expect(entities).toHaveLength(1);
  const l = entities[0] as LineEntity;
  expect(l.a.x).toBeCloseTo(100, 9);
  expect(l.a.y).toBeCloseTo(50, 9);
  expect(l.b.x).toBeCloseTo(100, 9);
  expect(l.b.y).toBeCloseTo(70, 9);
});

test("INSERT with non-uniform scale is skipped with a warning", () => {
  const { entities, warnings } = importDxf(dxf([
    0, "INSERT", 2, "b", 10, 0, 20, 0, 41, 2, 42, 3,
  ], {
    units: 4,
    blocks: [0, "BLOCK", 2, "b", 10, 0, 20, 0, ...LINE_00_105, 0, "ENDBLK"],
  }));
  expect(entities).toHaveLength(0);
  expect(warnings.some((w) => w.includes("non-uniform"))).toBe(true);
});

test("inch units scale coordinates by 25.4", () => {
  const { entities, warnings } = importDxf(dxf(LINE_00_105, { units: 1 }));
  const l = entities[0] as LineEntity;
  expect(l.b.x).toBeCloseTo(254, 9);
  expect(l.b.y).toBeCloseTo(127, 9);
  expect(warnings).toEqual([]);
  // Arc radii scale too.
  const arcFile = importDxf(dxf([0, "ARC", 10, 1, 20, 0, 40, 2, 50, 0, 51, 90], { units: 1 }));
  const a = arcFile.entities[0] as ArcEntity;
  expect(a.center.x).toBeCloseTo(25.4, 9);
  expect(a.radius).toBeCloseTo(50.8, 9);
});

test("missing units assumes mm and warns", () => {
  const { entities, warnings } = importDxf(dxf(LINE_00_105));
  expect((entities[0] as LineEntity).b.x).toBe(10);
  expect(warnings.some((w) => w.includes("no units"))).toBe(true);
});

test("SPLINE tessellates to a polyline that interpolates its clamped ends", () => {
  // Degree-2 clamped NURBS: ctrl (0,0), (5,10), (10,0); knots [0,0,0,1,1,1].
  const { entities, warnings } = importDxf(dxf([
    0, "SPLINE", 70, 0, 71, 2, 72, 6, 73, 3,
    40, 0, 40, 0, 40, 0, 40, 1, 40, 1, 40, 1,
    10, 0, 20, 0,
    10, 5, 20, 10,
    10, 10, 20, 0,
  ], { units: 4 }));
  const pl = entities[0] as PolylineEntity;
  expect(pl).toBeInstanceOf(PolylineEntity);
  expect(pl.points.length).toBeGreaterThan(10);
  // Clamped ends pass through the first/last control points.
  expect(pl.points[0].x).toBeCloseTo(0, 9);
  expect(pl.points[0].y).toBeCloseTo(0, 9);
  expect(pl.points[pl.points.length - 1].x).toBeCloseTo(10, 9);
  expect(pl.points[pl.points.length - 1].y).toBeCloseTo(0, 9);
  // Curve apex of this parabola is at (5,5).
  const apex = pl.points[Math.floor(pl.points.length / 2)];
  expect(apex.x).toBeCloseTo(5, 1);
  expect(apex.y).toBeCloseTo(5, 1);
  expect(warnings.some((w) => w.includes("spline"))).toBe(true);
});

test("ELLIPSE tessellates to a closed polyline with the right extents", () => {
  // Center (10,0), major axis endpoint (+20,0), ratio 0.5 → 40×20 ellipse.
  const { entities } = importDxf(dxf([
    0, "ELLIPSE", 10, 10, 20, 0, 11, 20, 21, 0, 40, 0.5,
  ], { units: 4 }));
  const pl = entities[0] as PolylineEntity;
  expect(pl).toBeInstanceOf(PolylineEntity);
  expect(pl.closed).toBe(true);
  const xs = pl.points.map((p) => p.x), ys = pl.points.map((p) => p.y);
  expect(Math.max(...xs)).toBeCloseTo(30, 6);
  expect(Math.min(...xs)).toBeCloseTo(-10, 6);
  expect(Math.max(...ys)).toBeCloseTo(10, 1);
  expect(Math.min(...ys)).toBeCloseTo(-10, 1);
});

test("unsupported entities are skipped and summarized in warnings", () => {
  const { entities, warnings } = importDxf(dxf([
    ...LINE_00_105,
    0, "MTEXT", 10, 0, 20, 0, 1, "hello",
    0, "HATCH", 10, 0, 20, 0,
  ], { units: 4 }));
  expect(entities).toHaveLength(1);
  const w = warnings.find((x) => x.includes("skipped"));
  expect(w).toBeDefined();
  expect(w).toContain("MTEXT");
  expect(w).toContain("HATCH");
});

test("malformed input throws a descriptive error", () => {
  expect(() => importDxf("this is not\na dxf file at all")).toThrow(/not a valid DXF/i);
  expect(() => importDxf("AutoCAD Binary DXF")).toThrow(/binary/i);
  // Valid pairs but no ENTITIES section:
  expect(() => importDxf("0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF")).toThrow(/ENTITIES/);
});

test("empty ENTITIES section imports zero entities without throwing", () => {
  const { entities } = importDxf(dxf([], { units: 4 }));
  expect(entities).toHaveLength(0);
});
