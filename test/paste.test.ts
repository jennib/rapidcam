/**
 * Regression coverage for paste placement. The bug this guards against: a review
 * fix once replaced paste's clipboard-in-place translate with a fixed offset,
 * which silently dropped the documented repeat-paste CASCADE — two plain pastes
 * stacked exactly on top of each other. placePasteClones keeps the cascade via an
 * explicit (App-owned) count without mutating the source.
 */

import { describe, it, expect } from "vitest";
import { LineEntity } from "../src/model/entities";
import { placePasteClones, PASTE_OFFSET_MM } from "../src/core/paste";

describe("placePasteClones", () => {
  it("cascades: successive plain pastes step further from the source, not stacking", () => {
    const src = new LineEntity({ x: 0, y: 0 }, { x: 10, y: 0 });

    const first = placePasteClones([src], 1)[0] as LineEntity;
    const second = placePasteClones([src], 2)[0] as LineEntity;

    expect(first.a.x).toBe(PASTE_OFFSET_MM);
    expect(first.a.y).toBe(-PASTE_OFFSET_MM);
    expect(second.a.x).toBe(2 * PASTE_OFFSET_MM);
    expect(second.a.y).toBe(-2 * PASTE_OFFSET_MM);

    // The regression would put the second paste at the same spot as the first.
    expect(second.a).not.toEqual(first.a);
  });

  it("never mutates the source entities", () => {
    const src = new LineEntity({ x: 0, y: 0 }, { x: 10, y: 0 });
    placePasteClones([src], 3);
    expect(src.a).toEqual({ x: 0, y: 0 });
    expect(src.b).toEqual({ x: 10, y: 0 });
  });

  it("paste-at-cursor centres the clones' bounds on `at` and ignores count", () => {
    const src = new LineEntity({ x: 0, y: 0 }, { x: 10, y: 0 }); // bounds centre (5, 0)
    const at = { x: 100, y: 40 };
    const centre = (l: LineEntity) => ({ x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 });

    expect(centre(placePasteClones([src], 1, at)[0] as LineEntity)).toEqual(at);
    // count must not shift an at-cursor paste — otherwise repeat context-menu
    // pastes at the same point would drift.
    expect(centre(placePasteClones([src], 9, at)[0] as LineEntity)).toEqual(at);
  });
});
