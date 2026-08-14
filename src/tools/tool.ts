/** Tool framework: the interface every tool implements, plus the manager that routes input. */

import type { Vec2 } from "../core/vec2";
import type { SnapPoint } from "../model/entities";
import type { CADDocument } from "../model/document";
import type { Dimension } from "../model/dimensions";
import type { Viewport } from "../view/viewport";
import type { PreviewShape, TransformBox } from "../view/overlay";
import type { PinMap } from "../solver/solver";
import type { SnapEngine } from "../input/snapping";

export interface ToolContext {
  doc: CADDocument;
  view: Viewport;
  /** The app's snap engine (object/grid snap state + drag snapping). */
  snap: SnapEngine;
  /** Ask the app to re-render (for live previews that don't mutate the doc). */
  requestRender(): void;
  /** Run the constraint solver, optionally pinning point DOFs to targets, then render. */
  solve(pins?: PinMap): void;
  /** Snapshot the document state before a mutation so it can be undone. */
  pushHistory(): void;
  /** Open the inline dimension value editor for the given dimension. */
  openDimEditor(dim: Dimension): void;
  /** Returns variables − equations from the last non-drag solve (≥ 0 means free DOFs remain; 0 = fully constrained). */
  currentDof(): number;
  /** Show a transient status-bar message — use whenever an interaction is
   *  refused or silently alters its effect, so the user learns why. */
  notify(msg: string): void;
  /** Override the status-bar hint line during a modal interaction (e.g. the
   *  modifiers that apply mid-drag); pass null to restore the active tool's
   *  default hint. */
  setHint(text: string | null): void;
  /**
   * Open the **Type to Draw** field(s) near `worldPos` — the floating input a
   * tool offers mid-gesture so an exact value can be typed instead of clicking
   * the next point. See `TYPE_TO_DRAW_TOOLS` in ./shortcuts.
   *
   * Not to be confused with {@link ToolContext.openDimEditor}, which edits an
   * existing dimension. Both used to be called "the value editor".
   */
  openTypeToDraw(
    worldPos: Vec2,
    fields: TypeToDrawField[],
    handlers: TypeToDrawHandlers,
  ): void;
  /** Close the Type to Draw fields without committing. */
  closeTypeToDraw(): void;
  /**
   * Hand control to another tool — for a tool whose gesture is *finished*, not
   * merely paused (the Text tool places one text and is done).
   *
   * MUST NOT be called from `cancel()`. `ToolManager.activate` calls the
   * outgoing tool's `cancel` before switching, so a `cancel` that switches tools
   * recurses forever.
   */
  activateTool(id: string): void;
}

export interface TypeToDrawField {
  placeholder: string;
  initial?: string;
}

export interface TypeToDrawHandlers {
  /**
   * Enter was pressed. Return `false` to reject the input — the field flashes
   * red and stays open, so a typo costs a retype rather than a fresh gesture.
   */
  onCommit: (raws: string[]) => boolean | undefined;
  /** Escape was pressed. */
  onCancel: () => void;
  /** Every keystroke, for a live preview. Values are raw, unparsed strings. */
  onChange?: (raws: string[]) => void;
  /**
   * Single-field only: what Tab does when there is no next field to move to.
   * With two or more fields Tab moves between them and this is ignored.
   */
  onTab?: () => void;
  /**
   * Backspace pressed while EVERY field is empty — there is no text left to
   * delete, so the tool may claim the key. Gated on empty precisely so it can
   * never eat a character the user meant to erase. The polyline tool uses it to
   * step back a vertex, which is what Backspace did before its fields took focus.
   */
  onEmptyBackspace?: () => void;
}

export interface ToolPointerEvent {
  /** Snapped world position drawing tools should use. */
  world: Vec2;
  /** Un-snapped world position (for picking/marquee where snapping would hurt). */
  worldRaw: Vec2;
  /** Raw screen position in CSS pixels. */
  screen: Vec2;
  /** Object snap hit at this position, if any. */
  snap: SnapPoint | null;
  button: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export interface ToolOverlay {
  previews: PreviewShape[];
  selectionRect: { a: Vec2; b: Vec2; crossing: boolean } | null;
  transformBox?: TransformBox | null;
  /** Snap marker contributed by the tool (e.g. drag snapping); wins over the
   *  cursor snap when present. */
  snap?: SnapPoint | null;
}

const EMPTY_OVERLAY: ToolOverlay = { previews: [], selectionRect: null };

export interface Tool {
  readonly id: string;
  readonly label: string;
  /** Inline SVG markup for the palette button. */
  readonly icon: string;

  onActivate?(ctx: ToolContext): void;
  onDeactivate?(ctx: ToolContext): void;
  onPointerDown?(e: ToolPointerEvent, ctx: ToolContext): void;
  onPointerMove?(e: ToolPointerEvent, ctx: ToolContext): void;
  onPointerUp?(e: ToolPointerEvent, ctx: ToolContext): void;
  onDoubleClick?(e: ToolPointerEvent, ctx: ToolContext): void;
  onKeyDown?(e: KeyboardEvent, ctx: ToolContext): void;
  /** Transient visuals contributed by the tool. */
  getOverlay?(ctx: ToolContext): ToolOverlay;
  /** Abandon any in-progress operation. */
  cancel?(ctx: ToolContext): void;
}

export class ToolManager {
  private tools = new Map<string, Tool>();
  active!: Tool;
  private changeCbs = new Set<() => void>();

  constructor(
    private ctx: ToolContext,
    tools: Tool[],
    defaultId: string,
  ) {
    for (const t of tools) this.tools.set(t.id, t);
    this.activate(defaultId);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  activate(id: string): void {
    const next = this.tools.get(id);
    if (!next || next === this.active) return;
    this.active?.cancel?.(this.ctx);
    this.active?.onDeactivate?.(this.ctx);
    this.active = next;
    this.active.onActivate?.(this.ctx);
    this.emitChange();
    this.ctx.requestRender();
  }

  onActiveChange(cb: () => void): void {
    this.changeCbs.add(cb);
  }
  private emitChange(): void {
    for (const cb of this.changeCbs) cb();
  }

  // --- input routing -------------------------------------------------------
  pointerDown(e: ToolPointerEvent): void {
    this.active.onPointerDown?.(e, this.ctx);
  }
  pointerMove(e: ToolPointerEvent): void {
    this.active.onPointerMove?.(e, this.ctx);
  }
  pointerUp(e: ToolPointerEvent): void {
    this.active.onPointerUp?.(e, this.ctx);
  }
  doubleClick(e: ToolPointerEvent): void {
    this.active.onDoubleClick?.(e, this.ctx);
  }
  keyDown(e: KeyboardEvent): void {
    this.active.onKeyDown?.(e, this.ctx);
  }
  cancelActive(): void {
    this.active.cancel?.(this.ctx);
    this.ctx.requestRender();
  }
  overlay(): ToolOverlay {
    return this.active.getOverlay?.(this.ctx) ?? EMPTY_OVERLAY;
  }
}
