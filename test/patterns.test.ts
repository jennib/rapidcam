/**
 * Stable (id-preserving) pattern regeneration.
 *
 * Guards the core Phase-1a behaviour: regenerating a pattern reuses the entity
 * ids of surviving instances, only adds/removes the delta, and refreshes
 * geometry in place — so references to surviving copies survive a count/spacing
 * change. Instances are keyed structurally (row,col / k), not by flat index.
 */

import { describe, it, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { CircleEntity } from "../src/model/entities";
import {
  createLinearPattern,
  regenerateLinearPattern,
  createCircularPattern,
  regenerateCircularPattern,
} from "../src/model/patternEngine";
import type { LinearPatternParams, CircularPatternParams } from "../src/model/patterns";

function lin(countX: number, countY: number, sx = 20, sy = 20): LinearPatternParams {
  return { countX, countY, spacingX: sx, spacingY: sy };
}
function circ(count: number): CircularPatternParams {
  return { count, cx: 0, cy: 0, totalAngle: Math.PI * 2 };
}
function freshDoc(): CADDocument {
  return new CADDocument({ width: 500, height: 500 });
}
function exists(doc: CADDocument, id: string): boolean {
  return doc.entities.some((e) => e.id === id);
}

describe("stable linear pattern regeneration", () => {
  it("growing the count keeps existing instance ids and only adds new ones", () => {
    const doc = freshDoc();
    const src = doc.add(new CircleEntity({ x: 0, y: 0 }, 5));
    const pat = createLinearPattern(doc, [src.id], lin(3, 1)); // copies at col 1, 2
    const before = pat.instanceIds.flat();
    expect(before.length).toBe(2);

    regenerateLinearPattern(doc, pat, lin(5, 1)); // now 4 copies
    const after = pat.instanceIds.flat();
    expect(after.length).toBe(4);
    expect(after.slice(0, 2)).toEqual(before); // first two preserved
    for (const id of before) expect(exists(doc, id)).toBe(true);
  });

  it("shrinking the count removes only the tail instances", () => {
    const doc = freshDoc();
    const src = doc.add(new CircleEntity({ x: 0, y: 0 }, 5));
    const pat = createLinearPattern(doc, [src.id], lin(5, 1)); // 4 copies
    const all = pat.instanceIds.flat();

    regenerateLinearPattern(doc, pat, lin(3, 1)); // 2 copies
    const kept = pat.instanceIds.flat();
    expect(kept).toEqual(all.slice(0, 2));
    for (const id of all.slice(2)) expect(exists(doc, id)).toBe(false); // tail removed
  });

  it("repositions a surviving instance in place, keeping its id", () => {
    const doc = freshDoc();
    const src = doc.add(new CircleEntity({ x: 0, y: 0 }, 5));
    const pat = createLinearPattern(doc, [src.id], lin(2, 1, 20, 0));
    const id = pat.instanceIds[0][0];
    expect((doc.entities.find((e) => e.id === id) as CircleEntity).center.x).toBeCloseTo(20);

    regenerateLinearPattern(doc, pat, lin(2, 1, 50, 0));
    expect(pat.instanceIds[0][0]).toBe(id); // same id
    expect((doc.entities.find((e) => e.id === id) as CircleEntity).center.x).toBeCloseTo(50);
  });

  it("keys instances by (row,col) so a countX change preserves identity", () => {
    const doc = freshDoc();
    const src = doc.add(new CircleEntity({ x: 0, y: 0 }, 5));
    const pat = createLinearPattern(doc, [src.id], lin(2, 2, 10, 10));
    // order: (0,1), (1,0), (1,1)
    const id01 = pat.instanceIds[0][0];
    const id10 = pat.instanceIds[1][0];
    const id11 = pat.instanceIds[2][0];

    regenerateLinearPattern(doc, pat, lin(3, 2, 10, 10));
    // order: (0,1), (0,2), (1,0), (1,1), (1,2)
    expect(pat.instanceIds[0][0]).toBe(id01);
    expect(pat.instanceIds[2][0]).toBe(id10);
    expect(pat.instanceIds[3][0]).toBe(id11);
  });
});

describe("stable circular pattern regeneration", () => {
  it("growing the count keeps existing instance ids", () => {
    const doc = freshDoc();
    const src = doc.add(new CircleEntity({ x: 100, y: 0 }, 5));
    const pat = createCircularPattern(doc, [src.id], circ(4)); // 3 copies (k=1,2,3)
    const before = pat.instanceIds.flat();
    expect(before.length).toBe(3);

    regenerateCircularPattern(doc, pat, circ(6)); // 5 copies
    const after = pat.instanceIds.flat();
    expect(after.length).toBe(5);
    expect(after.slice(0, 3)).toEqual(before);
  });
});

describe("reference integrity across regen", () => {
  it("keeps a dimension on a surviving copy and prunes it when the copy is removed", () => {
    const doc = freshDoc();
    const src = doc.add(new CircleEntity({ x: 0, y: 0 }, 5));
    const pat = createLinearPattern(doc, [src.id], lin(3, 1)); // copies at col 1, 2
    const firstCopyId = pat.instanceIds[0][0];
    doc.dimensions.push({
      id: "d1", type: "radius", entities: [firstCopyId], points: [],
      value: 5, driving: false, offset: 5,
    } as never);

    regenerateLinearPattern(doc, pat, lin(2, 1)); // col-1 copy survives
    expect(doc.dimensions.some((d) => d.id === "d1")).toBe(true);

    regenerateLinearPattern(doc, pat, lin(1, 1)); // no copies left
    expect(pat.instanceIds.flat().length).toBe(0);
    expect(doc.dimensions.some((d) => d.id === "d1")).toBe(false); // pruned
  });
});
