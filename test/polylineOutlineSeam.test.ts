import { describe, expect, it } from "vitest";
import { generateGCode } from "../src/cam/gcode";
import { generateLaserGCode } from "../src/cam/lasergcode";
import { collectClosedLoops } from "../src/cam/loops";
import { rasterizeStock } from "../src/cam/stockRasterizer";
import type { CAMOperation } from "../src/cam/types";
import type { Vec2 } from "../src/core/vec2";
import { exportDxf } from "../src/io/dxfExport";
import { exportSvg } from "../src/io/svgExport";
import type { Sketch } from "../src/generators/sketch";
import { sketchPreviews } from "../src/generators/preview";
import { CADDocument } from "../src/model/document";
import { LineEntity, PolylineEntity } from "../src/model/entities";
import { explodeSelected } from "../src/tools/explodeCommand";
import { commitOffset } from "../src/tools/offsetTool";
import type { ToolContext, ToolPointerEvent } from "../src/tools/tool";
import { TrimTool } from "../src/tools/trimTool";
import { emptyOverlay } from "../src/view/overlay";
import { Renderer } from "../src/view/renderer";
import { Viewport } from "../src/view/viewport";

/**
 * The drift guard for the polyline outline seam.
 *
 * `PolylineEntity.points` is read two ways — as the vertices a constraint names
 * and as the boundary a toolpath cuts — and nothing about the expression
 * `ent.points` says which one a given line meant. A regex over the word cannot
 * tell them apart, so this guard does not try: it asks each consumer to work on
 * a polyline whose BOUNDARY DIFFERS FROM ITS VERTICES, and checks the answer
 * changed. A consumer still reading the vertex list produces byte-identical
 * output and fails here.
 *
 * `ShapedPolyline` stands in for what Pass B will make real. Its vertices are a
 * plain rectangle; its outline is that rectangle with the corners cut off. That
 * is a chamfered corner in all but the storage, so the guard is a working
 * pre-image of the feature rather than an abstract difference — and it is
 * load-bearing NOW, in a pass that ships no radii at all, which a test written
 * against `cornerRadii: [0,0,0,0]` could never be.
 *
 * Both documents are built identically and the entity ids are pinned, so the
 * only thing that can differ between the two outputs is geometry — not an id in
 * a G-code comment.
 */

const W = 80;
const H = 60;
const CUT = 12; // how much of each corner the "shaped" boundary removes
const ID = "poly-under-test";
const VERTS: Vec2[] = [
  { x: 20, y: 20 },
  { x: 20 + W, y: 20 },
  { x: 20 + W, y: 20 + H },
  { x: 20, y: 20 + H },
];

/** The square corner that only a consumer reading the VERTEX list ever visits. */
const SQUARE_CORNER = VERTS[0];

class ShapedPolyline extends PolylineEntity {
  override outlinePoints(): Vec2[] {
    const out: Vec2[] = [];
    const n = this.points.length;
    for (let i = 0; i < n; i++) {
      const p = this.points[i];
      const prev = this.points[(i + n - 1) % n];
      const next = this.points[(i + 1) % n];
      const towards = (q: Vec2): Vec2 => {
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        return { x: p.x + ((q.x - p.x) / d) * CUT, y: p.y + ((q.y - p.y) / d) * CUT };
      };
      out.push(towards(prev), towards(next));
    }
    return out;
  }
}

function docWith(shaped: boolean): { doc: CADDocument; ent: PolylineEntity } {
  const doc = new CADDocument({ width: 200, height: 200 }, "mm");
  const ent = doc.add(
    shaped ? new ShapedPolyline(VERTS, true, ID) : new PolylineEntity(VERTS, true, ID),
  );
  return { doc, ent };
}

/**
 * A canvas whose 2D context records every path point instead of painting.
 *
 * A Proxy rather than a hand-written stub: the renderer touches a lot of the
 * 2D API and a stub would need updating every time it touched one more, which
 * is a guard that breaks for reasons unrelated to what it guards.
 */
function recordingCanvas(): { canvas: HTMLCanvasElement; path: number[][] } {
  const path: number[][] = [];
  const ctx = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "measureText") return () => ({ width: 10 });
        if (prop === "canvas") return canvas;
        if (prop === "moveTo" || prop === "lineTo")
          return (x: number, y: number) => {
            path.push([Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
          };
        if (prop === "createLinearGradient" || prop === "createPattern")
          return () => ({ addColorStop() {} });
        return () => undefined;
      },
      set: () => true,
    },
  ) as CanvasRenderingContext2D;
  const canvas = {
    getContext: () => ctx,
    width: 600,
    height: 400,
    style: {},
  } as unknown as HTMLCanvasElement;
  return { canvas, path };
}

/** Minimal ToolContext for driving a tool's hover preview. */
function toolCtx(doc: CADDocument): ToolContext {
  return {
    doc,
    view: { scale: 3, toWorldLen: (px: number) => px / 3 },
    requestRender() {},
    solve() {},
    pushHistory() {},
    notify() {},
    setHint() {},
  } as unknown as ToolContext;
}

/** A pointer event at a world position, with the fields a hover handler reads. */
function pointerAt(p: Vec2): ToolPointerEvent {
  return {
    world: p,
    worldRaw: p,
    screen: { x: 0, y: 0 },
    snap: null,
    button: 0,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
  } as ToolPointerEvent;
}

function op(over: Partial<CAMOperation>): CAMOperation {
  return {
    id: "op",
    name: "cut",
    type: "profile",
    side: "outside",
    entityIds: [ID],
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 6,
    feedrate: 1000,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -2,
    stepdown: 2,
    stepover: 0.4,
    laserPower: 80,
    ...over,
  };
}

/**
 * One consumer of the boundary. `run` must return something that changes when
 * the boundary changes and nothing else does.
 */
interface Consumer {
  name: string;
  run: (shaped: boolean) => string;
  /** Proof the consumer actually did something. Defaults to "said enough words". */
  control?: (out: string) => void;
}

const CONSUMERS: Consumer[] = [
  {
    name: "G-code profile",
    run: (s) => {
      const { doc } = docWith(s);
      return generateGCode([op({ type: "profile" })], doc);
    },
  },
  {
    name: "G-code pocket",
    run: (s) => {
      const { doc } = docWith(s);
      return generateGCode([op({ type: "pocket" })], doc);
    },
  },
  {
    name: "G-code engrave",
    run: (s) => {
      const { doc } = docWith(s);
      return generateGCode([op({ type: "engrave" })], doc);
    },
  },
  {
    name: "G-code chamfer",
    run: (s) => {
      const { doc } = docWith(s);
      // A chamfer op is skipped outright unless the tool is a V-bit.
      return generateGCode(
        [op({ type: "chamfer", chamferWidth: 1, toolType: "v-bit", vAngle: 90 })],
        doc,
      );
    },
  },
  {
    name: "G-code v-carve",
    run: (s) => {
      const { doc } = docWith(s);
      return generateGCode([op({ type: "vcarve", toolType: "v-bit", vAngle: 60 })], doc);
    },
  },
  {
    name: "laser G-code",
    run: (s) => {
      const { doc } = docWith(s);
      doc.machineKind = "laser";
      return generateLaserGCode([op({ type: "profile" })], doc);
    },
  },
  {
    name: "laser area fill",
    run: (s) => {
      const { doc } = docWith(s);
      doc.machineKind = "laser";
      return generateLaserGCode([op({ type: "engrave", laserFill: true, laserFillSpacing: 3 })], doc);
    },
  },
  {
    name: "3D preview rasterizer",
    run: (s) => {
      const { doc } = docWith(s);
      const hm = rasterizeStock([op({ type: "profile" })], doc);
      let cut = 0;
      for (let i = 0; i < hm.data.length; i++) if (hm.data[i] < hm.stockT - 1e-6) cut++;
      return String(cut);
    },
    control: (out) => {
      expect(Number(out), "the preview carved no stock at all").toBeGreaterThan(100);
    },
  },
  {
    name: "region loops",
    run: (s) => {
      const { doc } = docWith(s);
      return JSON.stringify(collectClosedLoops(doc.entities).map((l) => l.verts));
    },
  },
  {
    name: "SVG export",
    run: (s) => exportSvg(docWith(s).doc),
  },
  {
    name: "DXF export",
    run: (s) => exportDxf(docWith(s).doc).dxf,
  },
  {
    name: "Explode",
    run: (s) => {
      const { doc, ent } = docWith(s);
      ent.selected = true;
      explodeSelected(doc);
      // Coordinates only. Exploding mints fresh line ids every run, so anything
      // carrying an id would differ between the two documents whatever the
      // geometry did — a difference that proves nothing.
      return JSON.stringify(
        doc.entities
          .filter((e): e is LineEntity => e instanceof LineEntity)
          .map((l) => [l.a.x, l.a.y, l.b.x, l.b.y]),
      );
    },
  },
  {
    name: "Offset",
    run: (s) => {
      const { doc, ent } = docWith(s);
      commitOffset(ent, 4, { doc } as unknown as ToolContext);
      // Coordinates only, for the same reason Explode compares coordinates.
      return JSON.stringify(
        doc.entities
          .filter((e): e is PolylineEntity => e instanceof PolylineEntity && e.id !== ID)
          .map((p) => p.points.map((v) => [v.x, v.y])),
      );
    },
  },
  {
    name: "Canvas renderer",
    run: (s) => {
      const { doc } = docWith(s);
      const { canvas, path } = recordingCanvas();
      const view = new Viewport();
      view.setSize(600, 400);
      view.tx = 0;
      view.ty = 400;
      new Renderer(canvas).render(doc, view, emptyOverlay());
      return JSON.stringify(path);
    },
    control: (out) => {
      expect(JSON.parse(out).length, "the renderer drew nothing").toBeGreaterThan(8);
    },
  },
  {
    name: "Generator preview",
    run: (s) => {
      const { ent } = docWith(s);
      const shapes = sketchPreviews({ entities: [ent] } as unknown as Sketch, { x: 0, y: 0 });
      return JSON.stringify(shapes);
    },
  },
  {
    name: "Trim preview",
    run: (s) => {
      const { doc } = docWith(s);
      // Two crossing lines, so trim finds a span to remove rather than falling
      // through to whole-entity erase. x=25 lands INSIDE the cut-back corner:
      // on the plain boundary it meets the bottom edge, on the shaped one it
      // meets the bevel, so the span that would be removed is a different
      // shape. A crossing in the middle of an edge would have been identical
      // on both and proved nothing.
      doc.add(new LineEntity({ x: 25, y: 0 }, { x: 25, y: 200 }));
      doc.add(new LineEntity({ x: 60, y: 0 }, { x: 60, y: 200 }));
      const tool = new TrimTool();
      tool.onPointerMove(pointerAt({ x: 40, y: 20 }), toolCtx(doc));
      return JSON.stringify(tool.getOverlay().previews);
    },
    control: (out) => {
      expect(JSON.parse(out).length, "trim showed no preview to compare").toBeGreaterThan(0);
    },
  },
];

describe("every consumer of a polyline's boundary goes through outlinePoints()", () => {
  for (const c of CONSUMERS) {
    it(`${c.name} reads the boundary, not the vertex list`, () => {
      const plain = c.run(false);
      const shaped = c.run(true);
      // Positive control: without it, "the two differ" would also pass for a
      // consumer that produced nothing at all in either case.
      const control =
        c.control ??
        ((out: string) => {
          expect(out.length, `${c.name} produced no output to compare`).toBeGreaterThan(20);
        });
      control(plain);
      control(shaped);
      expect(shaped, `${c.name} still reads .points`).not.toEqual(plain);
    });
  }

  it("the stand-in really does move the boundary off the vertices", () => {
    // Guards the guard: if ShapedPolyline ever returned the vertices, every
    // assertion above would be comparing a shape with itself.
    const shaped = new ShapedPolyline(VERTS, true, ID);
    const plain = new PolylineEntity(VERTS, true, ID);
    expect(plain.outlinePoints()).toEqual(VERTS);
    expect(shaped.outlinePoints()).toHaveLength(VERTS.length * 2);
    for (const p of shaped.outlinePoints()) {
      expect(Math.hypot(p.x - SQUARE_CORNER.x, p.y - SQUARE_CORNER.y)).toBeGreaterThan(1e-9);
    }
  });

  it("the toolpath physically avoids the corner the vertex list would have cut", () => {
    // The sharpest form of the same claim, in the units that matter: with the
    // corner cut back by 12mm, an outside profile has no business within a tool
    // radius of where the square corner was.
    const cutPath = (code: string) =>
      code
        .split("\n")
        .filter((l) => /^G[123] /.test(l) && /X/.test(l) && /Y/.test(l))
        .map((l) => ({
          x: parseFloat(l.match(/X(-?[\d.]+)/)![1]),
          y: parseFloat(l.match(/Y(-?[\d.]+)/)![1]),
        }));
    const nearest = (code: string) =>
      Math.min(
        ...cutPath(code).map((p) =>
          Math.hypot(p.x - SQUARE_CORNER.x, p.y - SQUARE_CORNER.y),
        ),
      );

    const plain = generateGCode([op({ type: "profile" })], docWith(false).doc);
    const shaped = generateGCode([op({ type: "profile" })], docWith(true).doc);
    // The plain one goes right past the corner (tool centre offset out by 3mm).
    expect(nearest(plain)).toBeLessThan(5);
    // The shaped one keeps its distance: the corner is 12mm back on both legs.
    expect(nearest(shaped)).toBeGreaterThan(6);
  });
});
