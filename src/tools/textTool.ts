import type { Vec2 } from "../core/vec2";
import { TextEntity } from "../model/entities";
import type { Tool, ToolContext, ToolPointerEvent, ToolOverlay } from "./tool";
import { ICONS } from "./icons";
import { openTextDialog } from "../ui/textEditDialog";
import { defaultFontId, getTextInkBox } from "../core/fontManager";

export class TextTool implements Tool {
  readonly id = "text";
  readonly label = "Text";
  readonly icon = ICONS.text;

  private pendingText = "";
  private pendingFontId = "";
  private pendingSizeMM = 10;
  private pendingAngle = 0;
  private hoverPos: Vec2 | null = null;
  private closeDialog: (() => void) | null = null;

  onActivate(ctx: ToolContext): void {
    this.hoverPos = null;
    this.closeDialog = openTextDialog(
      {
        text: this.pendingText,
        fontId: this.pendingFontId || defaultFontId(),
        sizeMM: this.pendingSizeMM,
        angle: this.pendingAngle,
      },
      "Stamp (click canvas)",
      (p) => {
        this.pendingText = p.text;
        this.pendingFontId = p.fontId;
        this.pendingSizeMM = p.sizeMM;
        this.pendingAngle = p.angle;
        this.closeDialog = null;
        ctx.requestRender();
      },
      () => {
        this.pendingText = "";
        this.closeDialog = null;
        ctx.requestRender();
      },
    );
  }

  onDeactivate(_ctx: ToolContext): void {
    this.closeDialog?.();
    this.closeDialog = null;
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    if (!this.pendingText) return;
    this.hoverPos = e.world;
    ctx.requestRender();
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0 || !this.pendingText || !this.hoverPos || !this.pendingFontId) return;

    ctx.pushHistory();
    const ent = new TextEntity(
      this.pendingText,
      this.pendingFontId,
      this.pendingSizeMM,
      { ...this.hoverPos },
      this.pendingAngle,
    );
    ctx.doc.addSelected(ent);
    ctx.requestRender();
  }

  cancel(ctx: ToolContext): void {
    this.closeDialog?.();
    this.closeDialog = null;
    this.pendingText = "";
    this.hoverPos = null;
    ctx.requestRender();
  }

  getOverlay(): ToolOverlay {
    if (!this.pendingText || !this.hoverPos) return { previews: [], selectionRect: null };
    const pos = this.hoverPos;
    // Real ink extents when the font is loaded so the stamped text lands
    // exactly inside the preview box; estimate otherwise.
    const ink = getTextInkBox(this.pendingFontId, this.pendingText, this.pendingSizeMM);
    const box = ink ?? {
      min: { x: 0, y: 0 },
      max: {
        x: this.pendingSizeMM * 0.6 * Math.max(this.pendingText.length, 1),
        y: this.pendingSizeMM * 1.2,
      },
    };
    const cos = Math.cos(this.pendingAngle),
      sin = Math.sin(this.pendingAngle);
    const corners = [
      { x: box.min.x, y: box.min.y },
      { x: box.max.x, y: box.min.y },
      { x: box.max.x, y: box.max.y },
      { x: box.min.x, y: box.max.y },
    ].map((p) => ({
      x: pos.x + p.x * cos - p.y * sin,
      y: pos.y + p.x * sin + p.y * cos,
    }));
    return {
      previews: [{ kind: "polyline", points: corners, closed: true }],
      selectionRect: null,
    };
  }
}
