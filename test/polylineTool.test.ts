/**
 * PolylineTool — clicking, and Type to Draw applied per segment.
 *
 * The interesting part is that the fields RE-ARM after every vertex and hold
 * keyboard focus from the first click on, which means the tool's own Enter and
 * Backspace have to be reachable from inside them. Both are tested here.
 */

import { describe, it, expect } from "vitest";
import { PolylineEntity } from "../src/model/entities";
import { CADDocument } from "../src/model/document";
import { PolylineTool } from "../src/tools/polylineTool";
import type { ToolContext, ToolPointerEvent } from "../src/tools/tool";
import { SnapEngine } from "../src/input/snapping";
import type { Vec2 } from "../src/core/vec2";

interface Harness {
  ctx: ToolContext;
  type(len: string, angle: string): boolean | undefined;
  edit(len: string, angle: string): void;
  /** Fire the Backspace-on-empty-fields hook the app wires up. */
  emptyBackspace(): void;
  fieldsOpen(): boolean;
}

function makeCtx(doc: CADDocument): Harness {
  let onCommit: ((raws: string[]) => boolean | undefined) | null = null;
  let onChange: ((raws: string[]) => void) | null = null;
  let onEmptyBackspace: (() => void) | null = null;

  const ctx: ToolContext = {
    doc,
    view: { scale: 1, toWorldLen: (px: number) => px } as unknown as ToolContext["view"],
    requestRender() {},
    solve() {},
    pushHistory() {},
    openDimEditor() {},
    currentDof: () => 0,
    openTypeToDraw(_pos, _fields, handlers) {
      onCommit = handlers.onCommit;
      onChange = handlers.onChange ?? null;
      onEmptyBackspace = handlers.onEmptyBackspace ?? null;
    },
    closeTypeToDraw() {
      onCommit = null;
      onChange = null;
      onEmptyBackspace = null;
    },
    notify() {},
    setHint() {},
    snap: new SnapEngine(),
  };

  return {
    ctx,
    fieldsOpen: () => onCommit !== null,
    edit: (len, angle) => onChange?.([len, angle]),
    emptyBackspace: () => {
      if (!onEmptyBackspace) throw new Error("no Backspace hook is armed");
      onEmptyBackspace();
    },
    type(len, angle) {
      if (!onCommit) throw new Error("no Type to Draw field is open");
      return onCommit([len, angle]);
    },
  };
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

const click = (t: PolylineTool, h: Harness, p: Vec2) => t.onPointerDown(evt(p), h.ctx);
const move = (t: PolylineTool, h: Harness, p: Vec2) => t.onPointerMove(evt(p), h.ctx);

/**
 * The tool reads only `.key`, and this file runs in the default (DOM-less) node
 * environment where `new KeyboardEvent()` does not exist — a stub beats pulling
 * in happy-dom for one field.
 */
const press = (t: PolylineTool, h: Harness, key: string) =>
  t.onKeyDown({ key } as KeyboardEvent, h.ctx);

const polysOf = (doc: CADDocument) =>
  doc.entities.filter((e): e is PolylineEntity => e instanceof PolylineEntity);

const only = (doc: CADDocument) => {
  const found = polysOf(doc);
  expect(found).toHaveLength(1);
  return found[0];
};

describe("PolylineTool — clicking", () => {
  it("chains clicked vertices and finishes open on Enter", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new PolylineTool();
    click(tool, h, { x: 0, y: 0 });
    click(tool, h, { x: 50, y: 0 });
    click(tool, h, { x: 50, y: 40 });
    press(tool, h, "Enter");

    const pl = only(doc);
    expect(pl.points).toHaveLength(3);
    expect(pl.closed).toBe(false);
  });

  it("closes the loop when the first vertex is clicked again", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new PolylineTool();
    click(tool, h, { x: 0, y: 0 });
    click(tool, h, { x: 50, y: 0 });
    click(tool, h, { x: 50, y: 40 });
    click(tool, h, { x: 0, y: 0 }); // back to the start

    expect(only(doc).closed).toBe(true);
  });
});

describe("PolylineTool — Type to Draw", () => {
  it("arms fields at the first vertex and re-arms after each one", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new PolylineTool();
    expect(h.fieldsOpen()).toBe(false);
    click(tool, h, { x: 0, y: 0 });
    expect(h.fieldsOpen()).toBe(true);
    h.type("50", "0"); // commits a segment…
    expect(h.fieldsOpen(), "the next segment should be ready to type").toBe(true);
  });

  it("builds an exact profile with no measured clicks", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new PolylineTool();
    click(tool, h, { x: 0, y: 0 });
    h.type("60", "0"); // 60mm east
    h.type("40", "90"); // 40mm north
    h.type("60", "180"); // 60mm west
    h.type("", ""); // Enter on empty finishes

    const pl = only(doc);
    expect(pl.points).toHaveLength(4);
    expect(pl.points[1].x).toBeCloseTo(60, 9);
    expect(pl.points[1].y).toBeCloseTo(0, 9);
    expect(pl.points[2].x).toBeCloseTo(60, 9);
    expect(pl.points[2].y).toBeCloseTo(40, 9);
    expect(pl.points[3].x).toBeCloseTo(0, 9);
    expect(pl.points[3].y).toBeCloseTo(40, 9);
  });

  it("adds the H/V constraint each typed orthogonal segment implies", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new PolylineTool();
    click(tool, h, { x: 0, y: 0 });
    h.type("60", "0");
    h.type("40", "90");
    h.type("", "");

    const types = doc.constraints.map((c) => c.type);
    expect(types).toContain("horizontal");
    expect(types).toContain("vertical");
  });

  it("Enter on empty fields finishes — the tool's own reflex is not swallowed", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new PolylineTool();
    click(tool, h, { x: 0, y: 0 });
    click(tool, h, { x: 30, y: 0 });
    expect(h.type("", "")).toBe(true);

    expect(only(doc).points).toHaveLength(2);
    expect(h.fieldsOpen(), "finishing should not leave fields armed").toBe(false);
  });

  it("Backspace on empty fields steps back a vertex", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new PolylineTool();
    click(tool, h, { x: 0, y: 0 });
    h.type("60", "0");
    h.type("40", "90"); // three vertices now
    h.emptyBackspace(); // drop the third
    h.type("", ""); // finish

    const pl = only(doc);
    expect(pl.points).toHaveLength(2);
    expect(pl.points[1].x).toBeCloseTo(60, 9);
  });

  it("measures the next segment from the vertex Backspace returned to", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new PolylineTool();
    click(tool, h, { x: 0, y: 0 });
    h.type("60", "0"); // at (60,0)
    h.type("40", "90"); // at (60,40)
    h.emptyBackspace(); // back to (60,0)
    h.type("10", "90"); // should land at (60,10), not (60,50)
    h.type("", "");

    const pl = only(doc);
    expect(pl.points[2].x).toBeCloseTo(60, 9);
    expect(pl.points[2].y).toBeCloseTo(10, 9);
  });

  it("a length alone follows the cursor's direction", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new PolylineTool();
    click(tool, h, { x: 0, y: 0 });
    move(tool, h, { x: 5, y: 5 }); // 45°
    h.type("100", "");
    h.type("", "");

    const pl = only(doc);
    expect(pl.points[1].x).toBeCloseTo(100 * Math.SQRT1_2, 9);
    expect(pl.points[1].y).toBeCloseTo(100 * Math.SQRT1_2, 9);
  });

  it("rejects unparseable input instead of drawing something else", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new PolylineTool();
    click(tool, h, { x: 0, y: 0 });
    move(tool, h, { x: 50, y: 50 }); // a valid cursor fallback exists…
    expect(h.type("abc", "")).toBe(false); // …and must NOT be used
    expect(h.type("", "nope")).toBe(false);
    expect(polysOf(doc)).toHaveLength(0);
  });

  it("previews exactly what it will commit", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new PolylineTool();
    click(tool, h, { x: 0, y: 0 });
    move(tool, h, { x: 200, y: 0 });
    h.edit("25", "90");

    const preview = tool.getOverlay().previews.find((p) => p.kind === "polyline") as {
      points: Vec2[];
    };
    const tip = preview.points[preview.points.length - 1];
    expect(tip.x).toBeCloseTo(0, 9);
    expect(tip.y).toBeCloseTo(25, 9);

    h.type("25", "90");
    h.type("", "");
    expect(only(doc).points[1].y).toBeCloseTo(25, 9);
  });
});
