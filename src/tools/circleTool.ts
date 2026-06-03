/** Circle tool: click centre, click to set radius. */

import { Vec2, dist } from "../core/vec2";
import { CircleEntity } from "../model/entities";
import { Tool, ToolContext, ToolPointerEvent, ToolOverlay } from "./tool";
import { ICONS } from "./icons";

export class CircleTool implements Tool {
  readonly id = "circle";
  readonly label = "Circle (C)";
  readonly icon = ICONS.circle;

  private center: Vec2 | null = null;
  private cursor: Vec2 = { x: 0, y: 0 };

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    if (!this.center) {
      this.center = e.world;
    } else {
      const r = dist(this.center, e.world);
      if (r > 1e-6) {
        const ent = new CircleEntity(this.center, r);
        ent.isConstruction = ctx.doc.isConstructionMode;
        ctx.doc.addSelected(ent);
      }
      this.center = null;
    }
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    this.cursor = e.world;
    if (this.center) ctx.requestRender();
  }

  getOverlay(): ToolOverlay {
    if (!this.center) return { previews: [], selectionRect: null };
    return {
      previews: [
        { kind: "circle", center: this.center, radius: dist(this.center, this.cursor) },
        { kind: "line", a: this.center, b: this.cursor },
        { kind: "point", pos: this.center },
      ],
      selectionRect: null,
    };
  }

  onKeyDown(e: KeyboardEvent, ctx: ToolContext): void {
    if (e.key === "Escape") this.cancel(ctx);
  }

  cancel(ctx: ToolContext): void {
    this.center = null;
    ctx.requestRender();
  }
}
