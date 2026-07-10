import { test, expect } from "vitest";
import { exportDxf } from "../src/io/dxfExport";
import { importDxf } from "../src/io/dxfImport";
import { CADDocument } from "../src/model/document";
import {
  LineEntity,
  CircleEntity,
  ArcEntity,
  RectEntity,
  PolylineEntity,
  PointEntity,
  BezierEntity,
  TextEntity,
} from "../src/model/entities";

const doc = () => new CADDocument({ width: 200, height: 150 });

test("line, circle, arc, and point round-trip exactly through the importer", () => {
  const d = doc();
  d.add(new LineEntity({ x: 1, y: 2 }, { x: 30, y: 40 }));
  d.add(new CircleEntity({ x: 50, y: 60 }, 12.5));
  d.add(new ArcEntity({ x: 10, y: 10 }, 5, Math.PI / 2, Math.PI));
  d.add(new PointEntity({ x: 7, y: 8 }));

  const { dxf, warnings } = exportDxf(d);
  expect(warnings).toEqual([]);
  const back = importDxf(dxf);
  expect(back.warnings).toEqual([]); // $INSUNITS present → no unit warning

  const line = back.entities.find((e) => e instanceof LineEntity) as LineEntity;
  expect(line.a).toEqual({ x: 1, y: 2 });
  expect(line.b).toEqual({ x: 30, y: 40 });

  const circle = back.entities.find((e) => e instanceof CircleEntity) as CircleEntity;
  expect(circle.center).toEqual({ x: 50, y: 60 });
  expect(circle.radius).toBe(12.5);

  const arc = back.entities.find((e) => e instanceof ArcEntity) as ArcEntity;
  expect(arc.center).toEqual({ x: 10, y: 10 });
  expect(arc.radius).toBe(5);
  expect(arc.startAngle).toBeCloseTo(Math.PI / 2, 9);
  expect(arc.endAngle).toBeCloseTo(Math.PI, 9);

  // Only the exported point comes back (the document's origin datum is skipped).
  const points = back.entities.filter((e) => e instanceof PointEntity) as PointEntity[];
  expect(points).toHaveLength(1);
  expect(points[0].pos).toEqual({ x: 7, y: 8 });
});

test("negative arc angles normalize to [0,360) and survive the round trip", () => {
  const d = doc();
  d.add(new ArcEntity({ x: 0, y: 0 }, 10, -Math.PI / 2, Math.PI / 4));
  const back = importDxf(exportDxf(d).dxf);
  const arc = back.entities[0] as ArcEntity;
  // -90° → 270°; the sweep start/end points must be identical.
  expect(arc.startPoint.x).toBeCloseTo(0, 9);
  expect(arc.startPoint.y).toBeCloseTo(-10, 9);
  expect(arc.endPoint.x).toBeCloseTo(10 * Math.SQRT1_2, 9);
  expect(arc.endPoint.y).toBeCloseTo(10 * Math.SQRT1_2, 9);
});

test("rect exports as a closed LWPOLYLINE with its four corners", () => {
  const d = doc();
  d.add(new RectEntity({ x: 10, y: 20 }, { x: 40, y: 50 }));
  const back = importDxf(exportDxf(d).dxf);
  const pl = back.entities[0] as PolylineEntity;
  expect(pl).toBeInstanceOf(PolylineEntity);
  expect(pl.closed).toBe(true);
  expect(pl.points).toEqual([
    { x: 10, y: 20 },
    { x: 40, y: 20 },
    { x: 40, y: 50 },
    { x: 10, y: 50 },
  ]);
});

test("open and closed polylines keep their shape and closed flag", () => {
  const d = doc();
  d.add(
    new PolylineEntity(
      [
        { x: 0, y: 0 },
        { x: 5, y: 5 },
        { x: 10, y: 0 },
      ],
      false,
    ),
  );
  d.add(
    new PolylineEntity(
      [
        { x: 20, y: 0 },
        { x: 30, y: 0 },
        { x: 25, y: 8 },
      ],
      true,
    ),
  );
  const back = importDxf(exportDxf(d).dxf);
  const pls = back.entities.filter((e) => e instanceof PolylineEntity) as PolylineEntity[];
  // Open 3-point polyline stays a polyline; closed one stays closed.
  const open = pls.find((p) => !p.closed)!;
  const closed = pls.find((p) => p.closed)!;
  expect(open.points).toHaveLength(3);
  expect(open.points[1]).toEqual({ x: 5, y: 5 });
  expect(closed.points).toHaveLength(3);
});

test("bezier exports as a SPLINE that re-imports onto the exact curve", () => {
  const d = doc();
  const p0 = { x: 0, y: 0 },
    p1 = { x: 10, y: 20 },
    p2 = { x: 30, y: 20 },
    p3 = { x: 40, y: 0 };
  d.add(new BezierEntity(p0, p1, p2, p3));
  const { dxf } = exportDxf(d);
  expect(dxf).toContain("SPLINE");

  const back = importDxf(dxf);
  const pl = back.entities.find((e) => e instanceof PolylineEntity) as PolylineEntity;
  expect(pl).toBeDefined();
  const pts = pl.points;
  // Clamped ends hit p0/p3 exactly.
  expect(pts[0].x).toBeCloseTo(0, 6);
  expect(pts[0].y).toBeCloseTo(0, 6);
  expect(pts[pts.length - 1].x).toBeCloseTo(40, 6);
  expect(pts[pts.length - 1].y).toBeCloseTo(0, 6);
  // Every sample lies on the original cubic: B(t) with uniform t sampling.
  const bez = (t: number) => {
    const u = 1 - t;
    return {
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    };
  };
  for (let i = 0; i < pts.length; i++) {
    const b = bez(i / (pts.length - 1));
    expect(pts[i].x).toBeCloseTo(b.x, 5);
    expect(pts[i].y).toBeCloseTo(b.y, 5);
  }
});

test("construction entities and invisible layers are not exported", () => {
  const d = doc();
  const c = new CircleEntity({ x: 5, y: 5 }, 2);
  c.isConstruction = true;
  d.add(c);
  d.layers.push({ id: "hidden", name: "Hidden", color: "#fff", visible: false, locked: false });
  const l = new LineEntity({ x: 0, y: 0 }, { x: 1, y: 1 });
  l.layerId = "hidden";
  d.add(l);
  d.add(new LineEntity({ x: 2, y: 2 }, { x: 3, y: 3 })); // visible, default layer

  const back = importDxf(exportDxf(d).dxf);
  expect(back.entities).toHaveLength(1);
  expect((back.entities[0] as LineEntity).a).toEqual({ x: 2, y: 2 });
});

test("entity layer names are written to group code 8", () => {
  const d = doc();
  d.layers.push({ id: "layer-cut", name: "Cut", color: "#f00", visible: true, locked: false });
  const l = new LineEntity({ x: 0, y: 0 }, { x: 1, y: 0 });
  l.layerId = "layer-cut";
  d.add(l);
  const { dxf } = exportDxf(d);
  expect(dxf).toMatch(/8\nCut/);
});

test("text without a resolvable font falls back to a DXF TEXT entity", () => {
  const d = doc();
  d.add(new TextEntity("HELLO", "no-such-font", 10, { x: 5, y: 5 }, 0));
  const { dxf, warnings } = exportDxf(d);
  expect(dxf).toContain("TEXT");
  expect(dxf).toContain("HELLO");
  expect(warnings.some((w) => w.includes("font"))).toBe(true);
});

test("empty document exports a valid DXF with an empty ENTITIES section", () => {
  const { dxf } = exportDxf(doc());
  const back = importDxf(dxf);
  expect(back.entities).toHaveLength(0);
});
