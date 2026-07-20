/**
 * Rectangle tool: click one corner, click the opposite.
 *
 * Emits a single {@link RectEntity} — one whole-shape object with editable
 * Width/Height (both formula-drivable) in the properties panel, so "draw a
 * rectangle and resize it to exactly 400×300, or drive it from a variable" is
 * the default path a new user meets. This is deliberately the simple-by-default
 * primitive; when you need a rotated rectangle, a skew, or per-edge/per-corner
 * constraints, `Explode` (Edit menu) UNLOCKS it into four lines wired with the
 * full rectangle constraint set — the exact flexible rectangle this tool used to
 * emit up front, so no capability is lost, you just unlock it on demand.
 *
 * A snapped corner still lands exactly on its target (the click coordinate is
 * already the snapped point); we don't add a coincident constraint to a corner,
 * because a RectEntity is a rigid axis-aligned body and pinning corners can
 * over-constrain it. To pin a corner to other geometry, Explode (the corners
 * become line endpoints you can constrain freely).
 */

import type { Vec2 } from "../core/vec2";
import { RectEntity } from "../model/entities";
import type { Tool, ToolContext, ToolPointerEvent, ToolOverlay } from "./tool";
import { ICONS } from "./icons";

export class RectTool implements Tool {
  readonly id = "rect";
  readonly label = "Rectangle";
  readonly icon = ICONS.rect;

  private corner: Vec2 | null = null;
  private cursor: Vec2 = { x: 0, y: 0 };

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    if (!this.corner) {
      this.corner = e.world;
    } else {
      const w = Math.abs(e.world.x - this.corner.x);
      const h = Math.abs(e.world.y - this.corner.y);
      if (w > 1e-6 && h > 1e-6) {
        ctx.pushHistory();
        this.commit(this.corner, e.world, ctx);
      }
      this.corner = null;
    }
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    this.cursor = e.world;
    if (this.corner) ctx.requestRender();
  }

  getOverlay(): ToolOverlay {
    if (!this.corner) return { previews: [], selectionRect: null };
    return {
      previews: [
        { kind: "rect", p0: this.corner, p1: this.cursor },
        { kind: "point", pos: this.corner },
      ],
      selectionRect: null,
    };
  }

  onKeyDown(e: KeyboardEvent, ctx: ToolContext): void {
    if (e.key === "Escape") this.cancel(ctx);
  }

  cancel(ctx: ToolContext): void {
    this.corner = null;
    ctx.requestRender();
  }

  private commit(c0: Vec2, c1: Vec2, ctx: ToolContext): void {
    // RectEntity normalizes its corners to (min, max), so pass the two clicked
    // corners in any order.
    const rect = Object.assign(new RectEntity(c0, c1), {
      isConstruction: ctx.doc.isConstructionMode,
    });
    ctx.doc.clearSelection();
    ctx.doc.add(rect);
    rect.selected = true;
    ctx.doc.emitChange();
    ctx.solve();
  }
}
