/**
 * "Constraints resisted the move" detection: an entity drag whose solve lands
 * far from where the cursor asked (constraints anchored to unselected geometry
 * pulled it back) must notify once on pointer-up; a free move must stay quiet.
 * Runs the REAL solver so the resistance is genuine, not simulated.
 */

import { describe, it, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { makeConstraint } from "../src/model/constraints";
import { SelectTool, meanDeviation } from "../src/tools/selectTool";
import type { ToolContext, ToolPointerEvent } from "../src/tools/tool";
import { SnapEngine } from "../src/input/snapping";
import { solve } from "../src/solver/solver";
import type { Vec2 } from "../src/core/vec2";

function makeCtx(doc: CADDocument): { ctx: ToolContext; notified: string[] } {
  const notified: string[] = [];
  const snap = new SnapEngine();
  snap.gridEnabled = false;
  snap.objectSnapEnabled = false; // keep deltas exactly what the drag asked
  const ctx: ToolContext = {
    doc,
    view: {
      scale: 10,
      worldToScreen: (p: Vec2) => ({ x: p.x * 10, y: -p.y * 10 }),
      toWorldLen: (px: number) => px / 10,
    } as unknown as ToolContext["view"],
    requestRender() {},
    solve(pins) {
      solve(doc, pins);
    },
    pushHistory() {},
    openDimEditor() {},
    currentDof: () => 4,
    openTypeToDraw() {},
    closeTypeToDraw() {},
    notify(msg) {
      notified.push(msg);
    },
    setHint() {},
    snap,
  };
  return { ctx, notified };
}

function ev(worldPos: Vec2): ToolPointerEvent {
  const screen = { x: worldPos.x * 10, y: -worldPos.y * 10 };
  return {
    world: worldPos,
    worldRaw: worldPos,
    screen,
    snap: null,
    button: 0,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
  };
}

function drag(tool: SelectTool, ctx: ToolContext, from: Vec2, to: Vec2): void {
  tool.onPointerDown(ev(from), ctx);
  tool.onPointerMove(ev(to), ctx);
  tool.onPointerUp(ev(to), ctx);
}

describe("constrained-drag resistance notice", () => {
  it("notifies when a coincident-to-fixed constraint fights the drag", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const a = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 10, y: 0 })) as LineEntity;
    const b = doc.add(new LineEntity({ x: 10, y: 0 }, { x: 20, y: 0 })) as LineEntity;
    doc.addConstraint(makeConstraint("fixed", { entities: [b.id] }));
    doc.addConstraint(
      makeConstraint("coincident", {
        points: [
          { entityId: a.id, key: "b" },
          { entityId: b.id, key: "a" },
        ],
      }),
    );
    solve(doc); // settle

    const { ctx, notified } = makeCtx(doc);
    const tool = new SelectTool();
    // Grab line A's body (quarter point, clear of endpoints) and pull hard.
    drag(tool, ctx, { x: 2.5, y: 0 }, { x: 7.5, y: 8 });
    expect(notified.some((m) => /resisted/i.test(m))).toBe(true);
  });

  it("stays quiet for a free move", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    doc.add(new LineEntity({ x: 0, y: 0 }, { x: 10, y: 0 }));
    const { ctx, notified } = makeCtx(doc);
    const tool = new SelectTool();
    drag(tool, ctx, { x: 2.5, y: 0 }, { x: 7.5, y: 8 });
    expect(notified).toEqual([]);
  });
});

describe("meanDeviation", () => {
  it("is 0 when everything lands as asked and |d| when nothing moves", () => {
    const start = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    const d = { x: 3, y: 4 };
    const moved = start.map((p) => ({ x: p.x + 3, y: p.y + 4 }));
    expect(meanDeviation(start, d, moved)).toBeCloseTo(0);
    expect(meanDeviation(start, d, start)).toBeCloseTo(5);
  });
});
