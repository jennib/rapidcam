// @vitest-environment happy-dom
// (importSvg parses with DOMParser; the round trip is the whole point of the file)

import { describe, expect, it } from "vitest";
import { CADDocument } from "../src/model/document";
import { ArcEntity, LineEntity, PolylineEntity, RectEntity } from "../src/model/entities";
import { exportDxf } from "../src/io/dxfExport";
import { importDxf } from "../src/io/dxfImport";
import { exportSvg } from "../src/io/svgExport";
import { importSvg } from "../src/io/svgImport";
import { explodeSelected } from "../src/tools/explodeCommand";

/**
 * A shaped rectangle has to leave the app shaped.
 *
 * Every export path used to rebuild a rectangle from its four corners, so a
 * rounded one would have gone out square — the file and the drawing disagreeing,
 * which is the same failure class the CAM seam exists to prevent. Both
 * exporters now carry the arcs: DXF as LWPOLYLINE bulges, SVG as arc commands.
 *
 * Verified by ROUND TRIP rather than by inspecting the emitted flags. Asserting
 * "sweep-flag is 0" only restates the code; re-importing and measuring the
 * shape that comes back cannot pass if the flag or its sign is wrong.
 */

const W = 60;
const H = 40;
const R = 8;

function shapedDoc(type: "round" | "inverted" | "chamfer"): CADDocument {
  const doc = new CADDocument({ width: 200, height: 200 });
  const rect = doc.add(new RectEntity({ x: 20, y: 30 }, { x: 20 + W, y: 30 + H }));
  rect.cornerRadii = [R, R, R, R];
  rect.cornerType = type;
  return doc;
}

/** Shoelace area of a ring; magnitude only, since importers may re-wind. */
function area(pts: { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a / 2);
}

/** Flatten imported entities (lines + arcs, or a polyline) into one ring. */
function ringOf(entities: { type: string }[]): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (const e of entities) {
    if (e instanceof LineEntity) pts.push({ ...e.a }, { ...e.b });
    else if (e instanceof ArcEntity) {
      const span = (((e.endAngle - e.startAngle) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      for (let k = 0; k <= 24; k++) {
        const a = e.startAngle + (span * k) / 24;
        pts.push({ x: e.center.x + e.radius * Math.cos(a), y: e.center.y + e.radius * Math.sin(a) });
      }
    } else if (e instanceof PolylineEntity) pts.push(...e.points.map((p) => ({ ...p })));
  }
  return pts;
}

/**
 * Ordering a ring by angle about its centroid is only valid for a convex-ish
 * ring, which is why the area check below uses the entities' own order for the
 * polyline case and a sorted hull for the scattered line/arc case.
 */
function sortedRing(pts: { x: number; y: number }[]): { x: number; y: number }[] {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
}

const EXPECTED = {
  round: W * H - R * R * (4 - Math.PI),
  inverted: W * H - Math.PI * R * R,
  chamfer: W * H - 2 * R * R,
};

describe("DXF export of a shaped rectangle", () => {
  for (const type of ["round", "inverted", "chamfer"] as const) {
    it(`${type} corners survive a DXF round trip`, () => {
      const { dxf } = exportDxf(shapedDoc(type));
      const back = importDxf(dxf);
      const ring = sortedRing(ringOf(back.entities));
      expect(ring.length).toBeGreaterThan(4);
      expect(area(ring)).toBeCloseTo(EXPECTED[type], 0);
    });
  }

  it("a square rectangle still exports as a plain four-vertex LWPOLYLINE", () => {
    // No bulge codes at all: existing files must not change shape or size.
    const doc = new CADDocument({ width: 200, height: 200 });
    doc.add(new RectEntity({ x: 0, y: 0 }, { x: 50, y: 30 }));
    const { dxf } = exportDxf(doc);
    expect(dxf).not.toMatch(/^\s*42\s*$/m);
    const back = importDxf(dxf);
    expect(back.entities).toHaveLength(1);
    expect(back.entities[0]).toBeInstanceOf(PolylineEntity);
    expect((back.entities[0] as PolylineEntity).points).toHaveLength(4);
  });

  it("a rounded corner comes back as an ARC, not as a tessellation", () => {
    // The point of bulges: downstream CAD gets an arc it can edit and a
    // toolpath generator gets G2/G3, not a hundred tiny chords.
    const { dxf } = exportDxf(shapedDoc("round"));
    const back = importDxf(dxf);
    const arcs = back.entities.filter((e) => e instanceof ArcEntity);
    expect(arcs).toHaveLength(4);
    // 4 decimals, not more: a bulge is written to 6 decimal places, so the
    // radius reconstructed from it lands ~6nm out. That is the file format's
    // precision, not a geometry error.
    for (const a of arcs) expect(a.radius).toBeCloseTo(R, 4);
  });
});

describe("SVG export of a shaped rectangle", () => {
  for (const type of ["round", "inverted", "chamfer"] as const) {
    it(`${type} corners survive an SVG round trip`, () => {
      const svg = exportSvg(shapedDoc(type));
      const ring = sortedRing(ringOf(importSvg(svg)));
      expect(ring.length).toBeGreaterThan(4);
      expect(area(ring)).toBeCloseTo(EXPECTED[type], 0);
    });
  }

  it("a square rectangle still exports as <rect>", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    doc.add(new RectEntity({ x: 0, y: 0 }, { x: 50, y: 30 }));
    expect(exportSvg(doc)).toMatch(/<rect /);
    // Positive control: the shaped one does NOT take that path.
    expect(exportSvg(shapedDoc("round"))).not.toMatch(/<rect [^>]*width=/);
  });
});

describe("Explode of a shaped rectangle", () => {
  it("breaks into straight runs and true arcs, not four straight sides", () => {
    const doc = shapedDoc("round");
    doc.entities.find((e) => e instanceof RectEntity)!.selected = true;
    expect(explodeSelected(doc)).toBe(true);

    const arcs = doc.entities.filter((e) => e instanceof ArcEntity);
    const lines = doc.entities.filter((e) => e instanceof LineEntity);
    expect(arcs).toHaveLength(4);
    expect(lines).toHaveLength(4);
    for (const a of arcs) expect(a.radius).toBeCloseTo(R, 9);
    // The pieces must join up: the ring they form has the rounded area.
    expect(area(sortedRing(ringOf(doc.entities)))).toBeCloseTo(EXPECTED.round, 0);
  });

  it("an inverted corner explodes to an arc that bulges the right way", () => {
    const doc = shapedDoc("inverted");
    doc.entities.find((e) => e instanceof RectEntity)!.selected = true;
    explodeSelected(doc);
    expect(area(sortedRing(ringOf(doc.entities)))).toBeCloseTo(EXPECTED.inverted, 0);
  });

  it("a square rectangle still explodes into four constrained lines", () => {
    // Unchanged path: the rigid-rectangle constraint set only makes sense when
    // the four sides actually meet.
    const doc = new CADDocument({ width: 200, height: 200 });
    doc.add(new RectEntity({ x: 0, y: 0 }, { x: 50, y: 30 }));
    doc.entities.find((e) => e instanceof RectEntity)!.selected = true;
    explodeSelected(doc);
    expect(doc.entities.filter((e) => e instanceof LineEntity)).toHaveLength(4);
    expect(doc.constraints).toHaveLength(7);
  });
});
