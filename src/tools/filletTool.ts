/**
 * Fillet tool: click or drag a corner to round it.
 *
 * Drag away from the corner for a live preview — release to commit.
 * Click without dragging to type an exact radius instead.
 * Works on line-line corners and polyline / polygon vertices.
 *
 * For line-line corners an ArcEntity is inserted and the lines are trimmed.
 * For polyline / polygon vertices the corner is replaced in-place with
 * tessellated arc points (~2° per step) so the result stays a single
 * offsettable PolylineEntity.
 */

import { type Vec2, dist } from "../core/vec2";
import { ArcEntity } from "../model/entities";
import type { CADDocument } from "../model/document";
import type { Tool, ToolContext, ToolOverlay, ToolPointerEvent } from "./tool";
import { parseLength, formatLengthWithUnit } from "../core/units";
import type { Unit } from "../core/units";
import type { PreviewShape } from "../view/overlay";
import { TAU } from "../core/geom";
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

interface FilletGeo {
  T1: Vec2;
  T2: Vec2;
  C: Vec2;
  a1: number;
  a2: number;
}

type Phase = "idle" | "dragging";

// ---------------------------------------------------------------------------
// Geometry — the arc tangent to both legs. Corner picking and the surgery
// around this live in ./corner.ts, shared with the chamfer tool.
// ---------------------------------------------------------------------------

function computeGeo(dirs: CornerDirs, r: number): FilletGeo | null {
  const { P, d1, len1, d2, len2 } = dirs;
  const angle = cornerAngle(dirs);
  if (angle === null) return null;
  const tangentLen = r / Math.tan(angle / 2);
  if (r <= 0 || tangentLen >= len1 - CORNER_EPS || tangentLen >= len2 - CORNER_EPS) return null;

  const T1: Vec2 = { x: P.x + tangentLen * d1.x, y: P.y + tangentLen * d1.y };
  const T2: Vec2 = { x: P.x + tangentLen * d2.x, y: P.y + tangentLen * d2.y };

  const bx = d1.x + d2.x,
    by = d1.y + d2.y;
  const bl = Math.sqrt(bx * bx + by * by);
  if (bl < 1e-9) return null;
  const arcDist = r / Math.sin(angle / 2);
  const C: Vec2 = { x: P.x + (bx / bl) * arcDist, y: P.y + (by / bl) * arcDist };

  return {
    T1,
    T2,
    C,
    a1: Math.atan2(T1.y - C.y, T1.x - C.x),
    a2: Math.atan2(T2.y - C.y, T2.x - C.x),
  };
}

/** Short arc from T1 (angle a1) to T2 (angle a2), expressed as a CCW arc (startAngle < endAngle). */
function shortArcAngles(a1: number, a2: number): { startAngle: number; endAngle: number } {
  let span = (((a2 - a1) % TAU) + TAU) % TAU;
  if (span > Math.PI) span -= TAU; // take the short way; span may now be negative (CW)
  return span >= 0
    ? { startAngle: a1, endAngle: a1 + span }
    : { startAngle: a1 + span, endAngle: a1 };
}

function buildPreviews(corner: Corner, radius: number, unit: Unit): PreviewShape[] {
  const base: PreviewShape = { kind: "point", pos: corner.pos };
  if (radius <= 0) return [base];
  const dirs = getCornerDirs(corner);
  if (!dirs) return [base];
  const geo = computeGeo(dirs, radius);
  if (!geo) return [base];
  const { startAngle, endAngle } = shortArcAngles(geo.a1, geo.a2);
  return [
    base,
    { kind: "arc", center: geo.C, radius, startAngle, endAngle },
    { kind: "text", pos: corner.pos, text: formatLengthWithUnit(radius, unit), dx: 12, dy: -12 },
  ];
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function applyFillet(corner: Corner, radius: number, doc: CADDocument): boolean {
  const dirs = getCornerDirs(corner);
  if (!dirs) return false;
  const geo = computeGeo(dirs, radius);
  if (!geo) return false;

  if (corner.kind === "line") {
    // Determine arc winding (CCW from startAngle to endAngle)
    const crossVal =
      (geo.T1.x - geo.C.x) * (geo.T2.y - geo.C.y) - (geo.T1.y - geo.C.y) * (geo.T2.x - geo.C.x);
    const startAngle = crossVal >= 0 ? geo.a1 : geo.a2;
    const endAngle = crossVal >= 0 ? geo.a2 : geo.a1;
    const arcStartKey: "start" | "end" = crossVal >= 0 ? "start" : "end";
    const arcEndKey: "start" | "end" = crossVal >= 0 ? "end" : "start";

    trimCornerLegs(corner, geo.T1, geo.T2);
    dropCornerJoin(doc, corner);

    const arc = new ArcEntity(geo.C, radius, startAngle, endAngle);
    doc.add(arc);
    joinCornerEnds(doc, corner, arc.id, arcStartKey, arcEndKey, "fillet");
  } else {
    // poly or rect — tessellate the short arc into the polyline
    let span = (((geo.a2 - geo.a1) % TAU) + TAU) % TAU;
    if (span > Math.PI) span -= TAU;
    const steps = Math.max(2, Math.ceil(Math.abs(span) / (Math.PI / 90)));
    const arcPts: Vec2[] = [];
    for (let k = 0; k <= steps; k++) {
      const a = geo.a1 + (span * k) / steps;
      arcPts.push({ x: geo.C.x + radius * Math.cos(a), y: geo.C.y + radius * Math.sin(a) });
    }
    spliceCornerVertices(corner, doc, arcPts);
  }

  return true;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export class FilletTool implements Tool {
  readonly id = "fillet";
  readonly label = "Fillet";
  readonly icon = ICONS.fillet;

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
    const r = dist(e.worldRaw, corner.pos);
    this.currentValue = r;
    this.previews = buildPreviews(corner, r, ctx.doc.displayUnit);
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
        `fillet radius (${ctx.doc.displayUnit})`,
        (raw) => {
          const r = parseLength(raw, ctx.doc.displayUnit);
          if (r === null || r <= 0) return false;
          const dirs = getCornerDirs(corner);
          if (!dirs || !computeGeo(dirs, r)) return false;
          ctx.pushHistory();
          applyFillet(corner, r, ctx.doc);
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
        applyFillet(corner, this.currentValue, ctx.doc);
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
