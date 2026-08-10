/**
 * Chamfer tool: click or drag a corner to bevel it.
 *
 * Drag away from the corner for a live preview — release to commit.
 * Click without dragging to type an exact distance instead.
 * Works on line-line corners and polyline / polygon vertices.
 */

import { type Vec2, dist } from "../core/vec2";
import { LineEntity } from "../model/entities";
import type { CADDocument } from "../model/document";
import type { Tool, ToolContext, ToolOverlay, ToolPointerEvent } from "./tool";
import { parseLength, formatLengthWithUnit } from "../core/units";
import type { Unit } from "../core/units";
import type { PreviewShape } from "../view/overlay";
import { ICONS } from "./icons";
import {
  CORNER_EPS,
  DRAG_THRESHOLD_PX,
  type Corner,
  type CornerDirs,
  cornerAngle,
  dropCornerJoin,
  findCorner,
  getCornerDirs,
  joinCornerEnds,
  spliceCornerVertices,
  trimCornerLegs,
} from "./corner";

interface ChamferGeo {
  T1: Vec2;
  T2: Vec2;
}

type Phase = "idle" | "dragging";

// ---------------------------------------------------------------------------
// Geometry — the straight bevel across both legs. Corner picking and the
// surgery around this live in ./corner.ts, shared with the fillet tool.
// ---------------------------------------------------------------------------

function computeGeo(dirs: CornerDirs, d: number): ChamferGeo | null {
  const { P, d1, len1, d2, len2 } = dirs;
  if (cornerAngle(dirs) === null) return null;
  if (d <= 0 || d >= len1 - CORNER_EPS || d >= len2 - CORNER_EPS) return null;
  return {
    T1: { x: P.x + d * d1.x, y: P.y + d * d1.y },
    T2: { x: P.x + d * d2.x, y: P.y + d * d2.y },
  };
}

function buildPreviews(corner: Corner, value: number, unit: Unit): PreviewShape[] {
  const base: PreviewShape = { kind: "point", pos: corner.pos };
  if (value <= 0) return [base];
  const dirs = getCornerDirs(corner);
  if (!dirs) return [base];
  const geo = computeGeo(dirs, value);
  if (!geo) return [base];
  return [
    base,
    { kind: "line", a: geo.T1, b: geo.T2 },
    { kind: "text", pos: corner.pos, text: formatLengthWithUnit(value, unit), dx: 12, dy: -12 },
  ];
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function applyChamfer(corner: Corner, distance: number, doc: CADDocument): boolean {
  const dirs = getCornerDirs(corner);
  if (!dirs) return false;
  const geo = computeGeo(dirs, distance);
  if (!geo) return false;

  if (corner.kind === "line") {
    trimCornerLegs(corner, geo.T1, geo.T2);
    dropCornerJoin(doc, corner);

    const chamfer = new LineEntity(geo.T1, geo.T2);
    doc.add(chamfer);
    joinCornerEnds(doc, corner, chamfer.id, "a", "b", "chamfer");
  } else {
    // poly or rect — splice the two chamfer points in
    spliceCornerVertices(corner, doc, [geo.T1, geo.T2]);
  }

  return true;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export class ChamferTool implements Tool {
  readonly id = "chamfer";
  readonly label = "Chamfer";
  readonly icon = ICONS.chamfer;

  private phase: Phase = "idle";
  private hoverCorner: Corner | null = null;
  private activeCorner: Corner | null = null;
  private downScreen: Vec2 = { x: 0, y: 0 };
  private currentValue = 0;
  private previews: PreviewShape[] = [];

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    if (this.phase === "idle") {
      const c = findCorner(e.worldRaw, ctx.doc, ctx.view.scale);
      if (c?.pos !== this.hoverCorner?.pos) {
        this.hoverCorner = c;
        ctx.requestRender();
      }
      return;
    }
    const corner = this.activeCorner!;
    const d = dist(e.worldRaw, corner.pos);
    this.currentValue = d;
    this.previews = buildPreviews(corner, d, ctx.doc.displayUnit);
    ctx.requestRender();
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    const corner = findCorner(e.worldRaw, ctx.doc, ctx.view.scale);
    if (!corner) return;
    this.phase = "dragging";
    this.activeCorner = corner;
    this.downScreen = { ...e.screen };
    this.currentValue = 0;
    this.previews = [{ kind: "point", pos: corner.pos }];
    ctx.requestRender();
  }

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext): void {
    if (this.phase !== "dragging" || !this.activeCorner) return;
    const corner = this.activeCorner;
    const screenDelta = dist(e.screen, this.downScreen);
    this.reset(ctx);

    if (screenDelta < DRAG_THRESHOLD_PX) {
      // click — open value editor for precise input
      ctx.openValueEditor(
        corner.pos,
        `chamfer distance (${ctx.doc.displayUnit})`,
        (raw) => {
          const d = parseLength(raw, ctx.doc.displayUnit);
          if (d === null || d <= 0) return false;
          const dirs = getCornerDirs(corner);
          if (!dirs || !computeGeo(dirs, d)) return false;
          ctx.pushHistory();
          applyChamfer(corner, d, ctx.doc);
          ctx.solve();
          ctx.doc.emitChange();
        },
        () => {},
      );
    } else {
      // drag commit
      const dirs = getCornerDirs(corner);
      if (dirs && computeGeo(dirs, this.currentValue)) {
        ctx.pushHistory();
        applyChamfer(corner, this.currentValue, ctx.doc);
        ctx.solve();
        ctx.doc.emitChange();
      }
    }
  }

  private reset(ctx: ToolContext): void {
    this.phase = "idle";
    this.activeCorner = null;
    this.previews = [];
    ctx.requestRender();
  }

  cancel(ctx: ToolContext): void {
    this.reset(ctx);
    this.hoverCorner = null;
  }

  getOverlay(): ToolOverlay {
    if (this.phase === "dragging") return { previews: this.previews, selectionRect: null };
    if (this.hoverCorner)
      return { previews: [{ kind: "point", pos: this.hoverCorner.pos }], selectionRect: null };
    return { previews: [], selectionRect: null };
  }
}
