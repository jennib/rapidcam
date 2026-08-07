/**
 * Drift guard: the CAM field bounds are written down TWICE.
 *
 * `OP_PARAMS` (model/variables.ts) clamps what the app produces; the published
 * JSON schema declares what a .rcam file may contain. They are the same facts,
 * and nothing makes them agree — which is exactly how `spindleSpeed` ended up
 * floored at 1 in the clamp table while the schema allowed 0, and how
 * peckDepth/rasterDotPitch/chamferWidth ended up clamping to 0 while the schema
 * declared `exclusiveMinimum: 0` and would have REJECTED the app's own output.
 *
 * This pins them together. If a bound moves on either side, this fails.
 *
 * The clamp may be STRICTER than the schema (the schema is the outer contract —
 * a hand-authored file may legitimately sit anywhere inside it). It may never be
 * LOOSER, because then the app writes files its own validator rejects.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clampOpParam, OP_PARAM_KEYS } from "../src/model/variables";
import { CADDocument, stockEdgeSegments, stockRefEntity } from "../src/model/document";
import { edgeEndsOf } from "../src/model/entities";

const schema = JSON.parse(
  readFileSync(join(process.cwd(), "public", "schema", "rcam-v3.schema.json"), "utf8"),
);
const props: Record<string, Record<string, unknown>> = schema.$defs.operation.properties;
const BIG = 1e9;

describe("CAM clamp bounds vs the published schema", () => {
  // Positive control: if the key list or schema shape ever changes such that
  // nothing is compared, the suite below would pass vacuously.
  const checked = OP_PARAM_KEYS.filter((k) => !k.includes(".") && props[k]);
  it("actually compares a meaningful number of fields", () => {
    expect(checked.length).toBeGreaterThan(15);
  });

  for (const key of checked) {
    it(`${key}: clamp stays inside what the schema permits`, () => {
      const p = props[key];
      const lo = clampOpParam(key, -BIG);
      const hi = clampOpParam(key, BIG);
      expect(lo, `${key} must be clampable`).not.toBeNull();

      const min = p.minimum as number | undefined;
      const exMin = p.exclusiveMinimum as number | undefined;
      const max = p.maximum as number | undefined;

      // `depth` is sign-flipped by design (always below the surface) and
      // `stepdown` takes a magnitude, so their extremes are not bounds.
      const signFlipped = key === "depth" || key === "stepdown";

      if (min !== undefined && !signFlipped)
        expect(lo, `${key}: clamp min ${lo} is below schema minimum ${min}`).toBeGreaterThanOrEqual(min);
      if (exMin !== undefined && !signFlipped)
        expect(lo, `${key}: clamp min ${lo} must exceed schema exclusiveMinimum ${exMin}`).toBeGreaterThan(exMin);
      if (max !== undefined)
        expect(hi, `${key}: clamp max ${hi} exceeds schema maximum ${max}`).toBeLessThanOrEqual(max);
      if (p.type === "integer")
        expect(Number.isInteger(lo), `${key}: schema says integer, clamp min ${lo} is not`).toBe(true);
    });
  }
});

/**
 * The stock's edge WINDING (bl→br→tr→tl) is the other fact this codebase kept
 * restating: once in dimensionTool, once in offsetTool, once in intersect.ts,
 * and once as RECT_EDGE_CORNERS in entities.ts. Reorder any one of them and
 * constraints and dimensions silently attach to the WRONG edge — nothing throws.
 *
 * The tools now derive from STOCK_EDGES. RECT_EDGE_CORNERS cannot: it is the
 * rectangle ENTITY's own map and is reached through `edgeEndsOf`. So pin the two
 * together here.
 */
describe("stock edge winding has one definition", () => {
  it("STOCK_EDGES agrees with the rectangle's own edge map", () => {
    const doc = new CADDocument({ width: 200, height: 100 });
    doc.stockRect = { x: 10, y: 20, width: 120, height: 60 };
    const segs = stockEdgeSegments(doc);
    expect(segs, "flat stock must yield four edges").toHaveLength(4);

    for (const s of segs ?? []) {
      // The mid-key and the name must resolve to the SAME segment through the
      // entity-side map, in the same direction.
      const viaMid = edgeEndsOf(stockRefEntity(doc), s.edge.mid);
      const viaName = edgeEndsOf(stockRefEntity(doc), s.edge.name);
      expect(viaMid, `${s.edge.mid} must resolve`).not.toBeNull();
      expect(viaName, `${s.edge.name} must resolve`).not.toBeNull();
      for (const [label, got] of [
        ["mid", viaMid],
        ["name", viaName],
      ] as const) {
        expect(got?.a.x, `${s.edge.name} via ${label}: a.x`).toBeCloseTo(s.a.x, 9);
        expect(got?.a.y, `${s.edge.name} via ${label}: a.y`).toBeCloseTo(s.a.y, 9);
        expect(got?.b.x, `${s.edge.name} via ${label}: b.x`).toBeCloseTo(s.b.x, 9);
        expect(got?.b.y, `${s.edge.name} via ${label}: b.y`).toBeCloseTo(s.b.y, 9);
      }
    }
  });

  it("is null for a rotary document — there is no flat stock", () => {
    const doc = new CADDocument({ width: 200, height: 100 });
    doc.machineKind = "mill-rotary";
    expect(stockEdgeSegments(doc)).toBeNull();
  });
});
