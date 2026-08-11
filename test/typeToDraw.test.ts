/**
 * Drift guard for Type to Draw.
 *
 * The in-app help has twice described typed input for a tool that had none —
 * Circle's "enter exact diameter in the input HUD" and Rotate's "enter angle" —
 * and stayed silent about Rect, Arc and Polygon, which had it all along. A
 * string search can't catch that: the claim is about BEHAVIOUR, so this drives
 * each tool named in TYPE_TO_DRAW_TOOLS to the point where the field should
 * open and asserts that it does.
 *
 * Adding a tool to the list without teaching this file how to drive it fails
 * the completeness test below, so the list can't outrun the evidence.
 */

import { describe, it, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { SnapEngine } from "../src/input/snapping";
import { TYPE_TO_DRAW_TOOLS } from "../src/tools/shortcuts";
import type { Tool, ToolContext, ToolPointerEvent } from "../src/tools/tool";
import type { Vec2 } from "../src/core/vec2";

import { LineTool } from "../src/tools/lineTool";
import { PolylineTool } from "../src/tools/polylineTool";
import { RectTool } from "../src/tools/rectTool";
import { CircleTool } from "../src/tools/circleTool";
import { ArcTool } from "../src/tools/arcTool";
import { BezierTool } from "../src/tools/bezierTool";
import { PolygonTool } from "../src/tools/polygonTool";
import { SlotTool } from "../src/tools/slotTool";
import { FilletTool } from "../src/tools/filletTool";
import { ChamferTool } from "../src/tools/chamferTool";
import { MeasureTool } from "../src/tools/measureTool";
import { TrimTool } from "../src/tools/trimTool";

interface Spy {
  ctx: ToolContext;
  /** Placeholders of the fields currently open; empty when no field is open. */
  fields: string[];
  opened: boolean;
}

function makeCtx(doc: CADDocument): Spy {
  const spy: Spy = { fields: [], opened: false, ctx: null as unknown as ToolContext };
  spy.ctx = {
    doc,
    view: { scale: 1 } as ToolContext["view"],
    requestRender() {},
    solve() {},
    pushHistory() {},
    openDimEditor() {},
    currentDof: () => 0,
    openTypeToDraw(_pos, fields) {
      spy.fields = fields.map((f) => f.placeholder);
      spy.opened = true;
    },
    closeTypeToDraw() {
      spy.fields = [];
    },
    notify() {},
    setHint() {},
    snap: new SnapEngine(),
  };
  return spy;
}

function evt(pos: Vec2): ToolPointerEvent {
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

/** Two lines meeting at (0,0) — the corner Fillet and Chamfer need to bite on. */
function withCorner(doc: CADDocument): void {
  doc.add(new LineEntity({ x: 0, y: 0 }, { x: 50, y: 0 }));
  doc.add(new LineEntity({ x: 0, y: 0 }, { x: 0, y: 50 }));
}

/**
 * How to bring each tool to the moment its field should appear. Keyed by tool
 * id so it lines up with TYPE_TO_DRAW_TOOLS by construction.
 */
const DRIVERS: Record<string, { tool: () => Tool; arm: (t: Tool, s: Spy) => void }> = {
  line: {
    tool: () => new LineTool(),
    arm: (t, s) => t.onPointerDown?.(evt({ x: 10, y: 10 }), s.ctx),
  },
  polyline: {
    tool: () => new PolylineTool(),
    arm: (t, s) => t.onPointerDown?.(evt({ x: 10, y: 10 }), s.ctx), // per segment
  },
  bezier: {
    tool: () => new BezierTool(),
    arm: (t, s) => t.onPointerDown?.(evt({ x: 10, y: 10 }), s.ctx), // the chord only
  },
  rect: {
    tool: () => new RectTool(),
    arm: (t, s) => t.onPointerDown?.(evt({ x: 10, y: 10 }), s.ctx),
  },
  circle: {
    tool: () => new CircleTool(),
    arm: (t, s) => t.onPointerDown?.(evt({ x: 10, y: 10 }), s.ctx),
  },
  arc: {
    tool: () => new ArcTool(),
    arm: (t, s) => {
      t.onPointerDown?.(evt({ x: 0, y: 0 }), s.ctx); // centre
      t.onPointerDown?.(evt({ x: 20, y: 0 }), s.ctx); // start point
    },
  },
  polygon: {
    tool: () => new PolygonTool(),
    arm: (t, s) => t.onPointerDown?.(evt({ x: 10, y: 10 }), s.ctx),
  },
  slot: {
    tool: () => new SlotTool(),
    arm: (t, s) => {
      t.onPointerDown?.(evt({ x: 0, y: 0 }), s.ctx); // first centre
      t.onPointerDown?.(evt({ x: 30, y: 0 }), s.ctx); // second centre
    },
  },
  fillet: {
    tool: () => new FilletTool(),
    arm: (t, s) => {
      withCorner(s.ctx.doc);
      // Press and release on the corner without moving: under the drag
      // threshold, which is the gesture that asks for a typed radius.
      t.onPointerDown?.(evt({ x: 0, y: 0 }), s.ctx);
      t.onPointerUp?.(evt({ x: 0, y: 0 }), s.ctx);
    },
  },
  chamfer: {
    tool: () => new ChamferTool(),
    arm: (t, s) => {
      withCorner(s.ctx.doc);
      t.onPointerDown?.(evt({ x: 0, y: 0 }), s.ctx);
      t.onPointerUp?.(evt({ x: 0, y: 0 }), s.ctx);
    },
  },
};

describe("Type to Draw — every tool that claims it, has it", () => {
  it("has a driver for every tool on the list", () => {
    // Otherwise a tool could be added to TYPE_TO_DRAW_TOOLS — and so to the
    // help — with nothing checking that its field exists.
    expect(Object.keys(DRIVERS).sort()).toEqual([...TYPE_TO_DRAW_TOOLS].sort());
  });

  for (const id of TYPE_TO_DRAW_TOOLS) {
    it(`${id} opens a field when armed`, () => {
      const doc = new CADDocument({ width: 400, height: 300 });
      const spy = makeCtx(doc);
      const driver = DRIVERS[id];
      if (!driver) throw new Error(`no driver for "${id}"`);

      const tool = driver.tool();
      expect(tool.id, "driver is wired to the wrong tool").toBe(id);
      expect(spy.opened, "a field was open before the tool was armed").toBe(false);

      driver.arm(tool, spy);

      expect(spy.opened, `${id} never opened a Type to Draw field`).toBe(true);
      expect(spy.fields.length, `${id} opened an empty field set`).toBeGreaterThan(0);
      for (const p of spy.fields) expect(p.trim()).not.toBe("");
    });
  }

  // Positive control for the negative assertion below: the spy DOES observe an
  // opening (proved by every case above), so "no field" here means the tool
  // really has none — not that the harness is blind.
  it("does not fire for tools that have no typed input", () => {
    for (const [id, tool] of [
      ["measure", new MeasureTool()],
      ["trim", new TrimTool()],
    ] as const) {
      expect(TYPE_TO_DRAW_TOOLS).not.toContain(id);
      const spy = makeCtx(new CADDocument({ width: 400, height: 300 }));
      tool.onPointerDown?.(evt({ x: 10, y: 10 }), spy.ctx);
      tool.onPointerDown?.(evt({ x: 40, y: 40 }), spy.ctx);
      expect(spy.opened, `${id} opened a field but is not on the list`).toBe(false);
    }
  });
});
