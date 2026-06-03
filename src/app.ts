/**
 * Application shell: owns the document, view, tools, and UI, and translates raw
 * DOM input into tool/viewport actions. This is the only place that touches the
 * browser event system — everything below it works in clean model/view terms.
 */

import { Vec2 } from "./core/vec2";
import { parseLength, formatLength } from "./core/units";
import { CADDocument, DocSnapshot } from "./model/document";
import { History } from "./model/history";
import { Bounds, EntityId } from "./model/entities";
import { Geo } from "./model/constraints";
import { Dimension, dimensionLayout } from "./model/dimensions";
import { Viewport } from "./view/viewport";
import { Renderer } from "./view/renderer";
import { Overlay } from "./view/overlay";
import { SnapEngine, SnapResult } from "./input/snapping";
import { solve, PinMap } from "./solver/solver";
import { ToolManager, ToolPointerEvent } from "./tools/tool";
import { SelectTool } from "./tools/selectTool";
import { LineTool } from "./tools/lineTool";
import { RectTool } from "./tools/rectTool";
import { CircleTool } from "./tools/circleTool";
import { PolylineTool } from "./tools/polylineTool";
import { DimensionTool } from "./tools/dimensionTool";
import { ToolPalette } from "./ui/toolPalette";
import { TopBar } from "./ui/topBar";
import { SettingsBar } from "./ui/settingsBar";
import { StatusBar } from "./ui/statusBar";
import { ConstraintBar } from "./ui/constraintBar";

const HOVER_TOLERANCE_PX = 8;

const SHORTCUTS: Record<string, string> = {
  v: "select",
  l: "line",
  r: "rect",
  c: "circle",
  p: "polyline",
  d: "dimension",
};

export class App {
  private doc: CADDocument;
  private view = new Viewport();
  private renderer: Renderer;
  private snapEngine = new SnapEngine();
  private tools: ToolManager;
  private statusBar: StatusBar;

  private currentSnap: SnapResult["snap"] = null;
  private currentHover: EntityId | null = null;
  private renderScheduled = false;

  private history = new History<DocSnapshot>();

  // pan state
  private panning = false;
  private panLast: Vec2 = { x: 0, y: 0 };
  private spaceDown = false;

  // inline dimension value editor
  private dimEditor: HTMLInputElement | null = null;

  constructor(private canvas: HTMLCanvasElement, dom: {
    palette: HTMLElement;
    topbar: HTMLElement;
    settingsbar: HTMLElement;
    constraintbar: HTMLElement;
    statusbar: HTMLElement;
  }) {
    this.doc = new CADDocument({ width: 200, height: 150 }, "mm");
    this.renderer = new Renderer(canvas);

    this.tools = new ToolManager(
      {
        doc: this.doc,
        view: this.view,
        requestRender: this.requestRender,
        solve: (pins) => this.runSolve(pins),
        pushHistory: this.pushHistory,
        openDimEditor: (dim) => setTimeout(() => this.openDimEditor(dim), 0),
      },
      [
        new SelectTool(),
        new LineTool(),
        new RectTool(),
        new CircleTool(),
        new PolylineTool(),
        new DimensionTool(),
      ],
      "select",
    );

    this.tools.onActiveChange(() => {
      canvas.style.cursor = this.tools.active.id === "select" ? "default" : "crosshair";
    });
    canvas.style.cursor = this.tools.active.id === "select" ? "default" : "crosshair";

    new ToolPalette(dom.palette, this.tools);
    new TopBar(dom.topbar, this.doc, {
      onFit: () => this.fitView(),
      onUndo: () => this.undoRedo("undo"),
      onRedo: () => this.undoRedo("redo"),
      onConstructionToggle: () => this.toggleConstruction(),
      canUndo: () => this.history.canUndo,
      canRedo: () => this.history.canRedo,
    });
    new SettingsBar(dom.settingsbar, this.doc);
    this.statusBar = new StatusBar(dom.statusbar, this.doc, this.snapEngine, this.requestRender);
    new ConstraintBar(dom.constraintbar, this.doc, () => this.runSolve(), this.pushHistory);

    this.doc.onChange(this.requestRender);

    this.bindEvents();
    this.handleResize();
    this.fitView();
  }

  // --- history -------------------------------------------------------------
  private pushHistory = (): void => {
    this.history.push(this.doc.snapshot());
  };

  private toggleConstruction(): void {
    const selected = this.doc.selected;
    if (selected.length > 0) {
      const allAreConstruction = selected.every((e) => e.isConstruction);
      this.pushHistory();
      for (const e of selected) e.isConstruction = !allAreConstruction;
    } else {
      this.pushHistory();
      this.doc.isConstructionMode = !this.doc.isConstructionMode;
    }
    this.doc.emitChange();
  }

  private undoRedo(dir: "undo" | "redo"): void {
    const snap =
      dir === "undo"
        ? this.history.undo(this.doc.snapshot())
        : this.history.redo(this.doc.snapshot());
    if (!snap) return;
    this.closeDimEditor();
    this.doc.restore(snap);
    this.runSolve();
  }

  // --- render loop ---------------------------------------------------------
  private requestRender = (): void => {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      this.render();
    });
  };

  // --- constraint solving --------------------------------------------------
  private runSolve(pins?: PinMap): void {
    const res = solve(this.doc, pins);
    this.statusBar.setSolveStatus(res.hasConstraints ? res : null);
    this.requestRender();
  }

  private render(): void {
    const to = this.tools.overlay();
    const overlay: Overlay = {
      previews: to.previews,
      selectionRect: to.selectionRect,
      snap: this.currentSnap,
      hover: this.currentHover,
    };
    this.renderer.render(this.doc, this.view, overlay);
    this.statusBar.setZoom(this.view.scale);
  }

  // --- view fitting --------------------------------------------------------
  private fitView(): void {
    const wa: Bounds = { min: { x: 0, y: 0 }, max: { x: this.doc.canvas.width, y: this.doc.canvas.height } };
    const gb = this.doc.bounds();
    const b = gb ? unionBounds(wa, gb) : wa;
    this.view.fit(b, 48);
    this.requestRender();
  }

  // --- sizing --------------------------------------------------------------
  private handleResize = (): void => {
    const { width, height } = this.renderer.resize();
    this.view.setSize(width, height);
    this.requestRender();
  };

  // --- event wiring --------------------------------------------------------
  private bindEvents(): void {
    const c = this.canvas;
    c.addEventListener("pointerdown", this.onPointerDown);
    c.addEventListener("pointermove", this.onPointerMove);
    c.addEventListener("pointerup", this.onPointerUp);
    c.addEventListener("dblclick", this.onDoubleClick);
    c.addEventListener("wheel", this.onWheel, { passive: false });
    c.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.tools.cancelActive();
    });

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("resize", this.handleResize);
    new ResizeObserver(this.handleResize).observe(c.parentElement!);
  }

  private screenOf(ev: PointerEvent | WheelEvent | MouseEvent): Vec2 {
    const rect = this.canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  private toolEvent(ev: PointerEvent | MouseEvent, screen: Vec2): ToolPointerEvent {
    const snap = this.snapEngine.resolve(screen, this.view, this.doc);
    this.currentSnap = snap.snap;
    return {
      world: snap.world,
      worldRaw: this.view.screenToWorld(screen),
      screen,
      snap: snap.snap,
      button: ev.button,
      shiftKey: ev.shiftKey,
      ctrlKey: ev.ctrlKey,
      altKey: ev.altKey,
    };
  }

  // --- pointer -------------------------------------------------------------
  private onPointerDown = (ev: PointerEvent): void => {
    const screen = this.screenOf(ev);
    const isPan = ev.button === 1 || (ev.button === 0 && this.spaceDown);
    if (isPan) {
      this.panning = true;
      this.panLast = screen;
      this.canvas.setPointerCapture(ev.pointerId);
      ev.preventDefault();
      return;
    }
    this.canvas.setPointerCapture(ev.pointerId);
    this.tools.pointerDown(this.toolEvent(ev, screen));
    this.requestRender();
  };

  private onPointerMove = (ev: PointerEvent): void => {
    const screen = this.screenOf(ev);
    if (this.panning) {
      this.view.panBy(screen.x - this.panLast.x, screen.y - this.panLast.y);
      this.panLast = screen;
      this.statusBar.setCursor(this.view.screenToWorld(screen));
      this.requestRender();
      return;
    }
    const e = this.toolEvent(ev, screen);
    this.currentHover =
      this.tools.active.id === "select"
        ? (this.doc.hitTest(e.worldRaw, this.view.toWorldLen(HOVER_TOLERANCE_PX))?.id ?? null)
        : null;
    this.statusBar.setCursor(e.world);
    this.tools.pointerMove(e);
    this.requestRender();
  };

  private onPointerUp = (ev: PointerEvent): void => {
    if (this.panning) {
      this.panning = false;
      this.canvas.releasePointerCapture(ev.pointerId);
      return;
    }
    const screen = this.screenOf(ev);
    this.tools.pointerUp(this.toolEvent(ev, screen));
    this.canvas.releasePointerCapture(ev.pointerId);
    this.requestRender();
  };

  private onDoubleClick = (ev: MouseEvent): void => {
    const screen = this.screenOf(ev);
    const world = this.view.screenToWorld(screen);
    // Editing a dimension's value works in any tool.
    const dim = this.doc.dimensionAt(world, this.view.toWorldLen(8));
    if (dim) {
      this.openDimEditor(dim);
      return;
    }
    this.tools.doubleClick(this.toolEvent(ev, screen));
    this.requestRender();
  };

  // --- inline dimension value editor ---------------------------------------
  private openDimEditor(dim: Dimension): void {
    this.closeDimEditor();
    const geo: Geo = ((m) => (id: string) => m.get(id))(
      new Map(this.doc.entities.map((e) => [e.id, e])),
    );
    const layout = dimensionLayout(dim, geo, this.doc.displayUnit);
    if (!layout) return;
    const pos = this.view.worldToScreen(layout.textPos);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "dim-edit";
    input.value = formatLength(dim.value, this.doc.displayUnit);
    input.style.left = `${pos.x - 36}px`;
    input.style.top = `${pos.y - 11}px`;

    const commit = () => {
      if (this.dimEditor !== input) return; // already closed (avoid double-commit on blur)
      const v = parseLength(input.value, this.doc.displayUnit);
      if (v !== null && v > 0) {
        this.pushHistory();
        dim.value = v;
        dim.driving = true;
        this.runSolve();
      }
      this.closeDimEditor();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      else if (e.key === "Escape") this.closeDimEditor();
      e.stopPropagation();
    });
    input.addEventListener("blur", commit);

    this.canvas.parentElement!.appendChild(input);
    this.dimEditor = input;
    input.focus();
    input.select();
  }

  private closeDimEditor(): void {
    if (this.dimEditor) {
      const el = this.dimEditor;
      this.dimEditor = null;
      el.remove();
    }
  }

  private onWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    const screen = this.screenOf(ev);
    const factor = Math.exp(-ev.deltaY * 0.0015);
    this.view.zoomAt(screen, factor);
    this.statusBar.setCursor(this.view.screenToWorld(screen));
    this.requestRender();
  };

  // --- keyboard ------------------------------------------------------------
  private onKeyDown = (ev: KeyboardEvent): void => {
    if (isTypingTarget(ev.target)) return;

    if (ev.key === " ") {
      this.spaceDown = true;
      ev.preventDefault();
      return;
    }

    if (ev.key.toLowerCase() === "x" && !ev.ctrlKey && !ev.metaKey) {
      this.toggleConstruction();
      ev.preventDefault();
      return;
    }

    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z") {
      this.undoRedo(ev.shiftKey ? "redo" : "undo");
      ev.preventDefault();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "y") {
      this.undoRedo("redo");
      ev.preventDefault();
      return;
    }

    // Let the active tool consume the key first (Enter, Backspace, Escape…).
    this.tools.keyDown(ev);

    if (ev.key === "Escape") {
      this.tools.cancelActive();
      return;
    }

    const isSelect = this.tools.active.id === "select";
    if (ev.key === "Delete" || (ev.key === "Backspace" && isSelect)) {
      this.pushHistory();
      this.doc.removeSelected();
      this.runSolve();
      ev.preventDefault();
      return;
    }

    const toolId = SHORTCUTS[ev.key.toLowerCase()];
    if (toolId && !ev.ctrlKey && !ev.metaKey) {
      this.tools.activate(toolId);
    }
  };

  private onKeyUp = (ev: KeyboardEvent): void => {
    if (ev.key === " ") this.spaceDown = false;
  };
}

function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    min: { x: Math.min(a.min.x, b.min.x), y: Math.min(a.min.y, b.min.y) },
    max: { x: Math.max(a.max.x, b.max.x), y: Math.max(a.max.y, b.max.y) },
  };
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || t.isContentEditable;
}
