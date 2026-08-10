/**
 * Circle tool: click centre, click to set radius.
 *
 * Type to Draw (see lineTool.ts for the pattern): after the centre click a
 * diameter field opens, so an exact hole never needs a measured second click.
 * Diameter rather than radius because that is how a hole is specified, drilled
 * and inspected — it matches the polygon tool's `Ø` field and the properties
 * panel.
 *
 * Both the preview and every commit path go through {@link CircleTool.radiusFor},
 * so what is on screen is what lands. It uses the MULTI value editor with a
 * single field, because that is the variant carrying an `onChange` hook — the
 * single-value editor has no live preview.
 */

import { type Vec2, dist } from "../core/vec2";
import { parseLength } from "../core/units";
import { CircleEntity, type SnapPoint } from "../model/entities";
import type { Tool, ToolContext, ToolPointerEvent, ToolOverlay } from "./tool";
import { ICONS } from "./icons";
import { isDragRelease } from "./dragDraw";
import { autoJoin } from "./lineTool";

export class CircleTool implements Tool {
  readonly id = "circle";
  readonly label = "Circle";
  readonly icon = ICONS.circle;

  private center: Vec2 | null = null;
  private centerSnap: SnapPoint | null = null;
  /** Where the first point was pressed, for press-drag-release (see dragDraw.ts). */
  private anchorScreen: Vec2 | null = null;
  private cursor: Vec2 = { x: 0, y: 0 };
  /** Type-to-draw override, in mm; null = the radius follows the cursor. */
  private typedDia: number | null = null;

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    if (!this.center) {
      this.center = e.world;
      // Keep the WHOLE snap, not just an exact-point one. Filtering to
      // `snap.key` threw away the two cases a centre most often lands on — a
      // point along a line, and a crossing of two — so a circle placed on an
      // intersection looked constrained and was not: correct coordinates, no
      // constraint, and the first edit to either line left it behind.
      this.centerSnap = e.snap ?? null;
      this.anchorScreen = e.screen;
      this.cursor = e.world;
      ctx.setHint("Click a point on the circle, or type a diameter");
      ctx.openMultiValueEditor(
        e.world,
        [{ placeholder: `Ø (${ctx.doc.displayUnit})` }],
        (raws) => this.commitByText(raws, ctx),
        () => this.cancel(ctx),
        (raws) => {
          this.typedDia = this.readDia(raws, ctx);
          ctx.requestRender();
        },
      );
    } else {
      ctx.closeValueEditor();
      if (!this.commitCircle(this.radiusFor(e.world), ctx)) {
        // Snapping can pull the second point onto the first. Refusing silently
        // reads as "my drag did nothing" — say why (see ToolContext.notify).
        ctx.notify("Radius snapped to zero — zoom in or toggle snap.");
      }
      this.reset(ctx);
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
    const r = this.radiusFor(this.cursor);
    // The rubber band ends ON the circle rather than at the cursor, so a typed
    // diameter reads as a radius line and not as a stray tail poking out of it.
    const d = dist(this.center, this.cursor);
    const tip =
      this.typedDia !== null && d > 1e-9
        ? {
            x: this.center.x + ((this.cursor.x - this.center.x) / d) * r,
            y: this.center.y + ((this.cursor.y - this.center.y) / d) * r,
          }
        : this.cursor;
    return {
      previews: [
        { kind: "circle", center: this.center, radius: r },
        { kind: "line", a: this.center, b: tip },
        { kind: "point", pos: this.center },
      ],
      selectionRect: null,
    };
  }

  onKeyDown(e: KeyboardEvent, ctx: ToolContext): void {
    if (e.key === "Escape") this.cancel(ctx);
  }

  cancel(ctx: ToolContext): void {
    ctx.closeValueEditor();
    this.reset(ctx);
    ctx.requestRender();
  }

  /** The radius the circle would have right now — typed diameter wins over the cursor. */
  private radiusFor(cursorWorld: Vec2): number {
    if (this.typedDia !== null) return this.typedDia / 2;
    return this.center ? dist(this.center, cursorWorld) : 0;
  }

  /** Parse the diameter field; blank or unusable is null (= follow the cursor). */
  private readDia(raws: string[], ctx: ToolContext): number | null {
    const d = parseLength((raws[0] ?? "").trim(), ctx.doc.displayUnit);
    return d !== null && d > 1e-6 ? d : null;
  }

  private commitByText(raws: string[], ctx: ToolContext): boolean {
    if (!this.center) return false;
    if (!(raws[0] ?? "").trim()) return false;
    // Re-read rather than trust what onChange cached: a paste, or a fast typist
    // hitting Enter, can commit before an input event has fired. A typed but
    // unusable value must not fall through to the cursor radius.
    this.typedDia = this.readDia(raws, ctx);
    if (this.typedDia === null) return false;
    if (!this.commitCircle(this.radiusFor(this.cursor), ctx)) return false;
    this.reset(ctx);
    return true;
  }

  /** Build the circle and wire its centre constraint. Returns false for a zero radius. */
  private commitCircle(r: number, ctx: ToolContext): boolean {
    if (!this.center || r <= 1e-6) return false;
    ctx.pushHistory();
    const ent = new CircleEntity(this.center, r);
    ent.isConstruction = ctx.doc.isConstructionMode;
    ctx.doc.addSelected(ent);
    // The shared inference every other draw tool uses (line, polyline,
    // bezier), rather than a local copy that only knew about coincident.
    autoJoin(ctx, ent.id, "c", this.centerSnap);
    // Solve on commit like every other draw tool (line/arc/rect/polyline/
    // polygon). Circle was the lone tool that didn't, leaving the solve
    // result — and so currentDof() — stale from before the circle existed,
    // which skews any consumer that reads it before the next solve.
    ctx.solve();
    return true;
  }

  private reset(ctx: ToolContext): void {
    this.center = null;
    this.anchorScreen = null;
    this.centerSnap = null;
    this.typedDia = null;
    ctx.setHint(null);
  }
}
