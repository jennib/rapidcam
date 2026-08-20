import type { Vec2 } from "../core/vec2";
import { TextEntity } from "../model/entities";
import type { Tool, ToolContext, ToolPointerEvent, ToolOverlay } from "./tool";
import type { PreviewShape } from "../view/overlay";
import { ICONS } from "./icons";
import { openTextDialog, type TextParams } from "../ui/textEditDialog";
import { defaultFontId, getTextInkBox } from "../core/fontManager";
import { textToContours } from "../cam/textOutlines";

/**
 * Text tool — place first, then type (the Fusion / SolidWorks / LightBurn flow).
 *
 * Activating the tool arms nothing: the first canvas click sets the
 * baseline-left anchor and opens the "Place Text" dialog docked to the side,
 * previewing the glyphs live at that anchor as the fields change. A further
 * canvas click while the dialog is open moves the anchor. "Place" commits a
 * TextEntity and hands back to Select; Cancel/Escape drops it.
 */
export class TextTool implements Tool {
  readonly id = "text";
  readonly label = "Text";
  readonly icon = ICONS.text;

  // Remembered defaults, seeded into the dialog the next time it opens.
  private pendingFontId = "";
  private pendingSizeMM = 10;
  private pendingAngle = 0;

  // Live-placement state.
  private pendingText = "";
  private anchor: Vec2 | null = null;
  private dialogOpen = false;
  private closeDialog: (() => void) | null = null;
  /** Cached preview shapes, rebuilt only when the pending state changes. */
  private previewShapes: PreviewShape[] = [];

  onActivate(_ctx: ToolContext): void {
    this.anchor = null;
    this.dialogOpen = false;
    this.pendingText = "";
    this.closeDialog = null;
    this.rebuildPreview();
  }

  onDeactivate(_ctx: ToolContext): void {
    this.closeDialog?.();
    this.closeDialog = null;
    this.dialogOpen = false;
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    if (!this.dialogOpen) {
      // First click sets the anchor and opens the editor.
      this.anchor = { ...e.world };
      this.openDialog(ctx);
    } else {
      // A canvas click while the dialog is open moves the anchor (the
      // drag-to-place that Fusion and LightBurn allow).
      this.anchor = { ...e.world };
      this.rebuildPreview();
      ctx.requestRender();
    }
  }

  cancel(ctx: ToolContext): void {
    this.closeDialog?.();
    this.closeDialog = null;
    this.dialogOpen = false;
    this.anchor = null;
    this.pendingText = "";
    this.rebuildPreview();
    ctx.requestRender();
  }

  private openDialog(ctx: ToolContext): void {
    this.dialogOpen = true;
    this.closeDialog = openTextDialog({
      initial: {
        text: "",
        fontId: this.pendingFontId || defaultFontId(),
        sizeMM: this.pendingSizeMM,
        angle: this.pendingAngle,
      },
      applyLabel: "Place",
      title: "Place Text",
      displayUnit: ctx.doc.displayUnit,
      // Non-blocking side-docked panel so the glyph preview stays visible while
      // typing, and canvas clicks can move the anchor (see onPointerDown).
      peek: true,
      onChange: (p) => {
        this.pendingText = p.text;
        this.pendingFontId = p.fontId;
        this.pendingSizeMM = p.sizeMM;
        this.pendingAngle = p.angle;
        this.rebuildPreview();
        ctx.requestRender();
      },
      onApply: (p) => this.commit(ctx, p),
      onCancel: () => {
        // The dialog already dismissed itself. Abandon placement and hand back
        // to Select — placing text is a finished-or-aborted gesture. This runs
        // from the dialog's own dismiss path, never from cancel(), so switching
        // tools here cannot recurse.
        this.closeDialog = null;
        this.dialogOpen = false;
        this.anchor = null;
        this.pendingText = "";
        this.rebuildPreview();
        ctx.activateTool("select");
      },
    });
  }

  private commit(ctx: ToolContext, p: TextParams): void {
    const anchor = this.anchor;
    if (!anchor) return;
    ctx.pushHistory();
    const ent = new TextEntity(p.text, p.fontId, p.sizeMM, { ...anchor }, p.angle);
    ctx.doc.addSelected(ent);
    // Remember the choices for the next placement.
    this.pendingFontId = p.fontId;
    this.pendingSizeMM = p.sizeMM;
    this.pendingAngle = p.angle;
    this.closeDialog = null;
    this.dialogOpen = false;
    this.anchor = null;
    this.pendingText = "";
    this.rebuildPreview();
    ctx.requestRender();
    // Placing text is a FINISHED gesture, so hand back to Select — leaving the
    // new text selected and ready to move, align or edit.
    ctx.activateTool("select");
  }

  /**
   * Rebuild the live preview: the anchor marker plus the glyph outlines (when
   * the font is loaded) or the old estimate box (when it isn't). Called only on
   * a state change so `getOverlay` never re-runs the glyph conversion per frame.
   */
  private rebuildPreview(): void {
    const anchor = this.anchor;
    if (!anchor) {
      this.previewShapes = [];
      return;
    }
    const previews: PreviewShape[] = [{ kind: "point", pos: anchor }];
    if (this.pendingText && this.pendingFontId) {
      const ent = new TextEntity(
        this.pendingText,
        this.pendingFontId,
        this.pendingSizeMM,
        anchor,
        this.pendingAngle,
      );
      const contours = textToContours(ent);
      if (contours.length > 0) {
        previews.push(
          ...contours.map((c) => ({
            kind: "polyline" as const,
            points: c.points,
            closed: c.closed,
          })),
        );
      } else {
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
        previews.push({
          kind: "polyline",
          points: [
            { x: box.min.x, y: box.min.y },
            { x: box.max.x, y: box.min.y },
            { x: box.max.x, y: box.max.y },
            { x: box.min.x, y: box.max.y },
          ].map((p) => ({
            x: anchor.x + p.x * cos - p.y * sin,
            y: anchor.y + p.x * sin + p.y * cos,
          })),
          closed: true,
        });
      }
    }
    this.previewShapes = previews;
  }

  getOverlay(): ToolOverlay {
    return { previews: this.previewShapes, selectionRect: null };
  }
}
