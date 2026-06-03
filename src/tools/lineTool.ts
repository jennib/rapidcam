/** Line tool: click start, click end. Stays active to draw more lines. */

import { Vec2, distSq } from "../core/vec2";
import { LineEntity } from "../model/entities";
import { Tool, ToolContext, ToolPointerEvent, ToolOverlay } from "./tool";
import { ICONS } from "./icons";

export class LineTool implements Tool {
  readonly id = "line";
  readonly label = "Line (L)";
  readonly icon = ICONS.line;

  private start: Vec2 | null = null;
  private cursor: Vec2 = { x: 0, y: 0 };

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    if (!this.start) {
      this.start = e.world;
    } else {
      if (distSq(this.start, e.world) > 1e-9) {
        ctx.doc.addSelected(new LineEntity(this.start, e.world));
      }
      this.start = null;
    }
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    this.cursor = e.world;
    if (this.start) ctx.requestRender();
  }

  getOverlay(): ToolOverlay {
    if (!this.start) return { previews: [], selectionRect: null };
    return {
      previews: [
        { kind: "line", a: this.start, b: this.cursor },
        { kind: "point", pos: this.start },
      ],
      selectionRect: null,
    };
  }

  onKeyDown(e: KeyboardEvent, ctx: ToolContext): void {
    if (e.key === "Escape") this.cancel(ctx);
  }

  cancel(ctx: ToolContext): void {
    this.start = null;
    ctx.requestRender();
  }
}
