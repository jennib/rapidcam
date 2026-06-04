/** Tool framework: the interface every tool implements, plus the manager that routes input. */

import { Vec2 } from "../core/vec2";
import { SnapPoint } from "../model/entities";
import { CADDocument } from "../model/document";
import { Dimension } from "../model/dimensions";
import { Viewport } from "../view/viewport";
import { PreviewShape, TransformBox } from "../view/overlay";
import { PinMap } from "../solver/solver";

export interface ToolContext {
  doc: CADDocument;
  view: Viewport;
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
  /** Show a floating text input near `worldPos`. Pressing Enter calls `onCommit`.
   *  Return `false` from `onCommit` to flash red and keep the editor open; any other return closes it. */
  openValueEditor(worldPos: Vec2, placeholder: string, onCommit: (raw: string) => boolean | void, onCancel: () => void): void;
  /** Close any open floating value editor without committing. */
  closeValueEditor(): void;
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
  selectionRect: { a: Vec2; b: Vec2 } | null;
  transformBox?: TransformBox | null;
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
  getOverlay?(): ToolOverlay;
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
    return this.active.getOverlay?.() ?? EMPTY_OVERLAY;
  }
}
