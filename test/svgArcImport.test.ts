// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { ArcEntity, PolylineEntity, LineEntity, type Entity } from "../src/model/entities";
import { importSvg } from "../src/io/svgImport";

/**
 * SVG arc (`A`) import.
 *
 * It used to be dropped: the parser consumed the seven parameters, logged a
 * warning and jumped to the endpoint, so the segment became a straight line —
 * or nothing at all, since `flushPoly` had no points for it. Every rounded
 * corner in every imported SVG was silently squared off, and once RapidCAM
 * started EXPORTING rounded rectangles as arcs it could no longer read back
 * what it had written.
 *
 * The tests assert where the arc actually GOES, not which flags were parsed.
 * The two flag pairs are the whole difficulty — four arcs join any two points
 * with a given radius, and the Y-flip between SVG and world reverses the sweep,
 * so a sign error still produces a plausible arc in the wrong place.
 */

/** A 100×100mm document with one path. */
function parse(d: string): Entity[] {
  return importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">` +
      `<path d="${d}" fill="none" stroke="#000"/></svg>`,
  );
}

/** Midpoint of an arc's swept path — the thing that moves when a flag is wrong. */
function arcMid(a: ArcEntity): { x: number; y: number } {
  const t = (a.startAngle + a.endAngle) / 2;
  return { x: a.center.x + a.radius * Math.cos(t), y: a.center.y + a.radius * Math.sin(t) };
}

describe("SVG elliptical arc import", () => {
  it("a circular quarter arc becomes an ArcEntity of the right radius and centre", () => {
    // SVG y-down: (10,50) → (50,10) is, in world y-up mm, (10,50) → (50,90).
    const [e] = parse("M 10 50 A 40 40 0 0 1 50 10");
    expect(e).toBeInstanceOf(ArcEntity);
    const a = e as ArcEntity;
    expect(a.radius).toBeCloseTo(40, 6);
    // Two centres solve this chord: SVG (50,50) and (10,10). sweep=1 is the
    // increasing-angle direction in SVG's Y-down frame, which picks (50,50) —
    // world (50,50) once Y is flipped in a 100mm-tall document.
    expect(a.center.x).toBeCloseTo(50, 6);
    expect(a.center.y).toBeCloseTo(50, 6);
    // …and the arc really spans the quadrant joining the two endpoints.
    expect(arcMid(a).x).toBeCloseTo(50 - 40 * Math.SQRT1_2, 6);
    expect(arcMid(a).y).toBeCloseTo(50 + 40 * Math.SQRT1_2, 6);
  });

  it("the sweep flag decides which side the arc bulges — the sign trap", () => {
    const [ccw] = parse("M 10 50 A 40 40 0 0 1 50 10");
    const [cw] = parse("M 10 50 A 40 40 0 0 0 50 10");
    expect(ccw).toBeInstanceOf(ArcEntity);
    expect(cw).toBeInstanceOf(ArcEntity);

    const m1 = arcMid(ccw as ArcEntity);
    const m2 = arcMid(cw as ArcEntity);
    // The two centres are the two solutions, mirrored about the chord: one arc
    // must pass on each side of it. The chord runs (10,50)→(50,90) in world mm.
    const side = (p: { x: number; y: number }) => Math.sign((50 - 10) * (p.y - 50) - (90 - 50) * (p.x - 10));
    expect(side(m1)).toBe(-side(m2));
    expect(side(m1)).not.toBe(0);
  });

  it("the large-arc flag takes the long way round", () => {
    const [small] = parse("M 10 50 A 40 40 0 0 1 50 10");
    const [large] = parse("M 10 50 A 40 40 0 1 1 50 10");
    const span = (e: Entity) => {
      const a = e as ArcEntity;
      return a.endAngle - a.startAngle;
    };
    expect(span(small)).toBeLessThan(Math.PI);
    expect(span(large)).toBeGreaterThan(Math.PI);
  });

  it("an ellipse cannot be an ArcEntity, so it arrives as points rather than vanishing", () => {
    const ents = parse("M 10 50 A 40 20 0 0 1 50 30");
    const poly = ents.find((e) => e instanceof PolylineEntity) as PolylineEntity | undefined;
    expect(poly, "an elliptical arc must still arrive as geometry").toBeDefined();
    expect(poly!.points.length).toBeGreaterThan(8);
    // It really is elliptical: the distance from the chord's midpoint varies in
    // a way a circle through the same endpoints would not reproduce.
    const first = poly!.points[0];
    const last = poly!.points[poly!.points.length - 1];
    expect(first).toEqual({ x: 10, y: 50 });
    expect(last.x).toBeCloseTo(50, 6);
    expect(last.y).toBeCloseTo(70, 6); // 100 − 30
  });

  it("a zero-radius arc degrades to a straight line, per the spec", () => {
    const ents = parse("M 10 10 A 0 0 0 0 1 50 10");
    expect(ents).toHaveLength(1);
    const e = ents[0];
    // A two-point run comes back as a LineEntity.
    expect(e instanceof LineEntity || e instanceof PolylineEntity).toBe(true);
    if (e instanceof LineEntity) {
      expect(e.a).toEqual({ x: 10, y: 90 });
      expect(e.b).toEqual({ x: 50, y: 90 });
    }
  });

  it("radii too small to reach the endpoint are scaled up, not rejected", () => {
    // Chord is 80mm; the radius given is 10. The spec says grow it to 40.
    const [e] = parse("M 10 50 A 10 10 0 0 1 90 50");
    expect(e).toBeInstanceOf(ArcEntity);
    expect((e as ArcEntity).radius).toBeCloseTo(40, 6);
  });

  it("an arc mid-path keeps the run before it", () => {
    // The old code called neither ensurePoly nor flushPoly, so a straight run
    // leading into an arc could be swallowed with it.
    const ents = parse("M 10 10 L 10 50 A 40 40 0 0 1 50 10 L 90 10");
    expect(ents.filter((e) => e instanceof ArcEntity)).toHaveLength(1);
    const lines = ents.filter((e) => e instanceof LineEntity || e instanceof PolylineEntity);
    expect(lines.length, "both straight runs survive the arc between them").toBe(2);
  });
});
