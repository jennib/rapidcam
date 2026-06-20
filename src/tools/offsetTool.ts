/**
 * Offset tool: click an entity, move cursor to one side, click to commit a
 * parallel copy at that distance.  Works on lines, circles, arcs, polylines,
 * and rectangles.  Key: O.
 */

import { Vec2, dist } from "../core/vec2";
import {
  Entity,
  EntityId,
  LineEntity,
  CircleEntity,
  ArcEntity,
  PolylineEntity,
  RectEntity,
} from "../model/entities";
import { distToSegment } from "../core/geom";
import { offsetPolygon } from "../cam/offset";
import { PreviewShape } from "../view/overlay";
import { Tool, ToolContext, ToolPointerEvent, ToolOverlay } from "./tool";
import { ICONS } from "./icons";

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Signed perpendicular distance from p to the infinite line through a→b.
 *  Positive = left of the direction vector (a→b), i.e. CCW / inward for a
 *  CCW-wound closed polygon. */
function signedDistToLine(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-10) return 0;
  return (-dy * (p.x - a.x) + dx * (p.y - a.y)) / len;
}

/** Ray-casting point-in-polygon test. */
function pointInPolygon(p: Vec2, pts: Vec2[]): boolean {
  let inside = false;
  const n = pts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Shortest distance from p to any edge of a path. */
function distToEdges(p: Vec2, pts: Vec2[], closed: boolean): number {
  const segs = closed ? pts.length : pts.length - 1;
  let min = Infinity;
  for (let i = 0; i < segs; i++) {
    min = Math.min(min, distToSegment(p, pts[i], pts[(i + 1) % pts.length]));
  }
  return min;
}

/** Signed distance from the nearest segment of an open polyline.
 *  Positive = left side of the nearest segment direction. */
function signedDistToOpenPolyline(p: Vec2, pts: Vec2[]): number {
  let min = Infinity;
  let signed = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = distToSegment(p, pts[i], pts[i + 1]);
    if (d < min) {
      min = d;
      signed = signedDistToLine(p, pts[i], pts[i + 1]);
    }
  }
  return signed;
}

/**
 * Compute signed offset distance from entity to cursor.
 * Convention:
 *   lines / open polylines: + = left of direction
 *   circles / arcs:         + = outside (cursor beyond radius)
 *   closed polylines / rect: + = outside (cursor outside boundary)
 */
function computeSignedOffset(entity: Entity, cursor: Vec2): number | null {
  switch (entity.type) {
    case "line": {
      const l = entity as LineEntity;
      return signedDistToLine(cursor, l.a, l.b);
    }
    case "circle": {
      const c = entity as CircleEntity;
      return dist(cursor, c.center) - c.radius;
    }
    case "arc": {
      const a = entity as ArcEntity;
      return dist(cursor, a.center) - a.radius;
    }
    case "polyline": {
      const pl = entity as PolylineEntity;
      if (pl.points.length < 2) return null;
      if (pl.closed) {
        const inside = pointInPolygon(cursor, pl.points);
        const d = distToEdges(cursor, pl.points, true);
        return inside ? -d : d;
      }
      return signedDistToOpenPolyline(cursor, pl.points);
    }
    case "rectangle": {
      const r = entity as RectEntity;
      const corners = r.corners();
      const inside =
        cursor.x >= r.minPt.x && cursor.x <= r.maxPt.x &&
        cursor.y >= r.minPt.y && cursor.y <= r.maxPt.y;
      const d = distToEdges(cursor, corners, true);
      return inside ? -d : d;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Offset preview geometry
// ---------------------------------------------------------------------------

/** Miter-join offset of an open polyline. */
function offsetOpenPolyline(pts: Vec2[], d: number): Vec2[] {
  if (pts.length < 2) return [];
  const n = pts.length;

  const norms: Vec2[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y;
    const len = Math.sqrt(dx * dx + dy * dy);
    norms.push(len < 1e-10 ? { x: 0, y: 1 } : { x: -dy / len, y: dx / len });
  }

  const result: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    let ox: number, oy: number;
    if (i === 0) {
      ox = norms[0].x * d; oy = norms[0].y * d;
    } else if (i === n - 1) {
      ox = norms[n - 2].x * d; oy = norms[n - 2].y * d;
    } else {
      const na = norms[i - 1], nb = norms[i];
      const bx = na.x + nb.x, by = na.y + nb.y;
      const bl = Math.sqrt(bx * bx + by * by);
      if (bl < 1e-10) {
        ox = na.x * d; oy = na.y * d;
      } else {
        const bu = { x: bx / bl, y: by / bl };
        const dotVal = bu.x * na.x + bu.y * na.y;
        // Cap miter at 4× to avoid spikes at very acute joints.
        const scale = d / Math.max(Math.abs(dotVal), 0.25) * Math.sign(dotVal || 1);
        ox = bu.x * scale; oy = bu.y * scale;
      }
    }
    result.push({ x: pts[i].x + ox, y: pts[i].y + oy });
  }
  return result;
}

/** Build preview shapes for the given entity offset by d mm. */
function buildPreviews(entity: Entity, d: number): PreviewShape[] {
  if (Math.abs(d) < 1e-4) return [];

  switch (entity.type) {
    case "line": {
      const l = entity as LineEntity;
      const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-10) return [];
      const nx = -dy / len * d, ny = dx / len * d;
      return [{ kind: "line", a: { x: l.a.x + nx, y: l.a.y + ny }, b: { x: l.b.x + nx, y: l.b.y + ny } }];
    }
    case "circle": {
      const c = entity as CircleEntity;
      const newR = c.radius + d;
      if (newR <= 0) return [];
      return [{ kind: "circle", center: { ...c.center }, radius: newR }];
    }
    case "arc": {
      const a = entity as ArcEntity;
      const newR = a.radius + d;
      if (newR <= 0) return [];
      return [{ kind: "arc", center: { ...a.center }, radius: newR, startAngle: a.startAngle, endAngle: a.endAngle }];
    }
    case "polyline": {
      const pl = entity as PolylineEntity;
      if (pl.closed) {
        return offsetPolygon(pl.points, d).map(pts => ({ kind: "polyline" as const, points: pts, closed: true }));
      }
      return [{ kind: "polyline", points: offsetOpenPolyline(pl.points, d), closed: false }];
    }
    case "rectangle": {
      const r = entity as RectEntity;
      const newMin = { x: r.minPt.x - d, y: r.minPt.y - d };
      const newMax = { x: r.maxPt.x + d, y: r.maxPt.y + d };
      if (newMax.x <= newMin.x || newMax.y <= newMin.y) return [];
      return [{
        kind: "polyline",
        points: [
          { x: newMin.x, y: newMin.y },
          { x: newMax.x, y: newMin.y },
          { x: newMax.x, y: newMax.y },
          { x: newMin.x, y: newMax.y },
        ],
        closed: true,
      }];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Commit: create the offset entity in the document
// ---------------------------------------------------------------------------

function commitOffset(entity: Entity, d: number, ctx: ToolContext): void {
  for (const e of ctx.doc.entities) e.selected = false;

  switch (entity.type) {
    case "line": {
      const l = entity as LineEntity;
      const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-10) return;
      const nx = -dy / len * d, ny = dx / len * d;
      const e = new LineEntity({ x: l.a.x + nx, y: l.a.y + ny }, { x: l.b.x + nx, y: l.b.y + ny });
      e.selected = true;
      ctx.doc.add(e);
      break;
    }
    case "circle": {
      const c = entity as CircleEntity;
      const newR = c.radius + d;
      if (newR <= 0) return;
      const e = new CircleEntity({ ...c.center }, newR);
      e.selected = true;
      ctx.doc.add(e);
      break;
    }
    case "arc": {
      const a = entity as ArcEntity;
      const newR = a.radius + d;
      if (newR <= 0) return;
      const e = new ArcEntity({ ...a.center }, newR, a.startAngle, a.endAngle);
      e.selected = true;
      ctx.doc.add(e);
      break;
    }
    case "polyline": {
      const pl = entity as PolylineEntity;
      if (pl.closed) {
        for (const pts of offsetPolygon(pl.points, d)) {
          const e = new PolylineEntity(pts, true);
          e.selected = true;
          ctx.doc.add(e);
        }
      } else {
        const pts = offsetOpenPolyline(pl.points, d);
        const e = new PolylineEntity(pts, false);
        e.selected = true;
        ctx.doc.add(e);
      }
      break;
    }
    case "rectangle": {
      const r = entity as RectEntity;
      const newMin = { x: r.minPt.x - d, y: r.minPt.y - d };
      const newMax = { x: r.maxPt.x + d, y: r.maxPt.y + d };
      if (newMax.x <= newMin.x || newMax.y <= newMin.y) return;
      const e = new RectEntity(newMin, newMax);
      e.selected = true;
      ctx.doc.add(e);
      break;
    }
  }

  ctx.doc.emitChange();
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

type Phase = "idle" | "placing";

export class OffsetTool implements Tool {
  readonly id = "offset";
  readonly label = "Offset";
  readonly icon = ICONS.offset;

  private phase: Phase = "idle";
  private pickedId: EntityId | null = null;
  private previews: PreviewShape[] = [];
  private lastD = 0;

  onActivate(_ctx: ToolContext): void {
    this.phase = "idle";
    this.pickedId = null;
    this.previews = [];
  }

  cancel(ctx: ToolContext): void {
    this.phase = "idle";
    this.pickedId = null;
    this.previews = [];
    ctx.requestRender();
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;

    if (this.phase === "idle") {
      const tol = ctx.view.toWorldLen(8);
      const ent = ctx.doc.hitTest(e.worldRaw, tol);
      if (ent) {
        this.pickedId = ent.id;
        this.phase = "placing";
      }
    } else {
      const ent = ctx.doc.entities.find(en => en.id === this.pickedId);
      if (ent && Math.abs(this.lastD) > 1e-4) {
        ctx.pushHistory();
        commitOffset(ent, this.lastD, ctx);
      }
      this.phase = "idle";
      this.pickedId = null;
      this.previews = [];
    }
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    if (this.phase !== "placing") return;
    const ent = ctx.doc.entities.find(en => en.id === this.pickedId);
    if (!ent) { this.cancel(ctx); return; }

    const d = computeSignedOffset(ent, e.worldRaw);
    this.lastD = d ?? 0;
    this.previews = d !== null ? buildPreviews(ent, d) : [];
    ctx.requestRender();
  }

  getOverlay(): ToolOverlay {
    return { previews: this.previews, selectionRect: null };
  }

  onKeyDown(e: KeyboardEvent, ctx: ToolContext): void {
    if (e.key === "Escape") this.cancel(ctx);
  }
}
