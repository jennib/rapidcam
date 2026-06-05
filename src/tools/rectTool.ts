/**
 * Rectangle tool: click one corner, click the opposite.
 * Emits 4 LineEntities with coincident + horizontal/vertical constraints so the
 * resulting rectangle is fully parametric (width, height, position all free DOFs).
 */

import { Vec2 } from "../core/vec2";
import { LineEntity } from "../model/entities";
import { makeConstraint } from "../model/constraints";
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
    const x0 = Math.min(c0.x, c1.x), y0 = Math.min(c0.y, c1.y);
    const x1 = Math.max(c0.x, c1.x), y1 = Math.max(c0.y, c1.y);
    const bl = { x: x0, y: y0 }, br = { x: x1, y: y0 };
    const tr = { x: x1, y: y1 }, tl = { x: x0, y: y1 };
    const isC = ctx.doc.isConstructionMode;

    // 4 sides: bottom (bl→br), right (br→tr), top (tl→tr), left (bl→tl)
    const bottom = Object.assign(new LineEntity(bl, br), { isConstruction: isC });
    const right  = Object.assign(new LineEntity(br, tr), { isConstruction: isC });
    const top    = Object.assign(new LineEntity(tl, tr), { isConstruction: isC });
    const left   = Object.assign(new LineEntity(bl, tl), { isConstruction: isC });
    const sides = [bottom, right, top, left];

    // Add all 4, select all 4.
    ctx.doc.clearSelection();
    for (const s of sides) { ctx.doc.add(s); s.selected = true; }

    // Use parallel and perpendicular constraints so the rectangle can be rotated!
    ctx.doc.addConstraint(makeConstraint("parallel", { entities: [bottom.id, top.id] }));
    ctx.doc.addConstraint(makeConstraint("parallel", { entities: [left.id, right.id] }));
    ctx.doc.addConstraint(makeConstraint("perpendicular", { entities: [bottom.id, left.id] }));

    // Coincident at the 4 corners.
    const coin = (eid1: string, k1: string, eid2: string, k2: string) =>
      ctx.doc.addConstraint(makeConstraint("coincident", { points: [{ entityId: eid1, key: k1 }, { entityId: eid2, key: k2 }] }));
    coin(bottom.id, "a", left.id,   "a"); // bl
    coin(bottom.id, "b", right.id,  "a"); // br
    coin(right.id,  "b", top.id,    "b"); // tr
    coin(top.id,    "a", left.id,   "b"); // tl

    ctx.doc.emitChange();
    ctx.solve();
  }
}
