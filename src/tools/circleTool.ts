/** Circle tool: click centre, click to set radius. */

import { type Vec2, dist } from "../core/vec2";
import { CircleEntity, type SnapPoint } from "../model/entities";
import { makeConstraint } from "../model/constraints";
import type { Tool, ToolContext, ToolPointerEvent, ToolOverlay } from "./tool";
import { ICONS } from "./icons";
import { isDragRelease } from "./dragDraw";

export class CircleTool implements Tool {
  readonly id = "circle";
  readonly label = "Circle";
  readonly icon = ICONS.circle;

  private center: Vec2 | null = null;
  private centerSnap: SnapPoint | null = null;
  /** Where the first point was pressed, for press-drag-release (see dragDraw.ts). */
  private anchorScreen: Vec2 | null = null;
  private cursor: Vec2 = { x: 0, y: 0 };

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    if (!this.center) {
      this.center = e.world;
      this.centerSnap = e.snap?.key ? e.snap : null;
      this.anchorScreen = e.screen;
    } else {
      const r = dist(this.center, e.world);
      if (r > 1e-6) {
        ctx.pushHistory();
        const ent = new CircleEntity(this.center, r);
        ent.isConstruction = ctx.doc.isConstructionMode;
        ctx.doc.addSelected(ent);
        if (this.centerSnap?.key) {
          ctx.doc.addConstraint(
            makeConstraint("coincident", {
              points: [
                { entityId: ent.id, key: "c" },
                { entityId: this.centerSnap.entityId, key: this.centerSnap.key },
              ],
            }),
          );
        }
        // Solve on commit like every other draw tool (line/arc/rect/polyline/
        // polygon). Circle was the lone tool that didn't, leaving the solve
        // result — and so currentDof() — stale from before the circle existed,
        // which skews any consumer that reads it before the next solve.
        ctx.solve();
      } else {
        // Snapping can pull the second point onto the first. Refusing silently
        // reads as "my drag did nothing" — say why (see ToolContext.notify).
        ctx.notify("Radius snapped to zero — zoom in or toggle snap.");
      }
      this.center = null;
      this.anchorScreen = null;
      this.centerSnap = null;
    }
  }

  /** Release far enough from the centre = a drag; the radius is where you let go. */
  onPointerUp(e: ToolPointerEvent, ctx: ToolContext): void {
    if (!isDragRelease(this.anchorScreen, e)) return;
    this.onPointerDown(e, ctx);
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
    this.anchorScreen = null;
    this.centerSnap = null;
    ctx.requestRender();
  }
}
