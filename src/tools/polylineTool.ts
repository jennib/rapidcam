/**
 * Polyline tool: click to add vertices.
 *   click first vertex   → close and finish
 *   Enter / double-click → finish open
 *   Backspace            → remove last vertex
 *   Escape               → cancel
 */

import { Vec2, distSq, dist } from "../core/vec2";
import { PolylineEntity } from "../model/entities";
import { Tool, ToolContext, ToolPointerEvent, ToolOverlay } from "./tool";
import { ICONS } from "./icons";

export class PolylineTool implements Tool {
  readonly id = "polyline";
  readonly label = "Polyline (P)";
  readonly icon = ICONS.polyline;

  private points: Vec2[] = [];
  private cursor: Vec2 = { x: 0, y: 0 };

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    const last = this.points[this.points.length - 1];
    if (last && distSq(last, e.world) < 1e-9) return; // ignore duplicate click

    // Clicking the first vertex closes the polyline.
    if (this.points.length >= 2) {
      const tol = ctx.view.toWorldLen(8);
      if (dist(this.points[0], e.world) <= tol) {
        this.finish(ctx, true);
        return;
      }
    }
    this.points.push(e.world);
    ctx.requestRender();
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    this.cursor = e.world;
    if (this.points.length > 0) ctx.requestRender();
  }

  onDoubleClick(_e: ToolPointerEvent, ctx: ToolContext): void {
    this.finish(ctx, false);
  }

  onKeyDown(e: KeyboardEvent, ctx: ToolContext): void {
    if (e.key === "Enter") this.finish(ctx, false);
    else if (e.key === "Escape") this.cancel(ctx);
    else if (e.key === "Backspace") {
      this.points.pop();
      ctx.requestRender();
    }
  }

  getOverlay(): ToolOverlay {
    if (this.points.length === 0) return { previews: [], selectionRect: null };
    const pts = [...this.points, this.cursor];
    return {
      previews: [
        { kind: "polyline", points: pts, closed: false },
        ...this.points.map((p) => ({ kind: "point" as const, pos: p })),
      ],
      selectionRect: null,
    };
  }

  cancel(ctx: ToolContext): void {
    this.points = [];
    ctx.requestRender();
  }

  private finish(ctx: ToolContext, closed: boolean): void {
    const pts = dedupeConsecutive(this.points);
    if (pts.length >= 2) ctx.doc.addSelected(new PolylineEntity(pts, closed));
    this.points = [];
    ctx.requestRender();
  }
}

function dedupeConsecutive(points: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || distSq(last, p) > 1e-9) out.push(p);
  }
  return out;
}
