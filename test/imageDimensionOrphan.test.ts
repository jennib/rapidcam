/**
 * Regression test for a reported bug: dimensioning an image's edge, then
 * deleting the image, left the dimension behind (orphaned, pointing at
 * nothing). Root cause: the Dimension tool's rectangle-edge pick only matched
 * `hit.type === "rectangle"`, so clicking an image's edge fell through to a
 * different pick path that did not reference the image's own entity id —
 * `CADDocument.pruneReferences()` (which correctly drops any dimension whose
 * points/entities point at a deleted id) had nothing of the image's to match,
 * so the dimension survived. Fixed by `pickRectOrImageEdge` treating an
 * image's c0–c3 corners the same way a rectangle's bl/br/tr/tl are handled.
 */
import { describe, it, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { RasterImageEntity } from "../src/model/entities";
import { DimensionTool } from "../src/tools/dimensionTool";
import type { ToolContext, ToolPointerEvent } from "../src/tools/tool";
import { SnapEngine } from "../src/input/snapping";
import type { Vec2 } from "../src/core/vec2";

function makeCtx(doc: CADDocument): ToolContext {
  return {
    doc,
    view: { scale: 1, toWorldLen: (px: number) => px } as ToolContext["view"],
    requestRender() {},
    solve() {},
    pushHistory() {},
    openDimEditor() {},
    currentDof: () => 5,
    openValueEditor() {},
    closeValueEditor() {},
    notify() {},
    setHint() {},
    snap: new SnapEngine(),
  };
}

function event(pos: Vec2): ToolPointerEvent {
  return {
    world: pos,
    worldRaw: pos,
    screen: pos,
    snap: null,
    button: 0,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
  };
}

function click(tool: DimensionTool, ctx: ToolContext, pos: Vec2): void {
  tool.onPointerDown(event(pos), ctx);
}
function move(tool: DimensionTool, ctx: ToolContext, pos: Vec2): void {
  tool.onPointerMove(event(pos), ctx);
}

/** Draw a horizontal edge dimension on `img`'s bottom edge and place it below. */
function dimensionBottomEdge(tool: DimensionTool, ctx: ToolContext): void {
  // Image spans x:[20,120] y:[20,80] (position (20,20), 100x60) — bottom edge
  // midpoint (70,20) is one click away from both corners (mirrors a rectangle's
  // "click an edge directly" shortcut).
  click(tool, ctx, { x: 70, y: 20 });
  move(tool, ctx, { x: 70, y: 5 });
  click(tool, ctx, { x: 70, y: 5 }); // open space below the image -> commits
}

describe("Dimension tool on an image (orphan regression)", () => {
  it("anchors the edge dimension to the IMAGE's own corner points, not free points", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const img = doc.add(new RasterImageEntity("img1", { x: 20, y: 20 }, 100, 60));
    const ctx = makeCtx(doc);
    dimensionBottomEdge(new DimensionTool(), ctx);

    expect(doc.dimensions).toHaveLength(1);
    const dim = doc.dimensions[0];
    expect(dim.points).toHaveLength(2);
    // The bug: these used to NOT reference the image, so deleting it left the
    // dimension behind — pruneReferences had no image id to match against.
    expect(dim.points.every((p) => p.entityId === img.id)).toBe(true);
    expect(dim.value).toBeCloseTo(100); // the image's width
  });

  it("deleting the image removes its dimension too — no orphan", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const img = doc.add(new RasterImageEntity("img1", { x: 20, y: 20 }, 100, 60));
    const ctx = makeCtx(doc);
    dimensionBottomEdge(new DimensionTool(), ctx);
    expect(doc.dimensions).toHaveLength(1);

    img.selected = true;
    doc.removeSelected();

    expect(doc.entities.some((e) => e.id === img.id)).toBe(false);
    expect(doc.dimensions).toHaveLength(0); // regression: used to survive, orphaned
  });
});
