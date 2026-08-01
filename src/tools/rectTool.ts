/**
 * Rectangle tool: click one corner, click the opposite — or press and drag from
 * one corner to the other (see dragDraw.ts).
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
import { isDragRelease } from "./dragDraw";

export class RectTool implements Tool {
  readonly id = "rect";
  readonly label = "Rectangle";
  readonly icon = ICONS.rect;

  private start: Vec2 | null = null;
  /** Where the first corner was pressed, for press-drag-release (see dragDraw.ts). */
  private anchorScreen: Vec2 | null = null;
  private cursor: Vec2 = { x: 0, y: 0 };
  private typedW: number | null = null;
  private typedH: number | null = null;
  private isCenter: boolean = false;

  onActivate(ctx: ToolContext): void {
    ctx.setHint("Click two opposite corners, or drag one out (Hold Alt to draw from center).");
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    this.isCenter = e.altKey;
    if (!this.start) {
      this.start = e.world;
      this.anchorScreen = e.screen;
      ctx.setHint("Click opposite corner, or drag (Hold Alt for center rectangle).");
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
        },
      );
    } else {
      ctx.closeValueEditor();
      const { p0, p1 } = this.getRectExtents(e.world);
      const w = Math.abs(p1.x - p0.x);
      const h = Math.abs(p1.y - p0.y);
      if (w > 1e-6 && h > 1e-6) {
        ctx.pushHistory();
        this.commit(p0, p1, ctx);
      } else {
        // Snapping can pull the second corner onto the first row/column of the
        // grid, giving a zero-width or zero-height rectangle. Refusing silently
        // reads as "my drag did nothing" — say why (see ToolContext.notify).
        ctx.notify(
          "Corners snapped to the same row or column — nothing to draw. Zoom in, or toggle snap in the status bar.",
        );
      }
      this.start = null;
      this.anchorScreen = null;
      this.typedW = null;
      this.typedH = null;
      ctx.setHint("Click two opposite corners, or drag one out (Hold Alt to draw from center).");
    }
  }

  /** Release far enough from the first corner = a drag; finish the rectangle there. */
  onPointerUp(e: ToolPointerEvent, ctx: ToolContext): void {
    if (!isDragRelease(this.anchorScreen, e)) return;
    this.onPointerDown(e, ctx);
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    this.cursor = e.world;
    this.isCenter = e.altKey;
    if (this.start) ctx.requestRender();
  }

  private getRectExtents(cursorWorld: Vec2): { p0: Vec2; p1: Vec2 } {
    if (!this.start) return { p0: cursorWorld, p1: cursorWorld };

    // The user's typed W and H are the total desired dimensions.
    const dx =
      this.typedW !== null
        ? this.isCenter
          ? this.typedW / 2
          : this.typedW
        : Math.abs(cursorWorld.x - this.start.x);
    const dy =
      this.typedH !== null
        ? this.isCenter
          ? this.typedH / 2
          : this.typedH
        : Math.abs(cursorWorld.y - this.start.y);

    const signX = cursorWorld.x < this.start.x ? -1 : 1;
    const signY = cursorWorld.y < this.start.y ? -1 : 1;

    let p0: { x: number; y: number }, p1: { x: number; y: number };
    if (this.isCenter) {
      p0 = { x: this.start.x - dx, y: this.start.y - dy };
      p1 = { x: this.start.x + dx, y: this.start.y + dy };
    } else {
      p0 = this.start;
      p1 = { x: this.start.x + dx * signX, y: this.start.y + dy * signY };
    }

    return { p0, p1 };
  }

  getOverlay(): ToolOverlay {
    if (!this.start) return { previews: [], selectionRect: null };

    const { p0, p1 } = this.getRectExtents(this.cursor);

    return {
      previews: [
        { kind: "rect", p0, p1 },
        { kind: "point", pos: this.start },
      ],
      selectionRect: null,
    };
  }

  onKeyDown(e: KeyboardEvent, ctx: ToolContext): void {
    if (e.key === "Escape") this.cancel(ctx);
  }

  cancel(ctx: ToolContext): void {
    ctx.closeValueEditor();
    this.start = null;
    this.anchorScreen = null;
    this.typedW = null;
    this.typedH = null;
    ctx.setHint("Click two opposite corners, or drag one out (Hold Alt to draw from center).");
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

    // Use our helper to compute the points using the current cursor/center state.
    // We already parsed `w` and `h` and set `this.typedW`/`this.typedH` inside the onChange callback,
    // but the user might have pressed Enter without the onChange firing (e.g. they pasted or fast-typed).
    // So we manually override them here before calling getRectExtents.
    this.typedW = w;
    this.typedH = h;
    const { p0, p1 } = this.getRectExtents(this.cursor);

    ctx.pushHistory();
    this.commit(p0, p1, ctx);

    this.start = null;
    this.anchorScreen = null;
    this.typedW = null;
    this.typedH = null;
    ctx.setHint("Click two opposite corners, or drag one out (Hold Alt to draw from center).");
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
