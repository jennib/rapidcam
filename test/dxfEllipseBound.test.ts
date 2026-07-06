import { test, expect } from "vitest";
import { importDxf } from "../src/io/dxfImport";
import { PolylineEntity } from "../src/model/entities";

const dxf = (entityTags: (string | number)[]): string =>
  [0, "SECTION", 2, "ENTITIES", ...entityTags, 0, "ENDSEC", 0, "EOF"].join("\n");

const firstPoly = (dxfText: string): PolylineEntity | undefined =>
  importDxf(dxfText).entities.find((e): e is PolylineEntity => e instanceof PolylineEntity);

// A hostile ELLIPSE whose end-parameter (code 42) is astronomically large.
// Before the span clamp this drove nSeg — and the tessellation loop — to ~1e13
// iterations: a hang/OOM on import. The sweep must be clamped to one full turn.
test("hostile ELLIPSE end-parameter is bounded (no hang/OOM)", () => {
  const ellipse = [0, "ELLIPSE", 10, 0, 20, 0, 11, 10, 21, 0, 40, 1, 41, 0, 42, 1e12];
  const t0 = Date.now();
  const poly = firstPoly(dxf(ellipse));
  expect(Date.now() - t0).toBeLessThan(1000); // completes fast, not 10^13 iters
  expect(poly).toBeDefined();
  // A full ellipse tessellates to 64 segments → ≤ 65 points, never millions.
  expect(poly!.points.length).toBeLessThanOrEqual(65);
});

// A legitimate partial ellipse (quarter sweep) must still tessellate — the
// clamp only caps oversized spans, it doesn't collapse valid ones.
test("valid partial ELLIPSE still tessellates", () => {
  const quarter = [0, "ELLIPSE", 10, 0, 20, 0, 11, 10, 21, 0, 40, 1, 41, 0, 42, Math.PI / 2];
  const poly = firstPoly(dxf(quarter));
  expect(poly).toBeDefined();
  expect(poly!.points.length).toBeGreaterThan(2);
});
