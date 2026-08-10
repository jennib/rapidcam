/**
 * CircleTool — click-to-draw plus Type to Draw (the diameter field that opens
 * at the centre after the first click).
 *
 * Same shape as test/lineTool.test.ts: the ctx stub CAPTURES the value editor's
 * callbacks rather than no-op'ing them, so the typed path runs for real.
 */

import { describe, it, expect } from "vitest";
import { CircleEntity } from "../src/model/entities";
import { CADDocument } from "../src/model/document";
import { CircleTool } from "../src/tools/circleTool";
import type { ToolContext, ToolPointerEvent } from "../src/tools/tool";
import { SnapEngine } from "../src/input/snapping";
import type { Vec2 } from "../src/core/vec2";

interface Harness {
  ctx: ToolContext;
  /** Fill the diameter field and press Enter; returns what onCommit returned. */
  type(dia: string): boolean | undefined;
  /** Fill it without committing (what live typing does). */
  edit(dia: string): void;
  placeholder(): string | null;
  notices: string[];
}

function makeCtx(doc: CADDocument): Harness {
  let onCommit: ((raws: string[]) => boolean | undefined) | null = null;
  let onChange: ((raws: string[]) => void) | null = null;
  let placeholder: string | null = null;
  const notices: string[] = [];

  const ctx: ToolContext = {
    doc,
    view: { scale: 1 } as ToolContext["view"],
    requestRender() {},
    solve() {},
    pushHistory() {},
    openDimEditor() {},
    currentDof: () => 0,
    openValueEditor() {},
    openMultiValueEditor(_pos, fields, commit, _cancel, change) {
      placeholder = fields[0]?.placeholder ?? null;
      onCommit = commit;
      onChange = change ?? null;
    },
    closeValueEditor() {
      onCommit = null;
      onChange = null;
      placeholder = null;
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
    placeholder: () => placeholder,
    edit: (dia) => onChange?.([dia]),
    type(dia) {
      if (!onCommit) throw new Error("no value editor is open");
      return onCommit([dia]);
    },
  };
}

function click(tool: CircleTool, ctx: ToolContext, pos: Vec2): void {
  tool.onPointerDown(
    {
      world: pos,
      worldRaw: pos,
      screen: pos,
      snap: null,
      button: 0,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
    } satisfies ToolPointerEvent,
    ctx,
  );
}

function move(tool: CircleTool, ctx: ToolContext, pos: Vec2): void {
  tool.onPointerMove(
    {
      world: pos,
      worldRaw: pos,
      screen: pos,
      snap: null,
      button: 0,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
    } satisfies ToolPointerEvent,
    ctx,
  );
}

const circlesOf = (doc: CADDocument) =>
  doc.entities.filter((e): e is CircleEntity => e instanceof CircleEntity);

const only = (doc: CADDocument) => {
  const found = circlesOf(doc);
  expect(found).toHaveLength(1);
  return found[0];
};

describe("CircleTool — clicking", () => {
  it("draws a circle whose radius is the distance to the second click", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const { ctx } = makeCtx(doc);
    const tool = new CircleTool();
    click(tool, ctx, { x: 50, y: 50 });
    click(tool, ctx, { x: 80, y: 50 });

    const c = only(doc);
    expect(c.center).toEqual({ x: 50, y: 50 });
    expect(c.radius).toBeCloseTo(30, 9);
  });

  it("refuses a zero radius and says why", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const { ctx, notices } = makeCtx(doc);
    const tool = new CircleTool();
    click(tool, ctx, { x: 20, y: 20 });
    click(tool, ctx, { x: 20, y: 20 });

    expect(circlesOf(doc)).toHaveLength(0);
    expect(notices).toEqual(["Radius snapped to zero — zoom in or toggle snap."]);
  });
});

describe("CircleTool — Type to Draw", () => {
  it("asks for a DIAMETER, in the document's display unit", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    click(new CircleTool(), h.ctx, { x: 0, y: 0 });
    expect(h.placeholder()).toBe("Ø (mm)");

    const inchDoc = new CADDocument({ width: 400, height: 300 });
    inchDoc.displayUnit = "in";
    const hi = makeCtx(inchDoc);
    click(new CircleTool(), hi.ctx, { x: 0, y: 0 });
    expect(hi.placeholder()).toBe("Ø (in)");
  });

  it("commits half the typed diameter as the radius", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new CircleTool();
    click(tool, h.ctx, { x: 10, y: 10 });
    move(tool, h.ctx, { x: 999, y: 999 }); // the cursor must not matter
    expect(h.type("50")).toBe(true);

    const c = only(doc);
    expect(c.center).toEqual({ x: 10, y: 10 });
    expect(c.radius).toBeCloseTo(25, 9);
  });

  it("reads the diameter in inches when the document is in inches", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    doc.displayUnit = "in";
    const h = makeCtx(doc);
    const tool = new CircleTool();
    click(tool, h.ctx, { x: 0, y: 0 });
    h.type("2");

    expect(only(doc).radius).toBeCloseTo(25.4, 9); // Ø2in -> r 1in
  });

  it("previews exactly what it will commit", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new CircleTool();
    click(tool, h.ctx, { x: 5, y: 5 });
    move(tool, h.ctx, { x: 200, y: 5 });
    h.edit("40"); // live typing, no Enter yet

    const preview = tool.getOverlay().previews.find((p) => p.kind === "circle");
    expect(preview).toMatchObject({ radius: 20 }); // not the 195mm the cursor implies

    h.type("40");
    expect(only(doc).radius).toBeCloseTo(20, 9);
  });

  it("clicking after typing uses the typed diameter, matching the preview", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new CircleTool();
    click(tool, h.ctx, { x: 0, y: 0 });
    h.edit("12");
    click(tool, h.ctx, { x: 300, y: 0 }); // second click lands far away

    expect(only(doc).radius).toBeCloseTo(6, 9);
  });

  it("rejects unparseable or non-positive input instead of drawing something else", () => {
    for (const bad of ["abc", "0", "-5", ""]) {
      const doc = new CADDocument({ width: 400, height: 300 });
      const h = makeCtx(doc);
      const tool = new CircleTool();
      click(tool, h.ctx, { x: 0, y: 0 });
      move(tool, h.ctx, { x: 50, y: 0 }); // a valid cursor fallback exists…
      expect(h.type(bad)).toBe(false); // …and must NOT be used
      expect(circlesOf(doc)).toHaveLength(0);
    }
  });

  it("forgets the typed diameter when cancelled", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new CircleTool();
    click(tool, h.ctx, { x: 0, y: 0 });
    h.edit("500");
    tool.cancel(h.ctx);

    click(tool, h.ctx, { x: 0, y: 0 });
    click(tool, h.ctx, { x: 7, y: 0 });
    expect(only(doc).radius).toBeCloseTo(7, 9);
  });

  it("still draws by clicking when nothing is typed", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new CircleTool();
    click(tool, h.ctx, { x: 0, y: 0 });
    h.edit(""); // opened the field, typed nothing
    click(tool, h.ctx, { x: 15, y: 0 });

    expect(only(doc).radius).toBeCloseTo(15, 9);
  });
});
