/**
 * Repeated-click cycling through overlapping entity bodies. When two entities
 * sit on top of each other (e.g. a line drawn along a rectangle edge), clicking
 * the same spot again must advance to the next one so the occluded entity can
 * still be selected.
 */

import { describe, it, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity, RectEntity } from "../src/model/entities";
import { SelectTool } from "../src/tools/selectTool";
import { ToolContext, ToolPointerEvent } from "../src/tools/tool";
import { Vec2 } from "../src/core/vec2";

function makeCtx(doc: CADDocument): ToolContext {
  return {
    doc,
    view: {
      scale: 1,
      worldToScreen: (p: Vec2) => p,
      toWorldLen: (px: number) => px,
    } as unknown as ToolContext["view"],
    requestRender() {},
    solve() {},
    pushHistory() {},
    openDimEditor() {},
    currentDof: () => 0,
    openValueEditor() {},
    closeValueEditor() {},
  };
}

function clickAt(tool: SelectTool, ctx: ToolContext, pos: Vec2): void {
  const e: ToolPointerEvent = {
    world: pos, worldRaw: pos, screen: pos, snap: null,
    button: 0, shiftKey: false, ctrlKey: false, altKey: false,
  };
  tool.onPointerDown(e, ctx);
  tool.onPointerUp(e, ctx);
}

function selectedIds(doc: CADDocument): string[] {
  return doc.entities.filter((e) => e.selected).map((e) => e.id);
}

describe("SelectTool occlusion cycling", () => {
  it("cycles between a line lying on a rectangle edge", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const rect = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 100, y: 50 }));
    // Line drawn along the rectangle's bottom edge (y = 0) and past it.
    const line = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 150, y: 0 }));

    const tool = new SelectTool();
    const ctx = makeCtx(doc);
    // On the shared edge, but away from any transform-box handle (corners /
    // edge-midpoints) that would otherwise intercept the click.
    const spot = { x: 30, y: 0 };

    clickAt(tool, ctx, spot);
    const first = selectedIds(doc);
    expect(first.length).toBe(1);

    clickAt(tool, ctx, spot);
    const second = selectedIds(doc);
    expect(second.length).toBe(1);
    // The second click must reach the *other* entity, not re-select the first.
    expect(second[0]).not.toBe(first[0]);

    // The two clicks together must have reached both stacked entities.
    expect(new Set([first[0], second[0]])).toEqual(new Set([rect.id, line.id]));

    // A third click wraps back to the first.
    clickAt(tool, ctx, spot);
    expect(selectedIds(doc)).toEqual(first);
  });

  it("does not cycle when the cursor moves to a different spot", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const rect = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 100, y: 50 }));
    doc.add(new LineEntity({ x: 0, y: 0 }, { x: 150, y: 0 }));

    const tool = new SelectTool();
    const ctx = makeCtx(doc);

    clickAt(tool, ctx, { x: 30, y: 0 });
    const a = selectedIds(doc);
    // Click the top edge of the rectangle (only the rect is there), away from
    // any transform handle.
    clickAt(tool, ctx, { x: 20, y: 50 });
    expect(selectedIds(doc)).toEqual([rect.id]);
    expect(a.length).toBe(1);
  });
});
