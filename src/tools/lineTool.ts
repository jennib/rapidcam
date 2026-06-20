/** Line tool: click start, click end. Stays active to draw more lines. */

import { Vec2, distSq } from "../core/vec2";
import { LineEntity, SnapPoint } from "../model/entities";
import { makeConstraint } from "../model/constraints";
import { Tool, ToolContext, ToolPointerEvent, ToolOverlay } from "./tool";
import { ICONS } from "./icons";
import { orthoSnap } from "../input/snapping";

export class LineTool implements Tool {
  readonly id = "line";
  readonly label = "Line";
  readonly icon = ICONS.line;

  private start: Vec2 | null = null;
  private startSnap: SnapPoint | null = null;
  private cursor: Vec2 = { x: 0, y: 0 };

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    if (!this.start) {
      this.start = e.world;
      this.startSnap = e.snap?.key ? e.snap : null;
    } else {
      const shifted = e.shiftKey;
      const world = shifted ? orthoSnap(this.start, e.world) : e.world;
      const endSnap = shifted ? null : (e.snap?.key ? e.snap : null);
      if (distSq(this.start, world) > 1e-9) {
        ctx.pushHistory();
        const ent = new LineEntity(this.start, world);
        ent.isConstruction = ctx.doc.isConstructionMode;
        ctx.doc.addSelected(ent);
        autoJoin(ctx, ent.id, "a", this.startSnap);
        autoJoin(ctx, ent.id, "b", endSnap);
        ctx.solve();
      }
      this.start = null;
      this.startSnap = null;
    }
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    this.cursor = this.start && e.shiftKey ? orthoSnap(this.start, e.world) : e.world;
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
    this.startSnap = null;
    ctx.requestRender();
  }
}

/** If `snap` has a point key, add a coincident constraint between the new entity's point and the snapped entity's point. */
function autoJoin(ctx: ToolContext, newEntityId: string, newKey: string, snap: SnapPoint | null): void {
  if (!snap?.key) return;
  ctx.doc.addConstraint(
    makeConstraint("coincident", {
      points: [
        { entityId: newEntityId, key: newKey },
        { entityId: snap.entityId, key: snap.key },
      ],
    }),
  );
}
