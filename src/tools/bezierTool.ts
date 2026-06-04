/**
 * Bezier tool — two-phase click workflow:
 *   Phase 1: click p0 (start), click p3 (end)
 *   Phase 2: click p1 (handle near start), click p2 (handle near end) → commit
 * Key: B
 */

import { Vec2 } from "../core/vec2";
import { BezierEntity } from "../model/entities";
import { PreviewShape } from "../view/overlay";
import { Tool, ToolContext, ToolPointerEvent, ToolOverlay } from "./tool";
import { ICONS } from "./icons";

type Phase = "p0" | "p3" | "p1" | "p2";

export class BezierTool implements Tool {
  readonly id = "bezier";
  readonly label = "Bezier (B)";
  readonly icon = ICONS.bezier;

  private phase: Phase = "p0";
  private p0: Vec2 = { x: 0, y: 0 };
  private p3: Vec2 = { x: 0, y: 0 };
  private p1: Vec2 = { x: 0, y: 0 };
  private cursor: Vec2 = { x: 0, y: 0 };

  onActivate(_ctx: ToolContext): void {
    this.phase = "p0";
  }

  cancel(ctx: ToolContext): void {
    this.phase = "p0";
    ctx.requestRender();
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    const p = e.world;

    switch (this.phase) {
      case "p0":
        this.p0 = p;
        this.cursor = p;
        this.phase = "p3";
        break;

      case "p3":
        this.p3 = p;
        this.cursor = p;
        this.phase = "p1";
        break;

      case "p1":
        this.p1 = p;
        this.cursor = p;
        this.phase = "p2";
        break;

      case "p2": {
        const p2 = p;
        ctx.pushHistory();
        const ent = new BezierEntity(this.p0, this.p1, p2, this.p3);
        ent.isConstruction = ctx.doc.isConstructionMode;
        ctx.doc.addSelected(ent);
        ctx.solve();
        this.phase = "p0";
        break;
      }
    }

    ctx.requestRender();
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    this.cursor = e.world;
    if (this.phase !== "p0") ctx.requestRender();
  }

  getOverlay(): ToolOverlay {
    const previews: PreviewShape[] = [];

    switch (this.phase) {
      case "p0":
        break;

      case "p3":
        // Chord from p0 to cursor
        previews.push({ kind: "line", a: this.p0, b: this.cursor });
        previews.push({ kind: "point", pos: this.p0 });
        break;

      case "p1":
        // Curve with p1=cursor, p2=p3 (degenerate — shows one handle active)
        previews.push({ kind: "bezier", p0: this.p0, p1: this.cursor, p2: this.p3, p3: this.p3 });
        // First control arm
        previews.push({ kind: "line", a: this.p0, b: this.cursor });
        previews.push({ kind: "point", pos: this.p0 });
        previews.push({ kind: "point", pos: this.p3 });
        break;

      case "p2":
        // Curve with p1 fixed, p2=cursor
        previews.push({ kind: "bezier", p0: this.p0, p1: this.p1, p2: this.cursor, p3: this.p3 });
        // Both control arms
        previews.push({ kind: "line", a: this.p0, b: this.p1 });
        previews.push({ kind: "line", a: this.p3, b: this.cursor });
        previews.push({ kind: "point", pos: this.p0 });
        previews.push({ kind: "point", pos: this.p3 });
        break;
    }

    return { previews, selectionRect: null };
  }

  onKeyDown(e: KeyboardEvent, ctx: ToolContext): void {
    if (e.key === "Escape") this.cancel(ctx);
  }
}
