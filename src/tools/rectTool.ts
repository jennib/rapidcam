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
import { parseLength } from "../core/units";
import { RectEntity } from "../model/entities";
import type { Tool, ToolContext, ToolPointerEvent, ToolOverlay } from "./tool";
import { ICONS } from "./icons";

export class RectTool implements Tool {
  readonly id = "rect";
  readonly label = "Rectangle";
  readonly icon = ICONS.rect;

  private corner: Vec2 | null = null;
  private cursor: Vec2 = { x: 0, y: 0 };
  private typedW: number | null = null;
  private typedH: number | null = null;

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    if (!this.corner) {
      this.corner = e.world;
      ctx.openMultiValueEditor(
        e.world,
        [
          { placeholder: `W (${ctx.doc.displayUnit})` },
          { placeholder: `H (${ctx.doc.displayUnit})` },
        ],
        (raws) => this.commitByText(raws, ctx),
        () => this.cancel(ctx),
        (raws) => {
          const w = parseLength(raws[0].trim(), ctx.doc.displayUnit);
          const h = parseLength(raws[1].trim(), ctx.doc.displayUnit);
          this.typedW = w != null && w > 0 ? w : null;
          this.typedH = h != null && h > 0 ? h : null;
          ctx.requestRender();
        }
      );
    } else {
      ctx.closeValueEditor();
      
      const signX = this.cursor.x < this.corner.x ? -1 : 1;
      const signY = this.cursor.y < this.corner.y ? -1 : 1;
      const effCursor = {
        x: this.typedW !== null ? this.corner.x + this.typedW * signX : e.world.x,
        y: this.typedH !== null ? this.corner.y + this.typedH * signY : e.world.y,
      };

      const w = Math.abs(effCursor.x - this.corner.x);
      const h = Math.abs(effCursor.y - this.corner.y);
      if (w > 1e-6 && h > 1e-6) {
        ctx.pushHistory();
        this.commit(this.corner, effCursor, ctx);
      }
      this.corner = null;
      this.typedW = null;
      this.typedH = null;
    }
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    this.cursor = e.world;
    if (this.corner) ctx.requestRender();
  }

  getOverlay(): ToolOverlay {
    if (!this.corner) return { previews: [], selectionRect: null };

    const signX = this.cursor.x < this.corner.x ? -1 : 1;
    const signY = this.cursor.y < this.corner.y ? -1 : 1;
    const effCursor = {
      x: this.typedW !== null ? this.corner.x + this.typedW * signX : this.cursor.x,
      y: this.typedH !== null ? this.corner.y + this.typedH * signY : this.cursor.y,
    };

    return {
      previews: [
        { kind: "rect", p0: this.corner, p1: effCursor },
        { kind: "point", pos: this.corner },
      ],
      selectionRect: null,
    };
  }

  onKeyDown(e: KeyboardEvent, ctx: ToolContext): void {
    if (e.key === "Escape") this.cancel(ctx);
  }

  cancel(ctx: ToolContext): void {
    ctx.closeValueEditor();
    this.corner = null;
    this.typedW = null;
    this.typedH = null;
    ctx.requestRender();
  }

  private commitByText(raws: string[], ctx: ToolContext): boolean {
    if (raws.length !== 2) return false;
    const wStr = raws[0].trim();
    const hStr = raws[1].trim();

    if (!wStr || !hStr) return false;

    const w = parseLength(wStr, ctx.doc.displayUnit);
    const h = parseLength(hStr, ctx.doc.displayUnit);

    if (w == null || h == null || w <= 1e-6 || h <= 1e-6) return false;

    let signX = 1;
    let signY = 1;
    if (this.corner) {
      if (this.cursor.x < this.corner.x) signX = -1;
      if (this.cursor.y < this.corner.y) signY = -1;
    }

    const c1: Vec2 = {
      x: this.corner!.x + w * signX,
      y: this.corner!.y + h * signY,
    };

    ctx.pushHistory();
    this.commit(this.corner!, c1, ctx);
    
    this.corner = null;
    this.typedW = null;
    this.typedH = null;
    return true;
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
