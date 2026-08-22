/**
 * A modify tool that cannot do what was asked has to say so.
 *
 * Found by driving the app and comparing against AutoCAD: fillet and chamfer
 * with a value larger than the edges, and extend with nothing in front of it,
 * all did nothing and said nothing. Fillet and chamfer even HAD a message for
 * it — inside `commit` — but every call site returned early on the check in
 * front of it, so the ordinary "too big" case could never reach it. AutoCAD
 * answers those two gestures with "Radius is too large" and "No edge in that
 * direction"; the point is not the wording, it is that something is said.
 *
 * A silent no-op is the worst failure this codebase keeps rediscovering: it is
 * indistinguishable from a missed click, from a dead control, and from a bug.
 */
import { describe, expect, it } from "vitest";
import type { Vec2 } from "../src/core/vec2";
import { SnapEngine } from "../src/input/snapping";
import { CADDocument } from "../src/model/document";
import { LineEntity, RectEntity } from "../src/model/entities";
import { ChamferTool } from "../src/tools/chamferTool";
import { ExtendTool } from "../src/tools/extendTool";
import { FilletTool } from "../src/tools/filletTool";
import type { Tool, ToolContext, ToolPointerEvent } from "../src/tools/tool";

/** A ToolContext that records what the user was told, and any typed-value prompt. */
function makeCtx(doc: CADDocument) {
  const said: string[] = [];
  let typePrompt: ((raws: string[]) => boolean | undefined) | null = null;
  const ctx: ToolContext = {
    doc,
    view: { scale: 1, toWorldLen: (px: number) => px } as ToolContext["view"],
    requestRender() {},
    solve() {},
    pushHistory() {},
    openDimEditor() {},
    currentDof: () => 5,
    openTypeToDraw(_pos, _fields, handlers) {
      typePrompt = handlers.onCommit;
    },
    activateTool() {},
    closeTypeToDraw() {},
    notify(msg: string) {
      said.push(msg);
    },
    setHint() {},
    snap: new SnapEngine(),
  };
  return { ctx, said, type: (v: string) => typePrompt?.([v]) };
}

const ev = (pos: Vec2, screen?: Vec2): ToolPointerEvent => ({
  world: pos,
  worldRaw: pos,
  screen: screen ?? pos,
  snap: null,
  button: 0,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
});

/** Click a corner (press and release without moving) to reach the type-in. */
function clickCorner(tool: Tool, ctx: ToolContext, at: Vec2): void {
  tool.onPointerMove?.(ev(at), ctx);
  tool.onPointerDown?.(ev(at), ctx);
  tool.onPointerUp?.(ev(at), ctx);
}

describe("fillet refuses out loud", () => {
  /** Two 40mm legs meeting at (60,40) — no radius over 40 can fit. */
  function twoLegs(): CADDocument {
    const doc = new CADDocument({ width: 200, height: 200 });
    doc.add(new LineEntity({ x: 20, y: 40 }, { x: 60, y: 40 }));
    doc.add(new LineEntity({ x: 60, y: 40 }, { x: 60, y: 80 }));
    return doc;
  }

  it("says why a radius bigger than the legs was not applied", () => {
    const doc = twoLegs();
    const { ctx, said, type } = makeCtx(doc);
    clickCorner(new FilletTool(), ctx, { x: 60, y: 40 });
    expect(type("500"), "the prompt should stay open on a refusal").toBe(false);
    expect(said.join(" ")).toMatch(/bigger than the lines/i);
    // Positive control: it really did refuse, rather than quietly succeeding.
    expect(doc.entities.some((e) => e.type === "arc")).toBe(false);
  });

  it("still applies a radius that fits, silently", () => {
    const doc = twoLegs();
    const { ctx, said, type } = makeCtx(doc);
    clickCorner(new FilletTool(), ctx, { x: 60, y: 40 });
    type("10");
    expect(doc.entities.some((e) => e.type === "arc")).toBe(true);
    // A tool that narrates its successes is noise.
    expect(said).toEqual([]);
  });

  it("gives a shape's corner its own reason — the edge it shares", () => {
    // A rectangle's refusal is a different inequality from a loose pair of
    // lines: `this corner + the one next to it <= the edge they share`. The
    // user fixes it differently, so it gets its own sentence.
    const doc = new CADDocument({ width: 300, height: 300 });
    doc.add(new RectEntity({ x: 20, y: 20 }, { x: 120, y: 60 })); // 100 x 40
    const { ctx, said, type } = makeCtx(doc);
    clickCorner(new FilletTool(), ctx, { x: 20, y: 20 });
    expect(type("45")).toBe(false); // more than the 40mm side can hold
    expect(said.join(" ")).toMatch(/each edge has to hold this corner/i);
  });

  it("takes a radius that fits the short side, so the refusal is not blanket", () => {
    // The positive control for the test above: 35 leaves 5mm for its neighbour
    // on the 40mm side, and is accepted without comment.
    const doc = new CADDocument({ width: 300, height: 300 });
    const r = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 120, y: 60 })) as RectEntity;
    const { ctx, said, type } = makeCtx(doc);
    clickCorner(new FilletTool(), ctx, { x: 20, y: 20 });
    type("35");
    expect(said).toEqual([]);
    expect(r.cornerRadii[0]).toBeCloseTo(35);
  });

  it("says nothing for a drag that went nowhere — that is not a refusal", () => {
    const doc = twoLegs();
    const { ctx, said } = makeCtx(doc);
    const tool = new FilletTool();
    tool.onPointerMove?.(ev({ x: 60, y: 40 }), ctx);
    tool.onPointerDown?.(ev({ x: 60, y: 40 }, { x: 300, y: 300 }), ctx);
    // Released far enough to count as a drag, but back at zero radius.
    tool.onPointerUp?.(ev({ x: 60, y: 40 }, { x: 380, y: 380 }), ctx);
    expect(said).toEqual([]);
  });
});

describe("chamfer refuses out loud", () => {
  it("says why a distance bigger than the legs was not applied", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    doc.add(new LineEntity({ x: 20, y: 40 }, { x: 60, y: 40 }));
    doc.add(new LineEntity({ x: 60, y: 40 }, { x: 60, y: 80 }));
    const { ctx, said, type } = makeCtx(doc);
    clickCorner(new ChamferTool(), ctx, { x: 60, y: 40 });
    expect(type("500")).toBe(false);
    expect(said.join(" ")).toMatch(/bigger than the lines/i);
  });
});

describe("extend refuses out loud", () => {
  it("says so when nothing lies in the direction it would grow", () => {
    const doc = new CADDocument({ width: 300, height: 300 });
    // A line alone in space: there is nothing for it to reach.
    doc.add(new LineEntity({ x: 30, y: 150 }, { x: 90, y: 150 }));
    const { ctx, said } = makeCtx(doc);
    new ExtendTool().onPointerDown?.(ev({ x: 88, y: 150 }), ctx);
    expect(said.join(" ")).toMatch(/nothing in that direction/i);
  });

  it("stays quiet on a click that hit nothing at all", () => {
    // An ordinary miss is not a refusal — the tool has nothing to report.
    const doc = new CADDocument({ width: 300, height: 300 });
    doc.add(new LineEntity({ x: 30, y: 150 }, { x: 90, y: 150 }));
    const { ctx, said } = makeCtx(doc);
    new ExtendTool().onPointerDown?.(ev({ x: 250, y: 40 }), ctx);
    expect(said).toEqual([]);
  });

  it("extends without comment when there IS a boundary", () => {
    const doc = new CADDocument({ width: 300, height: 300 });
    const short = doc.add(new LineEntity({ x: 30, y: 60 }, { x: 70, y: 60 })) as LineEntity;
    doc.add(new LineEntity({ x: 120, y: 20 }, { x: 120, y: 120 }));
    const { ctx, said } = makeCtx(doc);
    new ExtendTool().onPointerDown?.(ev({ x: 68, y: 60 }), ctx);
    expect(short.b.x).toBeCloseTo(120);
    expect(said).toEqual([]);
  });
});

describe("a typed zero means \"make this corner sharp\"", () => {
  // AutoCAD's canonical use of FILLET: radius 0 removes the round. The field
  // used to swallow it — `r <= 0` was rejected before anything looked at the
  // corner — so you typed 0, pressed Enter, and the prompt just sat there.

  it("clears a rectangle corner's radius", () => {
    const doc = new CADDocument({ width: 300, height: 300 });
    const r = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 220, y: 120 })) as RectEntity;
    r.cornerRadii = [15, 0, 0, 0];
    const { ctx, said, type } = makeCtx(doc);
    clickCorner(new FilletTool(), ctx, { x: 20, y: 20 });
    type("0");
    expect(r.cornerRadii[0]).toBe(0);
    expect(said).toEqual([]);
  });

  it("clears a chamfer's setback the same way", () => {
    const doc = new CADDocument({ width: 300, height: 300 });
    const r = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 220, y: 120 })) as RectEntity;
    r.cornerRadii = [12, 0, 0, 0];
    const { ctx, type } = makeCtx(doc);
    clickCorner(new ChamferTool(), ctx, { x: 20, y: 20 });
    type("0");
    expect(r.cornerRadii[0]).toBe(0);
  });

  it("says why it cannot clear a corner between two loose lines", () => {
    // That fillet was surgery: the arc is its own entity, and the two legs were
    // trimmed. There is no stored value for a zero to clear.
    const doc = new CADDocument({ width: 200, height: 200 });
    doc.add(new LineEntity({ x: 20, y: 40 }, { x: 60, y: 40 }));
    doc.add(new LineEntity({ x: 60, y: 40 }, { x: 60, y: 80 }));
    const { ctx, said, type } = makeCtx(doc);
    clickCorner(new FilletTool(), ctx, { x: 60, y: 40 });
    expect(type("0")).toBe(false);
    expect(said.join(" ")).toMatch(/already rounded/i);
  });

  it("still says nothing for a drag that ended back at zero", () => {
    // The distinction the fix turns on: a typed 0 is a request, a drag to 0 is
    // a non-gesture. Only one of them gets an answer.
    const doc = new CADDocument({ width: 300, height: 300 });
    const r = doc.add(new RectEntity({ x: 20, y: 20 }, { x: 220, y: 120 })) as RectEntity;
    r.cornerRadii = [15, 0, 0, 0];
    const { ctx, said } = makeCtx(doc);
    const tool = new FilletTool();
    tool.onPointerMove?.(ev({ x: 20, y: 20 }), ctx);
    tool.onPointerDown?.(ev({ x: 20, y: 20 }, { x: 300, y: 300 }), ctx);
    tool.onPointerUp?.(ev({ x: 20, y: 20 }, { x: 380, y: 380 }), ctx);
    expect(said).toEqual([]);
    expect(r.cornerRadii[0], "and it did not clear the corner either").toBe(15);
  });
});
