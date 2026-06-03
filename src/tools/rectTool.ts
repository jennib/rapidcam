/** Rectangle tool: click one corner, click the opposite corner. */

import { Vec2 } from "../core/vec2";
import { RectEntity } from "../model/entities";
import { Tool, ToolContext, ToolPointerEvent, ToolOverlay } from "./tool";
import { ICONS } from "./icons";

export class RectTool implements Tool {
  readonly id = "rect";
  readonly label = "Rectangle (R)";
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
        ctx.doc.add(new RectEntity(this.corner, e.world));
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
}
