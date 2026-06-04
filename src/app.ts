/**
 * Application shell: owns the document, view, tools, and UI, and translates raw
 * DOM input into tool/viewport actions. This is the only place that touches the
 * browser event system — everything below it works in clean model/view terms.
 */

import { Vec2 } from "./core/vec2";
import { parseLength, formatLength, parseAngle, formatAngle } from "./core/units";
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
import { ArcTool } from "./tools/arcTool";
import { ToolPalette } from "./ui/toolPalette";
import { TopBar } from "./ui/topBar";
import { SettingsBar } from "./ui/settingsBar";
import { saveFile, openFile, applyFile, serializeDoc, pushRecent } from "./io/fileio";
import type { RecentEntry } from "./io/fileio";
import { PropertiesBar } from "./ui/propertiesBar";
import { StatusBar } from "./ui/statusBar";
import { ConstraintBar } from "./ui/constraintBar";
import { CamBar } from "./ui/camBar";
import { openNewProjectDialog } from "./ui/newProjectDialog";

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

  private currentFileName = "Untitled";
  private currentFileHandle: FileSystemFileHandle | null = null;
  private autosaveTimeout: number | null = null;
  private isDocumentLoading = false;

  // pan state
  private panning = false;
  private panLast: Vec2 = { x: 0, y: 0 };
  private spaceDown = false;

  // inline dimension value editor
  private dimEditor: HTMLInputElement | null = null;
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

    this.tools = new ToolManager(
      {
        doc: this.doc,
        view: this.view,
        requestRender: this.requestRender,
        solve: (pins) => this.runSolve(pins),
        pushHistory: this.pushHistory,
        openDimEditor: (dim) => setTimeout(() => this.openDimEditor(dim), 0),
        openValueEditor: (worldPos, placeholder, onCommit, onCancel) =>
          setTimeout(() => this.openValueEditor(worldPos, placeholder, onCommit, onCancel), 0),
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
      onDelete: () => this.deleteSelected(),
      canUndo: () => this.history.canUndo,
      canRedo: () => this.history.canRedo,
      file: {
        onNew: () => this.fileNew(),
        onOpen: () => this.fileOpen(),
        onSave: () => this.fileSave(),
        onOpenRecent: (e) => this.fileOpenRecent(e),
      },
    });
    new SettingsBar(dom.settingsbar, this.doc);
    new PropertiesBar(dom.propertiesbar, this.doc);
    this.statusBar = new StatusBar(dom.statusbar, this.doc, this.snapEngine, this.requestRender);
    new ConstraintBar(
      dom.constraintbar,
      this.doc,
      () => { this.runSolve(); return this.lastSolveResult; },
      this.pushHistory,
      () => this.currentDof(),
      () => this.undoRedo("undo")
    );
    new CamBar(dom.cambar, this.doc);

    this.doc.onChange(this.requestRender);
    this.doc.onChange(() => this.scheduleAutosave());

    this.bindEvents();
    this.handleResize();
    this.fitView();

    // Show welcome screen on startup for a fresh empty project
    showWelcomeScreen(
      () => this.openSetupDialog(),
      () => { void this.fileOpen(); },
      (entry) => this.fileOpenRecent(entry),
      () => this.restoreDraft()
    );
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

  // --- file operations -----------------------------------------------------
  private fileNew(): void {
    if (this.doc.entities.length && !confirm("Discard current drawing and start new?")) return;
    this.openSetupDialog();
  }

  private openSetupDialog(): void {
    openNewProjectDialog(
      {
        name: this.currentFileName === "Untitled" ? "Untitled" : "Untitled",
      },
      (cfg) => {
        this.isDocumentLoading = true;
        this.history = new History<DocSnapshot>();
        this.doc.clear();
        this.doc.canvas = { width: cfg.width, height: cfg.height };
        this.doc.stockThickness = cfg.stockThickness;
        this.doc.displayUnit = cfg.displayUnit;
        this.doc.origin = { ...cfg.origin };
        this.doc.hasToolChanger = cfg.hasToolChanger;
        this.currentFileName = cfg.name;
        this.currentFileHandle = null;
        localStorage.removeItem("rapidcam:autosave-draft");
        this.doc.emitChange();
        this.fitView();
        this.isDocumentLoading = false;
      },
    );
  }

  private async fileOpen(): Promise<void> {
    const result = await openFile();
    if (!result) return;
    this.isDocumentLoading = true;
    this.history = new History<DocSnapshot>();
    this.closeDimEditor();
    applyFile(this.doc, result.file);
    this.currentFileName = result.name;
    this.currentFileHandle = result.handle ?? null;
    localStorage.removeItem("rapidcam:autosave-draft");
    this.runSolve();
    this.fitView();
    this.isDocumentLoading = false;
  }

  private async fileSave(): Promise<void> {
    if ('showSaveFilePicker' in window) {
      if (this.currentFileHandle) {
        try {
          await this.writeToHandle(this.currentFileHandle);
          const data = serializeDoc(this.doc, this.currentFileName);
          pushRecent({ name: this.currentFileName, savedAt: Date.now(), data });
          localStorage.removeItem("rapidcam:autosave-draft");
          console.log(`Saved successfully to ${this.currentFileName}`);
          return;
        } catch (e) {
          console.error("Save to file handle failed, prompting for a new file:", e);
        }
      }

      try {
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: this.currentFileName.endsWith(".rcam") ? this.currentFileName : `${this.currentFileName}.rcam`,
          types: [{
            description: "RapidCAM Project (.rcam)",
            accept: { "application/json": [".rcam"] }
          }]
        });
        this.currentFileHandle = handle;
        const fileObj = await handle.getFile();
        this.currentFileName = fileObj.name.replace(/\.rcam$/i, "");
        await this.writeToHandle(handle);
        const data = serializeDoc(this.doc, this.currentFileName);
        pushRecent({ name: this.currentFileName, savedAt: Date.now(), data });
        localStorage.removeItem("rapidcam:autosave-draft");
        return;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
      }
    }

    const name = prompt("Save as:", this.currentFileName);
    if (name === null) return;
    this.currentFileName = name || "Untitled";
    this.currentFileHandle = null;
    saveFile(this.doc, this.currentFileName);
    localStorage.removeItem("rapidcam:autosave-draft");
  }

  private fileOpenRecent(entry: RecentEntry): void {
    if (this.doc.entities.length && !confirm(`Discard current drawing and open "${entry.name}"?`)) return;
    this.isDocumentLoading = true;
    this.history = new History<DocSnapshot>();
    this.closeDimEditor();
    applyFile(this.doc, entry.data);
    this.currentFileName = entry.name;
    this.currentFileHandle = null;
    localStorage.removeItem("rapidcam:autosave-draft");
    this.runSolve();
    this.fitView();
    this.isDocumentLoading = false;
  }

  private async writeToHandle(handle: FileSystemFileHandle): Promise<void> {
    const data = serializeDoc(this.doc, this.currentFileName);
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
  }

  private scheduleAutosave(): void {
    if (this.isDocumentLoading) return;
    if (this.autosaveTimeout !== null) {
      clearTimeout(this.autosaveTimeout);
    }
    this.autosaveTimeout = window.setTimeout(() => {
      void this.performAutosave();
    }, 2000);
  }

  private async performAutosave(): Promise<void> {
    if (this.isDocumentLoading) return;
    const docData = serializeDoc(this.doc, this.currentFileName);
    
    const draft = {
      name: this.currentFileName,
      savedAt: Date.now(),
      data: docData
    };
    localStorage.setItem("rapidcam:autosave-draft", JSON.stringify(draft));

    if (this.currentFileHandle) {
      try {
        await this.writeToHandle(this.currentFileHandle);
        console.log(`Autosaved successfully to ${this.currentFileName}`);
      } catch (e) {
        console.error("Autosave to file handle failed:", e);
      }
    }
  }

  private restoreDraft(): void {
    const raw = localStorage.getItem("rapidcam:autosave-draft");
    if (!raw) return;
    try {
      const draft = JSON.parse(raw);
      this.isDocumentLoading = true;
      this.history = new History<DocSnapshot>();
      this.closeDimEditor();
      applyFile(this.doc, draft.data);
      this.currentFileName = draft.name;
      this.currentFileHandle = null;
      this.runSolve();
      this.fitView();
      this.isDocumentLoading = false;
      console.log("Restored auto-save draft successfully");
    } catch (e) {
      console.error("Failed to restore draft:", e);
    }
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
    input.value = dim.type === "angle"
      ? formatAngle(dim.value)
      : formatLength(dim.value, this.doc.displayUnit);
    input.style.left = `${pos.x - 36}px`;
    input.style.top = `${pos.y - 11}px`;

    const commit = () => {
      if (this.dimEditor !== input) return; // already closed (avoid double-commit on blur)
      const v = dim.type === "angle"
        ? parseAngle(input.value)
        : parseLength(input.value, this.doc.displayUnit);
      if (v !== null && v > 0) {
        // If this dimension isn't yet driving, making it driving adds one equation.
        // Reject if the sketch is already fully constrained.
        if (!dim.driving && this.currentDof() < 1) {
          input.style.color = "#e05555";
          setTimeout(() => { input.style.color = ""; }, 600);
          return;
        }
        // Arc length: reject values that exceed the full circumference.
        if (dim.type === "arclength") {
          const geo = ((m) => (id: string) => m.get(id))(
            new Map(this.doc.entities.map((e) => [e.id, e])),
          );
          const ent = geo(dim.entities[0]) as import("./model/entities").ArcEntity | undefined;
          if (ent?.type === "arc" && v >= 2 * Math.PI * ent.radius) {
            input.style.color = "#e05555";
            setTimeout(() => { input.style.color = ""; }, 600);
            return;
          }
        }
        
        const docSnap = this.doc.snapshot();
        const oldVal = dim.value;
        const oldDriving = dim.driving;
        
        dim.value = v;
        dim.driving = true;
        this.runSolve();
        
        if (this.lastSolveResult && !this.lastSolveResult.converged) {
          input.style.color = "#e05555";
          setTimeout(() => { input.style.color = ""; }, 600);
          
          dim.value = oldVal;
          dim.driving = oldDriving;
          this.runSolve();
          return;
        }
        
        this.history.push(docSnap);
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

  private openValueEditor(worldPos: Vec2, placeholder: string, onCommit: (raw: string) => void, onCancel: () => void): void {
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
        this.closeValueEditor();
        onCommit(raw);
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
      this.pushHistory();
      this.doc.removeConstraint(this.doc.selectedConstraintId);
      this.runSolve();
    } else if (this.doc.selectedDimensionId) {
      this.pushHistory();
      this.doc.removeDimension(this.doc.selectedDimensionId);
      this.runSolve();
    } else if (this.doc.selected.length > 0 || this.doc.selectedPoints.length > 0) {
      this.pushHistory();
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
      this.undoRedo(ev.shiftKey ? "redo" : "undo");
      ev.preventDefault();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "y") {
      this.undoRedo("redo");
      ev.preventDefault();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
      this.fileSave();
      ev.preventDefault();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "o") {
      void this.fileOpen();
      ev.preventDefault();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "n") {
      this.fileNew();
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
