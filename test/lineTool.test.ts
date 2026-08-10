/**
 * LineTool — click-to-draw plus Type to Draw (the Length/Angle fields that open
 * at the start point after the first click).
 *
 * The ctx stub CAPTURES the multi-value editor's callbacks instead of no-op'ing
 * them, so the typed path is exercised for real: `type()` drives the same
 * onChange/onCommit the app wires to the input elements.
 */

import { describe, it, expect } from "vitest";
import { LineEntity } from "../src/model/entities";
import { CADDocument } from "../src/model/document";
import { LineTool } from "../src/tools/lineTool";
import type { ToolContext, ToolPointerEvent } from "../src/tools/tool";
import { SnapEngine } from "../src/input/snapping";
import type { Vec2 } from "../src/core/vec2";

interface Harness {
  ctx: ToolContext;
  /** Feed the Length/Angle fields and press Enter; returns what onCommit returned. */
  type(len: string, angle: string): boolean | undefined;
  /** Feed the fields without committing (what live typing does). */
  edit(len: string, angle: string): void;
  editorOpen(): boolean;
  notices: string[];
}

function makeCtx(doc: CADDocument): Harness {
  let onCommit: ((raws: string[]) => boolean | undefined) | null = null;
  let onChange: ((raws: string[]) => void) | null = null;
  const notices: string[] = [];

  const ctx: ToolContext = {
    doc,
    view: { scale: 1 } as ToolContext["view"],
    requestRender() {},
    solve() {},
    pushHistory() {},
    openDimEditor() {},
    currentDof: () => 0,
    openTypeToDraw(_pos, _fields, handlers) {
      onCommit = handlers.onCommit;
      onChange = handlers.onChange ?? null;
    },
    closeTypeToDraw() {
      onCommit = null;
      onChange = null;
    },
    notify(msg) {
      notices.push(msg);
    },
    setHint() {},
    snap: new SnapEngine(),
  };

  return {
    ctx,
    notices,
    editorOpen: () => onCommit !== null,
    edit(len, angle) {
      onChange?.([len, angle]);
    },
    type(len, angle) {
      if (!onCommit) throw new Error("no value editor is open");
      return onCommit([len, angle]);
    },
  };
}

function pointerEvent(pos: Vec2, opts: Partial<ToolPointerEvent> = {}): ToolPointerEvent {
  return {
    world: pos,
    worldRaw: pos,
    screen: pos,
    snap: null,
    button: 0,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    ...opts,
  };
}

function click(tool: LineTool, ctx: ToolContext, pos: Vec2): void {
  tool.onPointerDown(pointerEvent(pos), ctx);
}

function move(tool: LineTool, ctx: ToolContext, pos: Vec2): void {
  tool.onPointerMove(pointerEvent(pos), ctx);
}

const linesOf = (doc: CADDocument) =>
  doc.entities.filter((e): e is LineEntity => e instanceof LineEntity);

const only = (doc: CADDocument) => {
  const lines = linesOf(doc);
  expect(lines).toHaveLength(1);
  return lines[0];
};

describe("LineTool — clicking", () => {
  it("draws a line between two clicked points", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const { ctx } = makeCtx(doc);
    const tool = new LineTool();
    click(tool, ctx, { x: 10, y: 20 });
    click(tool, ctx, { x: 60, y: 70 });

    const line = only(doc);
    expect(line.a).toEqual({ x: 10, y: 20 });
    expect(line.b).toEqual({ x: 60, y: 70 });
  });

  it("refuses a zero-length line and says why", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const { ctx, notices } = makeCtx(doc);
    const tool = new LineTool();
    click(tool, ctx, { x: 10, y: 10 });
    click(tool, ctx, { x: 10, y: 10 });

    expect(linesOf(doc)).toHaveLength(0);
    expect(notices).toEqual(["Both ends snapped together — zoom in or toggle snap."]);
  });
});

describe("LineTool — Type to Draw", () => {
  it("opens the Length/Angle fields on the first click, not before", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new LineTool();
    expect(h.editorOpen()).toBe(false);
    click(tool, h.ctx, { x: 0, y: 0 });
    expect(h.editorOpen()).toBe(true);
  });

  it("commits an exact length and angle", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new LineTool();
    click(tool, h.ctx, { x: 10, y: 10 });
    move(tool, h.ctx, { x: 999, y: 999 }); // the cursor must not matter here
    expect(h.type("50", "30")).toBe(true);

    const line = only(doc);
    expect(line.a).toEqual({ x: 10, y: 10 });
    expect(line.b.x).toBeCloseTo(10 + 50 * Math.cos(Math.PI / 6), 9);
    expect(line.b.y).toBeCloseTo(10 + 50 * Math.sin(Math.PI / 6), 9);
    expect(Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y)).toBeCloseTo(50, 9);
  });

  it("a length alone keeps the direction the cursor is pointing", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new LineTool();
    click(tool, h.ctx, { x: 0, y: 0 });
    move(tool, h.ctx, { x: 3, y: 3 }); // 45°, but only 4.24mm away
    expect(h.type("100", "")).toBe(true);

    const line = only(doc);
    expect(line.b.x).toBeCloseTo(100 * Math.SQRT1_2, 9);
    expect(line.b.y).toBeCloseTo(100 * Math.SQRT1_2, 9);
  });

  it("an angle alone keeps the distance to the cursor", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new LineTool();
    click(tool, h.ctx, { x: 0, y: 0 });
    move(tool, h.ctx, { x: 40, y: 0 }); // 40mm away, pointing along +X
    expect(h.type("", "90")).toBe(true);

    const line = only(doc);
    expect(line.b.x).toBeCloseTo(0, 9);
    expect(line.b.y).toBeCloseTo(40, 9);
  });

  it("adds the horizontal/vertical constraint a typed 0°/90° implies", () => {
    for (const [angle, kind] of [
      ["0", "horizontal"],
      ["90", "vertical"],
    ] as const) {
      const doc = new CADDocument({ width: 400, height: 300 });
      const h = makeCtx(doc);
      const tool = new LineTool();
      click(tool, h.ctx, { x: 0, y: 0 });
      h.type("50", angle);
      expect(doc.constraints.map((c) => c.type)).toContain(kind);
    }
  });

  it("reads the typed length in the document's display unit", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    doc.displayUnit = "in";
    const h = makeCtx(doc);
    const tool = new LineTool();
    click(tool, h.ctx, { x: 0, y: 0 });
    h.type("2", "0");

    expect(only(doc).b.x).toBeCloseTo(50.8, 9);
  });

  it("previews exactly what it will commit", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new LineTool();
    click(tool, h.ctx, { x: 5, y: 5 });
    move(tool, h.ctx, { x: 80, y: 5 });
    h.edit("60", "20"); // live typing, no Enter yet

    const preview = tool.getOverlay().previews.find((p) => p.kind === "line");
    h.type("60", "20");

    const line = only(doc);
    expect(preview).toMatchObject({ b: { x: line.b.x, y: line.b.y } });
  });

  it("clicking after typing uses the typed values, matching the preview", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new LineTool();
    click(tool, h.ctx, { x: 0, y: 0 });
    h.edit("25", "0");
    click(tool, h.ctx, { x: 300, y: 200 }); // second click lands far away

    const line = only(doc);
    expect(line.b.x).toBeCloseTo(25, 9);
    expect(line.b.y).toBeCloseTo(0, 9);
  });

  it("rejects unparseable or non-positive input instead of drawing something else", () => {
    for (const [len, angle] of [
      ["abc", ""],
      ["", "xyz"],
      ["0", ""],
      ["-5", ""],
      ["", ""],
    ]) {
      const doc = new CADDocument({ width: 400, height: 300 });
      const h = makeCtx(doc);
      const tool = new LineTool();
      click(tool, h.ctx, { x: 0, y: 0 });
      move(tool, h.ctx, { x: 50, y: 50 }); // a valid cursor fallback is available…
      expect(h.type(len, angle)).toBe(false); // …and must NOT be used
      expect(linesOf(doc)).toHaveLength(0);
    }
  });

  it("forgets typed values when cancelled, so the next line is clean", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new LineTool();
    click(tool, h.ctx, { x: 0, y: 0 });
    h.edit("500", "45");
    tool.cancel(h.ctx);

    click(tool, h.ctx, { x: 0, y: 0 });
    click(tool, h.ctx, { x: 10, y: 0 });

    const line = only(doc);
    expect(line.b).toEqual({ x: 10, y: 0 });
  });

  it("still draws by clicking when nothing is typed", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new LineTool();
    click(tool, h.ctx, { x: 0, y: 0 });
    h.edit("", ""); // opened the fields, typed nothing
    click(tool, h.ctx, { x: 12, y: 34 });

    expect(only(doc).b).toEqual({ x: 12, y: 34 });
  });
});
