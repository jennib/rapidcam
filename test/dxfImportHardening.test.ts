import { test, expect } from "vitest";
import { importDxf } from "../src/io/dxfImport";
import { PolylineEntity } from "../src/model/entities";

const dxf = (entityTags: (string | number)[], blocks?: (string | number)[]): string => {
  const lines: (string | number)[] = [];
  if (blocks) lines.push(0, "SECTION", 2, "BLOCKS", ...blocks, 0, "ENDSEC");
  lines.push(0, "SECTION", 2, "ENTITIES", ...entityTags, 0, "ENDSEC", 0, "EOF");
  return lines.join("\n");
};

// Nested-block fan-out "bomb": b0 holds 10 lines; each bN inserts bN-1 ten
// times. Inserting b7 would expand to 10^8 entities. The depth>8 guard alone
// doesn't stop it (this is only 8 nesting levels) — the entity budget must.
test("nested-block fan-out is bounded, not exponential (no OOM)", () => {
  const FAN = 10;
  const blocks: (string | number)[] = [];
  blocks.push(0, "BLOCK", 2, "b0", 10, 0, 20, 0);
  for (let k = 0; k < FAN; k++) blocks.push(0, "LINE", 10, 0, 20, 0, 11, 1, 21, 1);
  blocks.push(0, "ENDBLK");
  for (let lvl = 1; lvl <= 7; lvl++) {
    blocks.push(0, "BLOCK", 2, `b${lvl}`, 10, 0, 20, 0);
    for (let k = 0; k < FAN; k++) blocks.push(0, "INSERT", 2, `b${lvl - 1}`, 10, 0, 20, 0);
    blocks.push(0, "ENDBLK");
  }

  const t0 = Date.now();
  const { entities, warnings } = importDxf(dxf([0, "INSERT", 2, "b7", 10, 0, 20, 0], blocks));
  expect(Date.now() - t0).toBeLessThan(20_000);
  expect(entities.length).toBeLessThanOrEqual(1_000_000);
  expect(warnings.some((w) => w.includes("entity limit"))).toBe(true);
}, 30_000);

// A SPLINE with an absurd degree (code 71) would make de Boor O(degree²). Over
// the cap it must fall back to the coarse polyline approximation, not evaluate.
test("over-degree SPLINE falls back to a polyline (no O(degree^2) blowup)", () => {
  const degree = 25; // > the degree cap
  const nCtrl = degree + 2;
  const spline: (string | number)[] = [0, "SPLINE", 71, degree, 70, 8];
  for (let i = 0; i < nCtrl; i++) spline.push(10, i, 20, i % 2); // control points
  const nKnots = nCtrl + degree + 1;
  for (let i = 0; i < nKnots; i++) spline.push(40, i); // matching knot vector

  const { entities, warnings } = importDxf(dxf(spline));
  const poly = entities.find((e): e is PolylineEntity => e instanceof PolylineEntity);
  expect(poly).toBeDefined();
  expect(warnings.some((w) => w.includes("approximation"))).toBe(true);
});
