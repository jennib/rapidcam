/**
 * BezierTool — Type to Draw on the CHORD only.
 *
 * The deliberate boundary is the point of this file: p0→p3 is a dimensioned
 * quantity and gets fields; the two control handles do not, because a cubic's
 * control arms have no engineering convention behind them. The last test pins
 * that boundary so nobody "completes" it by adding handle fields later.
 */

import { describe, it, expect } from "vitest";
import { BezierEntity } from "../src/model/entities";
import { CADDocument } from "../src/model/document";
import { BezierTool } from "../src/tools/bezierTool";
import type { ToolContext } from "../src/tools/tool";
import { SnapEngine } from "../src/input/snapping";
import type { Vec2 } from "../src/core/vec2";

interface Harness {
  ctx: ToolContext;
  type(len: string, angle: string): boolean | undefined;
  edit(len: string, angle: string): void;
  fieldsOpen(): boolean;
  opens: number;
}

function makeCtx(doc: CADDocument): Harness {
  let onCommit: ((raws: string[]) => boolean | undefined) | null = null;
  let onChange: ((raws: string[]) => void) | null = null;

  const h: Harness = {
    opens: 0,
    fieldsOpen: () => onCommit !== null,
    edit: (len, angle) => onChange?.([len, angle]),
    type(len, angle) {
      if (!onCommit) throw new Error("no Type to Draw field is open");
      return onCommit([len, angle]);
    },
    ctx: {
      doc,
      view: { scale: 1 } as ToolContext["view"],
      requestRender() {},
      solve() {},
      pushHistory() {},
      openDimEditor() {},
      currentDof: () => 0,
      openTypeToDraw(_pos, _fields, handlers) {
        h.opens++;
        onCommit = handlers.onCommit;
        onChange = handlers.onChange ?? null;
      },
      closeTypeToDraw() {
        onCommit = null;
        onChange = null;
      },
      notify() {},
      setHint() {},
      snap: new SnapEngine(),
    },
  };
  return h;
}

function click(tool: BezierTool, h: Harness, pos: Vec2): void {
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
    },
    h.ctx,
  );
}

const beziersOf = (doc: CADDocument) =>
  doc.entities.filter((e): e is BezierEntity => e instanceof BezierEntity);

describe("BezierTool — Type to Draw on the chord", () => {
  it("opens Length/Angle after the start point", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new BezierTool();
    expect(h.fieldsOpen()).toBe(false);
    click(tool, h, { x: 10, y: 10 });
    expect(h.fieldsOpen()).toBe(true);
  });

  it("places the far anchor at the typed length and angle", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new BezierTool();
    click(tool, h, { x: 0, y: 0 });
    expect(h.type("100", "0")).toBe(true);

    // Fields are done; the handles are clicks.
    click(tool, h, { x: 20, y: 30 });
    click(tool, h, { x: 80, y: 30 });

    const curves = beziersOf(doc);
    expect(curves).toHaveLength(1);
    expect(curves[0].p0).toEqual({ x: 0, y: 0 });
    expect(curves[0].p3.x).toBeCloseTo(100, 9);
    expect(curves[0].p3.y).toBeCloseTo(0, 9);
  });

  it("a typed chord beats a second click that lands elsewhere", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new BezierTool();
    click(tool, h, { x: 0, y: 0 });
    h.edit("50", "90");
    click(tool, h, { x: 300, y: 300 }); // far away — the typed end wins
    click(tool, h, { x: 10, y: 10 });
    click(tool, h, { x: 20, y: 40 });

    const c = beziersOf(doc)[0];
    expect(c.p3.x).toBeCloseTo(0, 9);
    expect(c.p3.y).toBeCloseTo(50, 9);
  });

  it("rejects unparseable input rather than falling back to the cursor", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new BezierTool();
    click(tool, h, { x: 0, y: 0 });
    expect(h.type("abc", "")).toBe(false);
    expect(h.type("", "")).toBe(false);
    expect(beziersOf(doc)).toHaveLength(0);
  });

  it("the handles are mouse-only — no fields open for them, by design", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const h = makeCtx(doc);
    const tool = new BezierTool();

    click(tool, h, { x: 0, y: 0 }); // start → chord fields open
    expect(h.opens).toBe(1);
    h.type("100", "0"); // chord committed
    expect(h.fieldsOpen(), "the chord fields must close, not follow into p1").toBe(false);

    click(tool, h, { x: 20, y: 30 }); // handle 1
    click(tool, h, { x: 80, y: 30 }); // handle 2
    // A control arm has no dimension worth typing, so the count never grew.
    expect(h.opens, "a handle opened a field — see the bezierTool header").toBe(1);
    expect(beziersOf(doc)).toHaveLength(1);
  });
});
