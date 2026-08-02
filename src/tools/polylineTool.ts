/**
 * Polyline tool: click to add vertices.
 *   click first vertex   → close and finish
 *   Enter / double-click → finish open
 *   Backspace            → remove last vertex
 *   Escape               → cancel
 */

import { type Vec2, distSq, dist } from "../core/vec2";
import { PolylineEntity, type SnapPoint } from "../model/entities";
import { makeConstraint } from "../model/constraints";
import type { Tool, ToolContext, ToolPointerEvent, ToolOverlay } from "./tool";
import { ICONS } from "./icons";
import { orthoSnap } from "../input/snapping";

import { autoJoin, resolveShiftedSnap } from "./lineTool";

export class PolylineTool implements Tool {
  readonly id = "polyline";
  readonly label = "Polyline";
  readonly icon = ICONS.polyline;

  private points: Vec2[] = [];
  private snaps: (SnapPoint | null)[] = [];
  private cursor: Vec2 = { x: 0, y: 0 };

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    const prev = this.points[this.points.length - 1];

    const shifted = e.shiftKey && prev != null;
    const world = shifted ? orthoSnap(prev, e.world) : e.world;
    const snap = shifted ? resolveShiftedSnap(e.snap, world) : e.snap;

    if (prev && distSq(prev, world) < 1e-9) return; // ignore duplicate click

    // Clicking the first vertex closes the polyline.
    if (this.points.length >= 2) {
      const tol = ctx.view.toWorldLen(8);
      if (dist(this.points[0], world) <= tol) {
        this.finish(ctx, true);
        return;
      }
    }
    this.points.push(world);
    this.snaps.push(snap);
    ctx.requestRender();
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    const prev = this.points[this.points.length - 1];
    this.cursor = prev && e.shiftKey ? orthoSnap(prev, e.world) : e.world;
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
      this.snaps.pop();
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
    this.snaps = [];
    ctx.requestRender();
  }

  private finish(ctx: ToolContext, closed: boolean): void {
    const { pts, snaps } = dedupeConsecutive(this.points, this.snaps);
    if (pts.length >= 2) {
      ctx.pushHistory();
      const ent = new PolylineEntity(pts, closed);
      ent.isConstruction = ctx.doc.isConstructionMode;
      ctx.doc.addSelected(ent);
      for (let i = 0; i < snaps.length; i++) {
        autoJoin(ctx, ent.id, `v${ent.vertexIds[i]}`, snaps[i]);
      }

      // Auto-add H/V constraints to each segment if perfectly orthogonal
      const numSegs = closed ? pts.length : pts.length - 1;
      for (let i = 0; i < numSegs; i++) {
        const p1 = pts[i];
        const p2 = pts[(i + 1) % pts.length];
        const refId = `${ent.id}#${ent.vertexIds[i]}`;
        if (Math.abs(p1.y - p2.y) < 1e-6) {
          ctx.doc.addConstraint(makeConstraint("horizontal", { entities: [refId] }));
        } else if (Math.abs(p1.x - p2.x) < 1e-6) {
          ctx.doc.addConstraint(makeConstraint("vertical", { entities: [refId] }));
        }
      }

      ctx.solve();
    }
    this.points = [];
    this.snaps = [];
    ctx.requestRender();
  }
}

function dedupeConsecutive(
  points: Vec2[],
  snaps: (SnapPoint | null)[],
): { pts: Vec2[]; snaps: (SnapPoint | null)[] } {
  const pts: Vec2[] = [];
  const outSnaps: (SnapPoint | null)[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const last = pts[pts.length - 1];
    if (!last || distSq(last, p) > 1e-9) {
      pts.push(p);
      outSnaps.push(snaps[i]);
    }
  }
  return { pts, snaps: outSnaps };
}
