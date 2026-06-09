/**
 * Chamfer tool: click or drag a corner to bevel it.
 *
 * Drag away from the corner for a live preview — release to commit.
 * Click without dragging to type an exact distance instead.
 * Works on line-line corners and polyline / polygon vertices.
 */

import { Vec2, dist } from "../core/vec2";
import { LineEntity, PolylineEntity } from "../model/entities";
import { CADDocument } from "../model/document";
import { Tool, ToolContext, ToolOverlay, ToolPointerEvent } from "./tool";
import { parseLength, formatLengthWithUnit } from "../core/units";
import type { Unit } from "../core/units";
import { PreviewShape } from "../view/overlay";
import { ICONS } from "./icons";

const CORNER_EPS       = 1e-4;
const HIT_PX           = 16;
const DRAG_THRESHOLD_PX = 4;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LineCorner {
  kind: "line";
  line1: LineEntity; key1: "a" | "b";
  line2: LineEntity; key2: "a" | "b";
  pos: Vec2;
}

interface PolyCorner {
  kind: "poly";
  entity: PolylineEntity;
  index: number;
  pos: Vec2;
}

type Corner = LineCorner | PolyCorner;

interface CornerDirs {
  P: Vec2;
  d1: Vec2; len1: number;
  d2: Vec2; len2: number;
}

interface ChamferGeo { T1: Vec2; T2: Vec2; }

type Phase = "idle" | "dragging";

// ---------------------------------------------------------------------------
// Corner detection
// ---------------------------------------------------------------------------

function findCorner(worldPos: Vec2, doc: CADDocument, scale: number): Corner | null {
  const thresh = HIT_PX / scale;
  let best: { corner: Corner; d: number } | null = null;

  // Line-line corners
  let nearestPt: { line: LineEntity; key: "a" | "b"; pos: Vec2; d: number } | null = null;
  for (const ent of doc.entities) {
    if (!(ent instanceof LineEntity) || ent.isConstruction) continue;
    for (const key of ["a", "b"] as const) {
      const d = dist(worldPos, ent[key]);
      if (d < thresh && (!nearestPt || d < nearestPt.d))
        nearestPt = { line: ent, key, pos: ent[key], d };
    }
  }
  if (nearestPt) {
    for (const ent of doc.entities) {
      if (!(ent instanceof LineEntity) || ent.isConstruction || ent.id === nearestPt.line.id) continue;
      for (const key of ["a", "b"] as const) {
        if (dist(ent[key], nearestPt.pos) < CORNER_EPS) {
          if (!best || nearestPt.d < best.d)
            best = { corner: { kind: "line", line1: nearestPt.line, key1: nearestPt.key, line2: ent, key2: key, pos: nearestPt.pos }, d: nearestPt.d };
        }
      }
    }
  }

  // Polyline vertices
  for (const ent of doc.entities) {
    if (!(ent instanceof PolylineEntity) || ent.isConstruction) continue;
    const n = ent.points.length;
    for (let i = 0; i < n; i++) {
      if (!ent.closed && (i === 0 || i === n - 1)) continue;
      const d = dist(worldPos, ent.points[i]);
      if (d < thresh && (!best || d < best.d))
        best = { corner: { kind: "poly", entity: ent, index: i, pos: ent.points[i] }, d };
    }
  }

  return best?.corner ?? null;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function getCornerDirs(corner: Corner): CornerDirs | null {
  if (corner.kind === "line") {
    const { line1, key1, line2, key2, pos: P } = corner;
    const o1 = key1 === "a" ? line1.b : line1.a;
    const o2 = key2 === "a" ? line2.b : line2.a;
    const len1 = dist(P, o1), len2 = dist(P, o2);
    if (len1 < CORNER_EPS || len2 < CORNER_EPS) return null;
    return { P, d1: { x: (o1.x-P.x)/len1, y: (o1.y-P.y)/len1 }, len1, d2: { x: (o2.x-P.x)/len2, y: (o2.y-P.y)/len2 }, len2 };
  } else {
    const { entity: pl, index: i } = corner;
    const n = pl.points.length;
    if (!pl.closed && (i === 0 || i === n - 1)) return null;
    const P = pl.points[i];
    const prev = pl.points[(i - 1 + n) % n];
    const next = pl.points[(i + 1) % n];
    const len1 = dist(P, prev), len2 = dist(P, next);
    if (len1 < CORNER_EPS || len2 < CORNER_EPS) return null;
    return { P, d1: { x: (prev.x-P.x)/len1, y: (prev.y-P.y)/len1 }, len1, d2: { x: (next.x-P.x)/len2, y: (next.y-P.y)/len2 }, len2 };
  }
}

function computeGeo(dirs: CornerDirs, d: number): ChamferGeo | null {
  const { P, d1, len1, d2, len2 } = dirs;
  const angle = Math.acos(Math.max(-1, Math.min(1, d1.x*d2.x + d1.y*d2.y)));
  if (angle < 1e-4 || Math.abs(angle - Math.PI) < 1e-4) return null;
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
    const { line1, key1, line2, key2 } = corner;
    if (key1 === "a") line1.a = geo.T1; else line1.b = geo.T1;
    if (key2 === "a") line2.a = geo.T2; else line2.b = geo.T2;

    doc.constraints = doc.constraints.filter((c) => {
      if (c.type !== "coincident" || c.points.length !== 2) return true;
      const has1 = c.points.some((p) => p.entityId === line1.id && p.key === key1);
      const has2 = c.points.some((p) => p.entityId === line2.id && p.key === key2);
      return !(has1 && has2);
    });

    const chamfer = new LineEntity(geo.T1, geo.T2);
    doc.add(chamfer);
    doc.addConstraint({ id: `chamfer-c1-${chamfer.id}`, type: "coincident", points: [
      { entityId: line1.id, key: key1 }, { entityId: chamfer.id, key: "a" },
    ], entities: [], params: [] });
    doc.addConstraint({ id: `chamfer-c2-${chamfer.id}`, type: "coincident", points: [
      { entityId: line2.id, key: key2 }, { entityId: chamfer.id, key: "b" },
    ], entities: [], params: [] });
  } else {
    const { entity: pl, index: i } = corner;
    pl.points.splice(i, 1, geo.T1, geo.T2);
  }

  return true;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export class ChamferTool implements Tool {
  readonly id    = "chamfer";
  readonly label = "Chamfer";
  readonly icon  = ICONS.chamfer;

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
    if (this.hoverCorner) return { previews: [{ kind: "point", pos: this.hoverCorner.pos }], selectionRect: null };
    return { previews: [], selectionRect: null };
  }
}
