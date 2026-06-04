/**
 * Application shell: owns the document, view, tools, and UI, and translates raw
 * DOM input into tool/viewport actions. This is the only place that touches the
 * browser event system — everything below it works in clean model/view terms.
 */

import { Vec2 } from "./core/vec2";
import { CADDocument } from "./model/document";
import { ProjectManager } from "./io/projectManager";
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
import { ArcTool } from "./tools/arcTool";
import { OffsetTool } from "./tools/offsetTool";
import { BezierTool } from "./tools/bezierTool";
import { ToolPalette } from "./ui/toolPalette";
import { TopBar } from "./ui/topBar";
import { SettingsBar } from "./ui/settingsBar";
import { PropertiesBar } from "./ui/propertiesBar";
import { StatusBar } from "./ui/statusBar";
import { ConstraintBar } from "./ui/constraintBar";
import { CamBar } from "./ui/camBar";
import { DimEditor } from "./ui/dimEditor";
import { showWelcomeScreen } from "./ui/welcomeScreen";

const HOVER_TOLERANCE_PX = 8;

const SHORTCUTS: Record<string, string> = {
  v: "select",
  l: "line",
  r: "rect",
  c: "circle",
  a: "arc",
  p: "polyline",
  d: "dimension",
  o: "offset",
  b: "bezier",
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

  private project: ProjectManager;

  // pan state
  private panning = false;
  private panLast: Vec2 = { x: 0, y: 0 };
  private spaceDown = false;

  private dimEditor = new DimEditor();
  // generic floating value editor (e.g. arc length)
  private valueEditor: HTMLInputElement | null = null;

  constructor(private canvas: HTMLCanvasElement, dom: {
    palette: HTMLElement;
    topbar: HTMLElement;
    settingsbar: HTMLElement;
    propertiesbar: HTMLElement;
    cambar: HTMLElement;
    constraintbar: HTMLElement;
    statusbar: HTMLElement;
  }) {
    this.doc = new CADDocument({ width: 200, height: 150 }, "mm");
    this.renderer = new Renderer(canvas);

    this.project = new ProjectManager(this.doc, {
      onDocumentChange: () => this.requestRender(),
      onSolve: () => this.runSolve(),
      onFitView: () => this.fitView(),
      onCloseEditors: () => {
        this.dimEditor.close();
        this.closeValueEditor();
      }
    });

    this.tools = new ToolManager(
      {
        doc: this.doc,
        view: this.view,
        requestRender: this.requestRender,
        solve: (pins) => this.runSolve(pins),
        pushHistory: this.project.pushHistory,
        openDimEditor: (dim) => setTimeout(() => this.openDimEditor(dim), 0),
        openValueEditor: (worldPos, placeholder, onCommit, onCancel) => {
          setTimeout(() => this.openValueEditor(worldPos, placeholder, onCommit, onCancel), 0);
        },
        closeValueEditor: () => this.closeValueEditor(),
        currentDof: () => this.currentDof(),
      },
      [
        new SelectTool(),
        new LineTool(),
        new RectTool(),
        new CircleTool(),
        new ArcTool(),
        new PolylineTool(),
        new DimensionTool(),
        new OffsetTool(),
        new BezierTool(),
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
      onUndo: () => this.project.undoRedo("undo"),
      onRedo: () => this.project.undoRedo("redo"),
      onConstructionToggle: () => this.toggleConstruction(),
      onDelete: () => this.deleteSelected(),
      canUndo: () => this.project.history.canUndo,
      canRedo: () => this.project.history.canRedo,
      file: {
        onNew: () => this.project.fileNew(),
        onOpen: () => this.project.fileOpen(),
        onSave: () => this.project.fileSave(),
        onOpenRecent: (e) => this.project.fileOpenRecent(e),
        onImportSvg: () => this.project.svgImport(),
        onExportSvg: () => this.project.svgExport(),
      },
    });
    new SettingsBar(dom.settingsbar, this.doc, this.project.pushHistory);
    new PropertiesBar(
      dom.propertiesbar,
      this.doc,
      this.project.pushHistory,
      () => this.runSolve()
    );
    this.statusBar = new StatusBar(dom.statusbar, this.doc, this.snapEngine, this.requestRender);
    new ConstraintBar(
      dom.constraintbar,
      this.doc,
      () => { this.runSolve(); return this.lastSolveResult; },
      this.project.pushHistory,
      () => this.currentDof(),
      () => this.project.undoRedo("undo")
    );
    new CamBar(dom.cambar, this.doc);

    this.doc.onChange(this.requestRender);

    this.bindEvents();
    this.handleResize();
    this.fitView();

    // Show welcome screen on startup for a fresh empty project
    showWelcomeScreen(
      () => this.project.openSetupDialog(),
      () => { void this.project.fileOpen(); },
      (entry) => this.project.fileOpenRecent(entry),
      () => this.project.restoreDraft()
    );
  }

  private toggleConstruction(): void {
    const selected = this.doc.selected;
    if (selected.length > 0) {
      const allAreConstruction = selected.every((e) => e.isConstruction);
      this.project.pushHistory();
      for (const e of selected) e.isConstruction = !allAreConstruction;
    } else {
      this.project.pushHistory();
      this.doc.isConstructionMode = !this.doc.isConstructionMode;
    }
    this.doc.emitChange();
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
  private lastSolveResult: import("./solver/solver").SolveResult | null = null;

  private currentDof(): number {
    if (!this.lastSolveResult) return Infinity;
    return this.lastSolveResult.variables - this.lastSolveResult.equations;
  }

  private runSolve(pins?: PinMap): void {
    const res = solve(this.doc, pins);
    if (!pins) this.lastSolveResult = res; // only store non-drag results for DOF checks
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
      (this.tools.active.id === "select" || this.tools.active.id === "offset")
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
    const geo: Geo = ((m) => (id: string) => m.get(id))(
      new Map(this.doc.entities.map((e) => [e.id, e])),
    );
    const layout = dimensionLayout(dim, geo, this.doc.displayUnit);
    if (!layout) return;

    this.dimEditor.open({
      dim,
      container: this.canvas.parentElement!,
      screenPos: this.view.worldToScreen(layout.textPos),
      displayUnit: this.doc.displayUnit,
      onCommit: (v) => this.commitDimValue(dim, v),
    });
  }

  private commitDimValue(dim: Dimension, v: number): boolean {
    // Adding a driving equation to a fully-constrained sketch is rejected.
    if (!dim.driving && this.currentDof() < 1) return false;

    // Arc-length cannot exceed full circumference.
    if (dim.type === "arclength") {
      const byId = new Map(this.doc.entities.map((e) => [e.id, e]));
      const ent = byId.get(dim.entities[0]) as import("./model/entities").ArcEntity | undefined;
      if (ent?.type === "arc" && v >= 2 * Math.PI * ent.radius) return false;
    }

    const docSnap = this.doc.snapshot();
    const oldVal = dim.value;
    const oldDriving = dim.driving;

    dim.value = v;
    dim.driving = true;
    this.runSolve();

    if (this.lastSolveResult && !this.lastSolveResult.converged) {
      dim.value = oldVal;
      dim.driving = oldDriving;
      this.runSolve();
      return false;
    }

    this.project.pushHistory(docSnap);
    return true;
  }



  private openValueEditor(worldPos: Vec2, placeholder: string, onCommit: (raw: string) => boolean | void, onCancel: () => void): void {
    this.closeValueEditor();
    const pos = this.view.worldToScreen(worldPos);
    const input = document.createElement("input");
    input.type = "text";
    input.className = "dim-edit";
    input.placeholder = placeholder;
    input.style.left = `${pos.x - 36}px`;
    input.style.top = `${pos.y + 14}px`;

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const raw = input.value;
        const ok = onCommit(raw);
        if (ok === false) {
          input.style.color = "#e05555";
          setTimeout(() => { input.style.color = ""; }, 600);
        } else {
          this.closeValueEditor();
        }
      } else if (e.key === "Escape") {
        this.closeValueEditor();
        onCancel();
      }
      e.stopPropagation();
    });
    // Blur just closes silently — canvas click commits via pointer event.
    input.addEventListener("blur", () => {
      if (this.valueEditor === input) {
        this.valueEditor = null;
        input.remove();
      }
    });

    this.canvas.parentElement!.appendChild(input);
    this.valueEditor = input;
    input.focus();
  }

  private closeValueEditor(): void {
    if (this.valueEditor) {
      const el = this.valueEditor;
      this.valueEditor = null;
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

  private deleteSelected(): void {
    if (this.doc.selectedConstraintId) {
      this.project.pushHistory();
      this.doc.removeConstraint(this.doc.selectedConstraintId);
      this.runSolve();
    } else if (this.doc.selectedDimensionId) {
      this.project.pushHistory();
      this.doc.removeDimension(this.doc.selectedDimensionId);
      this.runSolve();
    } else if (this.doc.selected.length > 0 || this.doc.selectedPoints.length > 0) {
      this.project.pushHistory();
      this.doc.removeSelected();
      this.runSolve();
    }
  }

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
      this.project.undoRedo(ev.shiftKey ? "redo" : "undo");
      ev.preventDefault();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "y") {
      this.project.undoRedo("redo");
      ev.preventDefault();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
      this.project.fileSave();
      ev.preventDefault();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "o") {
      void this.project.fileOpen();
      ev.preventDefault();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "n") {
      this.project.fileNew();
      ev.preventDefault();
      return;
    }
    
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "g") {
      ev.preventDefault();
      if (ev.shiftKey) {
        // Ungroup
        const selectedIds = new Set(this.doc.selected.map(e => e.id));
        const groupsToKeep = this.doc.groups.filter(g => !g.entityIds.some(id => selectedIds.has(id)));
        if (groupsToKeep.length !== this.doc.groups.length) {
          this.project.pushHistory();
          this.doc.groups = groupsToKeep;
          this.doc.emitChange();
        }
      } else {
        // Group
        if (this.doc.selected.length >= 2) {
          this.project.pushHistory();
          import("./model/ids").then(({ nextId }) => {
            const group = {
              id: nextId("grp"),
              entityIds: this.doc.selected.map(e => e.id)
            };
            this.doc.groups.push(group);
            this.doc.emitChange();
          });
        }
      }
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
      this.deleteSelected();
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
