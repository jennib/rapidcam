/**
 * Measure tool: click two points to read the distance between them, plus the
 * X/Y deltas and the angle. Purely transient — it never mutates the document.
 *
 * Click 1 sets the anchor; moving shows a live readout; click 2 freezes it.
 * A further click starts a fresh measurement. Esc clears. Points honour object
 * snapping (the event's `world` is already snapped), so you can measure between
 * vertices, midpoints, centres, intersections, etc.
 */

import { Vec2, dist } from "../core/vec2";
import { Unit, formatLength, formatLengthWithUnit } from "../core/units";
import { Tool, ToolContext, ToolPointerEvent, ToolOverlay } from "./tool";
import { PreviewShape } from "../view/overlay";
import { ICONS } from "./icons";

export class MeasureTool implements Tool {
  readonly id = "measure";
  readonly label = "Measure";
  readonly icon = ICONS.measure;

  private first: Vec2 | null = null;
  private cursor: Vec2 = { x: 0, y: 0 };
  private locked = false; // second point placed → readout frozen
  private unit: Unit = "mm";

  onActivate(ctx: ToolContext): void {
    this.unit = ctx.doc.displayUnit;
    this.reset();
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    this.unit = ctx.doc.displayUnit;
    if (!this.first || this.locked) {
      this.first = e.world; // start (or restart) a measurement
      this.cursor = e.world;
      this.locked = false;
    } else {
      this.cursor = e.world; // drop the second point and freeze
      this.locked = true;
    }
    ctx.requestRender();
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    if (!this.first || this.locked) return;
    this.cursor = e.world;
    ctx.requestRender();
  }

  onKeyDown(e: KeyboardEvent, ctx: ToolContext): void {
    if (e.key === "Escape") this.cancel(ctx);
  }

  cancel(ctx: ToolContext): void {
    this.reset();
    ctx.requestRender();
  }

  getOverlay(): ToolOverlay {
    if (!this.first) return { previews: [], selectionRect: null };
    const a = this.first, b = this.cursor;
    const previews: PreviewShape[] = [{ kind: "point", pos: a }];

    const d = dist(a, b);
    if (d > 1e-9) {
      const dx = b.x - a.x, dy = b.y - a.y;
      const angleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
      const text =
        `${formatLengthWithUnit(d, this.unit)}   ` +
        `Δx ${formatLength(dx, this.unit)}  Δy ${formatLength(dy, this.unit)}  ∠ ${angleDeg.toFixed(1)}°`;
      previews.push(
        { kind: "line", a, b },
        { kind: "point", pos: b },
        { kind: "text", pos: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, text, dx: 8, dy: -8 },
      );
    }
    return { previews, selectionRect: null };
  }

  private reset(): void {
    this.first = null;
    this.locked = false;
  }
}
