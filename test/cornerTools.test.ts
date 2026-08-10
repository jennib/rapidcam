/**
 * Characterization tests for Fillet and Chamfer.
 *
 * Written BEFORE extracting their shared corner code (findCorner,
 * getCornerDirs, the constraint bookkeeping and the polyline splice were
 * duplicated verbatim between the two files) — neither tool had a single test,
 * so there was nothing to catch a behaviour change during the move. Every
 * expectation here was taken from the behaviour as it stood, not from what the
 * behaviour ought to be.
 *
 * Both tools are driven through their real gesture — press and release on the
 * corner without moving, which is the click that asks for a typed value — so
 * the private helpers are exercised through the path a user actually takes.
 */

import { describe, it, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import {
  ArcEntity,
  type Entity,
  LineEntity,
  PolylineEntity,
  RectEntity,
} from "../src/model/entities";
import { SnapEngine } from "../src/input/snapping";
import { FilletTool } from "../src/tools/filletTool";
import { ChamferTool } from "../src/tools/chamferTool";
import type { Tool, ToolContext, ToolPointerEvent } from "../src/tools/tool";
import type { Vec2 } from "../src/core/vec2";

interface Harness {
  ctx: ToolContext;
  /** Type a value into whatever field is open and press Enter. */
  type(raw: string): boolean | undefined;
  editorOpen(): boolean;
  solves: number;
}

function makeCtx(doc: CADDocument, scale = 1): Harness {
  let onCommit: ((raws: string[]) => boolean | undefined) | null = null;
  const h: Harness = {
    solves: 0,
    editorOpen: () => onCommit !== null,
    type(raw) {
      if (!onCommit) throw new Error("no Type to Draw field is open");
      return onCommit([raw]);
    },
    ctx: {
      doc,
      view: { scale } as ToolContext["view"],
      requestRender() {},
      solve() {
        h.solves++;
      },
      pushHistory() {},
      openDimEditor() {},
      currentDof: () => 0,
      openTypeToDraw(_pos, _fields, handlers) {
        onCommit = handlers.onCommit;
      },
      closeTypeToDraw() {
        onCommit = null;
      },
      notify() {},
      setHint() {},
      snap: new SnapEngine(),
    },
  };
  return h;
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

/** Press and release on `pos` without moving — the gesture that asks for a typed value. */
function clickCorner(tool: Tool, h: Harness, pos: Vec2): void {
  tool.onPointerDown?.(evt(pos), h.ctx);
  tool.onPointerUp?.(evt(pos), h.ctx);
}

/** An L: (50,0) → (0,0) → (0,50), joined at the origin by a coincident constraint. */
function lCorner(doc: CADDocument): { l1: LineEntity; l2: LineEntity } {
  const l1 = new LineEntity({ x: 0, y: 0 }, { x: 50, y: 0 });
  const l2 = new LineEntity({ x: 0, y: 0 }, { x: 0, y: 50 });
  doc.add(l1);
  doc.add(l2);
  doc.addConstraint({
    id: "join",
    type: "coincident",
    points: [
      { entityId: l1.id, key: "a" },
      { entityId: l2.id, key: "a" },
    ],
    entities: [],
    params: [],
  });
  return { l1, l2 };
}

const ofType = <T extends Entity>(doc: CADDocument, ctor: abstract new (...a: never[]) => T): T[] =>
  doc.entities.filter((e): e is T => e instanceof ctor);

describe("Fillet", () => {
  it("rounds a line-line corner: inserts the arc and trims both legs", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const { l1, l2 } = lCorner(doc);
    const h = makeCtx(doc);
    const tool = new FilletTool();

    clickCorner(tool, h, { x: 0, y: 0 });
    expect(h.editorOpen(), "clicking a corner should ask for a radius").toBe(true);
    h.type("10");

    // A 90° corner with r=10: tangent points 10mm along each leg, arc centred
    // on the bisector at (10,10).
    const arcs = ofType(doc, ArcEntity);
    expect(arcs).toHaveLength(1);
    expect(arcs[0].center.x).toBeCloseTo(10, 9);
    expect(arcs[0].center.y).toBeCloseTo(10, 9);
    expect(arcs[0].radius).toBeCloseTo(10, 9);

    // Not toEqual: the tangent length comes out of a tan(), so it lands on
    // 10.000000000000002 rather than 10.
    expect(l1.a.x).toBeCloseTo(10, 9);
    expect(l1.a.y).toBeCloseTo(0, 9);
    expect(l2.a.x).toBeCloseTo(0, 9);
    expect(l2.a.y).toBeCloseTo(10, 9);
    expect(h.solves).toBeGreaterThan(0);
  });

  it("re-wires the corner's constraints: the old join goes, two new ones arrive", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    lCorner(doc);
    const h = makeCtx(doc);
    clickCorner(new FilletTool(), h, { x: 0, y: 0 });
    h.type("10");

    // The two lines no longer meet, so the coincidence that held them together
    // must be gone — leaving it would fight the solver.
    expect(doc.constraints.find((c) => c.id === "join")).toBeUndefined();
    const arc = ofType(doc, ArcEntity)[0];
    const added = doc.constraints.filter((c) => c.points.some((p) => p.entityId === arc.id));
    expect(added).toHaveLength(2);
    expect(added.every((c) => c.type === "coincident")).toBe(true);
  });

  it("refuses a radius that will not fit between the legs", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    lCorner(doc); // 50mm legs
    const h = makeCtx(doc);
    clickCorner(new FilletTool(), h, { x: 0, y: 0 });

    expect(h.type("500")).toBe(false);
    expect(ofType(doc, ArcEntity)).toHaveLength(0);
  });

  it("turns a filleted rectangle into a polyline with a tessellated corner", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    doc.add(new RectEntity({ x: 0, y: 0 }, { x: 100, y: 60 }));
    const h = makeCtx(doc);
    clickCorner(new FilletTool(), h, { x: 0, y: 0 });
    h.type("8");

    expect(ofType(doc, RectEntity), "the rect is consumed").toHaveLength(0);
    const pls = ofType(doc, PolylineEntity);
    expect(pls).toHaveLength(1);
    expect(pls[0].closed).toBe(true);
    // 4 corners, one replaced by an arc's worth of points.
    expect(pls[0].points.length).toBeGreaterThan(4);
  });

  it("splices an arc into a closed polyline vertex in place", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const pl = new PolylineEntity(
      [
        { x: 0, y: 0 },
        { x: 60, y: 0 },
        { x: 60, y: 40 },
        { x: 0, y: 40 },
      ],
      true,
    );
    doc.add(pl);
    const h = makeCtx(doc);
    clickCorner(new FilletTool(), h, { x: 60, y: 0 });
    h.type("5");

    expect(ofType(doc, PolylineEntity)).toHaveLength(1);
    expect(pl.points.length).toBeGreaterThan(4);
    expect(ofType(doc, ArcEntity), "a polyline corner stays one polyline").toHaveLength(0);
  });
});

describe("Chamfer", () => {
  it("bevels a line-line corner: inserts the bevel line and trims both legs", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const { l1, l2 } = lCorner(doc);
    const h = makeCtx(doc);

    clickCorner(new ChamferTool(), h, { x: 0, y: 0 });
    expect(h.editorOpen()).toBe(true);
    h.type("10");

    // Three lines now: the two trimmed legs plus the bevel across them.
    const lines = ofType(doc, LineEntity);
    expect(lines).toHaveLength(3);
    expect(l1.a).toEqual({ x: 10, y: 0 });
    expect(l2.a).toEqual({ x: 0, y: 10 });

    const bevel = lines.find((l) => l !== l1 && l !== l2);
    if (!bevel) throw new Error("no bevel line");
    expect(bevel.a).toEqual({ x: 10, y: 0 });
    expect(bevel.b).toEqual({ x: 0, y: 10 });

    expect(doc.constraints.find((c) => c.id === "join")).toBeUndefined();
    expect(doc.constraints.filter((c) => c.points.some((p) => p.entityId === bevel.id))).toHaveLength(2);
  });

  it("refuses a distance longer than the legs", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    lCorner(doc);
    const h = makeCtx(doc);
    clickCorner(new ChamferTool(), h, { x: 0, y: 0 });

    expect(h.type("500")).toBe(false);
    expect(ofType(doc, LineEntity)).toHaveLength(2); // still just the two legs
  });

  it("splices two points into a rectangle corner, becoming a polyline", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    doc.add(new RectEntity({ x: 0, y: 0 }, { x: 100, y: 60 }));
    const h = makeCtx(doc);
    clickCorner(new ChamferTool(), h, { x: 100, y: 60 });
    h.type("8");

    expect(ofType(doc, RectEntity)).toHaveLength(0);
    const pls = ofType(doc, PolylineEntity);
    expect(pls).toHaveLength(1);
    // One corner replaced by exactly two points: 4 - 1 + 2 = 5.
    expect(pls[0].points).toHaveLength(5);
  });
});

describe("Corner picking — shared by both tools", () => {
  it("ignores a click nowhere near a corner", () => {
    for (const tool of [new FilletTool(), new ChamferTool()]) {
      const doc = new CADDocument({ width: 400, height: 300 });
      lCorner(doc);
      const h = makeCtx(doc);
      clickCorner(tool, h, { x: 200, y: 200 });
      expect(h.editorOpen(), `${tool.id} bit on empty space`).toBe(false);
    }
  });

  it("scales the pick radius with zoom, so it is a constant 16px on screen", () => {
    // A unit ToolContext that hardcodes scale 1 cannot tell a world-unit band
    // from a screen-pixel one. 20mm out is inside the band at scale 1 (16mm…
    // no) and outside at scale 2 — pin the ratio, not just the default.
    const near = { x: 10, y: 0 }; // 10mm from the corner
    for (const [scale, shouldHit] of [
      [1, true], // 16px / 1 = 16mm band -> 10mm is inside
      [4, false], // 16px / 4 = 4mm band -> 10mm is outside
    ] as const) {
      const doc = new CADDocument({ width: 400, height: 300 });
      lCorner(doc);
      const h = makeCtx(doc, scale);
      clickCorner(new FilletTool(), h, near);
      expect(h.editorOpen(), `scale ${scale} should ${shouldHit ? "" : "not "}hit`).toBe(shouldHit);
    }
  });

  it("does not bite on construction geometry", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    const { l1, l2 } = lCorner(doc);
    l1.isConstruction = true;
    l2.isConstruction = true;
    const h = makeCtx(doc);
    clickCorner(new FilletTool(), h, { x: 0, y: 0 });
    expect(h.editorOpen()).toBe(false);
  });

  it("skips the open ends of an unclosed polyline — they are not corners", () => {
    const doc = new CADDocument({ width: 400, height: 300 });
    doc.add(
      new PolylineEntity(
        [
          { x: 0, y: 0 },
          { x: 60, y: 0 },
          { x: 60, y: 40 },
        ],
        false,
      ),
    );
    const h = makeCtx(doc);
    clickCorner(new FilletTool(), h, { x: 0, y: 0 }); // a free end
    expect(h.editorOpen()).toBe(false);

    const h2 = makeCtx(doc);
    clickCorner(new FilletTool(), h2, { x: 60, y: 0 }); // the interior vertex
    expect(h2.editorOpen(), "positive control: the middle vertex IS a corner").toBe(true);
  });
});
