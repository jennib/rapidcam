/**
 * Application shell: owns the document, view, tools, and UI, and translates raw
 * DOM input into tool/viewport actions. This is the only place that touches the
 * browser event system — everything below it works in clean model/view terms.
 */

import { CADDocument } from "./model/document";
import { nextId } from "./model/ids";
import { Vec2 } from "./core/vec2";
import { ProjectManager } from "./io/projectManager";
import { Bounds, EntityId } from "./model/entities";
import { Geo } from "./model/constraints";
import { Dimension, dimensionLayout } from "./model/dimensions";
import { Viewport } from "./view/viewport";
import { Renderer } from "./view/renderer";
import { Overlay } from "./view/overlay";
import { SnapEngine, SnapResult } from "./input/snapping";
import { solve, PinMap, computeEntityDofStatus } from "./solver/solver";
import { ToolManager, ToolPointerEvent } from "./tools/tool";
import { TOOL_SHORTCUTS } from "./tools/shortcuts";
import { SelectTool, pickConstraintAt } from "./tools/selectTool";
import { LineTool } from "./tools/lineTool";
import { RectTool } from "./tools/rectTool";
import { CircleTool } from "./tools/circleTool";
import { PolylineTool } from "./tools/polylineTool";
import { DimensionTool } from "./tools/dimensionTool";
import { ArcTool } from "./tools/arcTool";
import { SlotTool } from "./tools/slotTool";
import { PolygonTool } from "./tools/polygonTool";
import { OffsetTool } from "./tools/offsetTool";
import { BezierTool } from "./tools/bezierTool";
import { RotateTool } from "./tools/rotateTool";
import { ScaleTool } from "./tools/scaleTool";
import { TextTool } from "./tools/textTool";
import { FilletTool } from "./tools/filletTool";
import { ChamferTool } from "./tools/chamferTool";
import { TrimTool } from "./tools/trimTool";
import { MirrorTool } from "./tools/mirrorTool";
import { joinSelected } from "./tools/joinCommand";
import { openRectArrayDialog, openCircArrayDialog } from "./ui/arrayDialogs";
import { openLinearPatternDialog, openCircularPatternDialog, regenerateAllStalePatterns } from "./ui/patternDialogs";
import { computeSourceSnapshot } from "./model/patterns";
import { ToolPalette } from "./ui/toolPalette";
import { TopBar } from "./ui/topBar";
import { showMachineSettingsDialog } from "./ui/postSettingsDialog";
import { SettingsBar } from "./ui/settingsBar";
import { PropertiesBar } from "./ui/propertiesBar";
import { StatusBar } from "./ui/statusBar";
import { ConstraintBar } from "./ui/constraintBar";
import { LayersBar } from "./ui/layersBar";
import { CamBar } from "./ui/camBar";
import { DimEditor } from "./ui/dimEditor";
import { VariablesBar } from "./ui/variablesBar";
import { evaluateAll, varMap } from "./model/variables";
import { showWelcomeScreen } from "./ui/welcomeScreen";
import { WebGLPreview } from "./cam/webglPreview";
import { rasterizeStock } from "./cam/stockRasterizer";
import { initBundledFonts } from "./core/fontManager";
import { track } from "./analytics";

const HOVER_TOLERANCE_PX = 8;

export class App {
  private doc: CADDocument;
  private view = new Viewport();
  private renderer: Renderer;
  private snapEngine = new SnapEngine();
  private tools: ToolManager;
  private statusBar: StatusBar;

  private currentSnap: SnapResult["snap"] = null;
  private currentHover: EntityId | null = null;
  private currentHoverConstraint: EntityId | null = null;
  private renderScheduled = false;

  private project: ProjectManager;

  // pan state
  private panning = false;
  private panLast: Vec2 = { x: 0, y: 0 };
  private spaceDown = false;

  private dimEditor = new DimEditor();
  // generic floating value editor (e.g. arc length)
  private valueEditor: HTMLInputElement | null = null;

  private webglPreview: WebGLPreview | null = null;
  private preview3DVisible = false;
  private previewDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private canvas: HTMLCanvasElement, dom: {
    palette: HTMLElement;
    topbar: HTMLElement;
    settingsbar: HTMLElement;
    propertiesbar: HTMLElement;
    cambar: HTMLElement;
    constraintbar: HTMLElement;
    statusbar: HTMLElement;
    layersbar: HTMLElement;
    variablesbar: HTMLElement;
    canvasHost: HTMLElement;
    webglHost: HTMLElement;
    splitDivider: HTMLElement;
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
        // drawing
        new LineTool(),
        new RectTool(),
        new CircleTool(),
        new ArcTool(),
        new SlotTool(),
        new PolylineTool(),
        new PolygonTool(),
        new BezierTool(),
        new TextTool(),
        // dimension
        new DimensionTool(),
        // modify
        new OffsetTool(),
        new FilletTool(),
        new ChamferTool(),
        new TrimTool(),
        new MirrorTool(),
        new RotateTool(),
        new ScaleTool(),
      ],
      "select",
    );

    this.tools.onActiveChange(() => {
      canvas.style.cursor = this.tools.active.id === "select" ? "default" : "crosshair";
      track("tool_activated", { tool: this.tools.active.id });
    });
    canvas.style.cursor = this.tools.active.id === "select" ? "default" : "crosshair";

    new ToolPalette(dom.palette, this.tools);
    new TopBar(dom.topbar, this.doc, {
      onUndo: () => this.project.undoRedo("undo"),
      onRedo: () => this.project.undoRedo("redo"),
      canUndo: () => this.project.history.canUndo,
      canRedo: () => this.project.history.canRedo,
      onSettings: () => showMachineSettingsDialog({
        doc: this.doc,
        pushHistory: this.project.pushHistory,
      }),
      file: {
        onNew: () => this.project.fileNew(),
        onOpen: () => this.project.fileOpen(),
        onSave: () => this.project.fileSave(),
        onOpenRecent: (e) => this.project.fileOpenRecent(e),
        onOpenExample: (e) => this.project.loadExample(e),
        onImportSvg: () => this.project.svgImport(),
        onExportSvg: () => this.project.svgExport(),
      },
      edit: {
        onDelete: () => this.deleteSelected(),
        onJoin: () => this.joinSelectedEntities(),
        onLinearPattern:      () => openLinearPatternDialog(this.doc, this.project.pushHistory),
        onCircularPattern:    () => openCircularPatternDialog(this.doc, this.project.pushHistory),
        onRegeneratePatterns: () => this.doRegeneratePatterns(),
        onRectArray: () => openRectArrayDialog(this.doc, this.project.pushHistory),
        onCircArray: () => openCircArrayDialog(this.doc, this.project.pushHistory),
      },
      view: {
        onFit: () => this.fitView(),
        onToggle3D: () => this.toggle3DPreview(dom.canvasHost, dom.webglHost, dom.splitDivider),
        is3DVisible: () => this.preview3DVisible,
        onToggleDimensions: () => {
          this.renderer.showDimensions = !this.renderer.showDimensions;
          this.requestRender();
        },
        areDimensionsVisible: () => this.renderer.showDimensions,
      },
    });
    new LayersBar(dom.layersbar, this.doc, this.project.pushHistory);
    new SettingsBar(dom.settingsbar, this.doc, this.project.pushHistory);
    new PropertiesBar(
      dom.propertiesbar,
      this.doc,
      this.project.pushHistory,
      () => this.runSolve(),
      () => this.toggleConstruction(),
    );
    this.statusBar = new StatusBar(dom.statusbar, this.doc, this.snapEngine, this.requestRender);
    new ConstraintBar(
      dom.constraintbar,
      this.doc,
      () => { this.runSolve(); return this.lastSolveResult; },
      this.project.pushHistory,
      () => this.project.undoRedo("undo")
    );
    new CamBar(dom.cambar, this.doc, this.project.pushHistory);
    new VariablesBar(dom.variablesbar, this.doc, () => this.runSolve(), this.project.pushHistory);

    this.doc.onChange(this.requestRender);
    this.doc.onChange(() => this.schedulePreviewUpdate());

    this.bindSplitDivider(dom.canvasHost, dom.splitDivider);
    this.bindEvents();
    this.handleResize();
    this.initialFit();

    // Load bundled fonts in the background; re-render when they arrive
    void initBundledFonts(() => this.requestRender());

    // Show welcome screen on startup for a fresh empty project
    showWelcomeScreen(
      () => this.project.openSetupDialog(),
      () => { void this.project.fileOpen(); },
      (entry) => this.project.fileOpenRecent(entry),
      () => this.project.restoreDraft(),
      (entry) => this.project.loadExample(entry)
    );
  }

  private toggle3DPreview(
    canvasHost: HTMLElement,
    webglHost: HTMLElement,
    divider: HTMLElement,
  ): void {
    this.preview3DVisible = !this.preview3DVisible;

    if (this.preview3DVisible) {
      webglHost.classList.remove("hidden");
      divider.classList.remove("hidden");
      // Default 55/45 split — set canvas-host to a fixed pixel width
      const totalW = canvasHost.parentElement!.clientWidth;
      canvasHost.style.flex = "none";
      canvasHost.style.width = Math.round(totalW * 0.55) + "px";

      if (!this.webglPreview) {
        this.webglPreview = new WebGLPreview(webglHost);
      }
      this.schedulePreviewUpdate();
    } else {
      webglHost.classList.add("hidden");
      divider.classList.add("hidden");
      canvasHost.style.flex = "";
      canvasHost.style.width = "";
    }
  }

  private schedulePreviewUpdate(): void {
    if (!this.preview3DVisible || !this.webglPreview) return;
    if (this.previewDebounceTimer !== null) clearTimeout(this.previewDebounceTimer);
    this.previewDebounceTimer = setTimeout(() => {
      this.previewDebounceTimer = null;
      if (this.webglPreview && this.preview3DVisible) {
        this.webglPreview.render(rasterizeStock(this.doc.operations, this.doc));
      }
    }, 250);
  }

  private bindSplitDivider(canvasHost: HTMLElement, divider: HTMLElement): void {
    let dragging = false;
    let startX = 0;
    let startW = 0;

    divider.addEventListener("mousedown", (e) => {
      dragging = true;
      startX = e.clientX;
      startW = canvasHost.offsetWidth;
      divider.classList.add("dragging");
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const newW = Math.max(200, startW + (e.clientX - startX));
      canvasHost.style.width = newW + "px";
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      divider.classList.remove("dragging");
    });
  }

  private toggleConstruction(): void {
    const selected = this.doc.selected;
    if (selected.length > 0) {
      const allAreConstruction = selected.every((e) => e.isConstruction);
      this.project.pushHistory();
      for (const e of selected) e.isConstruction = !allAreConstruction;
      this.doc.isConstructionMode = !allAreConstruction;
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
  private stalePatternIds: Set<string> = new Set();

  private currentDof(): number {
    if (!this.lastSolveResult) return Infinity;
    return this.lastSolveResult.variables - this.lastSolveResult.equations;
  }

  private runSolve(pins?: PinMap): void {
    evaluateAll(this.doc.variables, this.doc.dimensions, this.doc.displayUnit);
    const res = solve(this.doc, pins);
    if (!pins) {
      this.lastSolveResult = res;
      this.renderer.entityStatus = computeEntityDofStatus(this.doc, res);
      this.updatePatternStaleness();
    }
    this.statusBar.setSolveStatus(res.hasConstraints ? res : null);
    this.requestRender();
  }

  private updatePatternStaleness(): void {
    const stale = new Set<string>();
    for (const pat of this.doc.patterns) {
      if (pat.sourceSnapshot === undefined) continue;
      if (computeSourceSnapshot(this.doc.entities, pat.sourceIds) !== pat.sourceSnapshot) {
        stale.add(pat.id);
      }
    }
    this.stalePatternIds = stale;

    const staleInstanceIds = new Set<string>();
    for (const pat of this.doc.patterns) {
      if (stale.has(pat.id)) {
        for (const inst of pat.instanceIds) for (const id of inst) staleInstanceIds.add(id);
      }
    }
    this.renderer.stalePatternEntityIds = staleInstanceIds;
    this.statusBar.setPatternStatus(stale.size);
  }

  private doRegeneratePatterns(): void {
    if (this.stalePatternIds.size === 0) return;
    this.project.pushHistory();
    regenerateAllStalePatterns(this.doc, this.stalePatternIds);
    this.runSolve();
    this.doc.emitChange();
  }

  private render(): void {
    const to = this.tools.overlay();
    const overlay: Overlay = {
      previews: to.previews,
      selectionRect: to.selectionRect,
      snap: this.currentSnap,
      hover: this.currentHover,
      hoverConstraint: this.currentHoverConstraint,
      transformBox: to.transformBox,
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

  /** Initial view for a new empty document: origin near lower-left with work area visible above. */
  private initialFit(): void {
    const w = this.view.width;
    const h = this.view.height;
    if (w === 0 || h === 0) { this.fitView(); return; }
    const workW = this.doc.canvas.width;
    const workH = this.doc.canvas.height;
    // Scale so the work area fills ~65% of the viewport in the tighter dimension.
    const scale = Math.min((w * 0.65) / workW, (h * 0.60) / workH);
    this.view.scale = Math.max(0.02, Math.min(400, scale));
    // Place origin at 28% from left, 68% from top — comfortable lower-left anchor.
    this.view.tx = w * 0.28;
    this.view.ty = h * 0.68;
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
    if (ev.button === 0 && this.doc.regionPickHandler) {
      if (this.doc.regionPickHandler(this.view.screenToWorld(screen))) {
        this.requestRender();
        return;
      }
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
    if (this.doc.regionHoverHandler) this.doc.regionHoverHandler(e.worldRaw);
    this.currentHover =
      (this.tools.active.id === "select" || this.tools.active.id === "offset")
        ? (this.doc.hitTest(e.worldRaw, this.view.toWorldLen(HOVER_TOLERANCE_PX))?.id ?? null)
        : null;
        
    this.currentHoverConstraint = this.tools.active.id === "select"
      ? (pickConstraintAt(this.doc, this.view, e.screen)?.id ?? null)
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
      vars: varMap(this.doc.variables),
      onCommit: (v, expr) => this.commitDimValue(dim, v, expr),
    });
  }

  private commitDimValue(dim: Dimension, v: number, expr?: string): boolean {
    // Arc-length cannot exceed full circumference.
    if (dim.type === "arclength") {
      const byId = new Map(this.doc.entities.map((e) => [e.id, e]));
      const ent = byId.get(dim.entities[0]) as import("./model/entities").ArcEntity | undefined;
      if (ent?.type === "arc" && v >= 2 * Math.PI * ent.radius) return false;
    }

    const docSnap = this.doc.snapshot();
    const oldVal = dim.value;
    const oldExpr = dim.expr;
    const oldDriving = dim.driving;

    dim.value = v;
    dim.expr = expr;
    dim.driving = true;
    this.runSolve();

    if (this.lastSolveResult && !this.lastSolveResult.converged) {
      dim.value = oldVal;
      dim.expr = oldExpr;
      dim.driving = oldDriving;
      this.runSolve();
      return false;
    }

    this.project.pushHistory(docSnap);
    return true;
  }



  private openValueEditor(worldPos: Vec2, placeholder: string, onCommit: (raw: string) => boolean | void, onCancel: () => void, onTab?: () => void): void {
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
      } else if (e.key === "Tab" && onTab) {
        e.preventDefault();
        onTab();
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

  private joinSelectedEntities(): void {
    if (this.doc.selected.length < 2) return;
    this.project.pushHistory();
    if (!joinSelected(this.doc)) this.project.undoRedo("undo");
    else this.runSolve();
  }

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
    
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "j") {
      this.joinSelectedEntities();
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
          const group = {
            id: nextId("grp"),
            name: "",
            entityIds: this.doc.selected.map(e => e.id)
          };
          this.doc.groups.push(group);
          this.doc.emitChange();
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

    if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key === "P") {
      ev.preventDefault();
      this.doRegeneratePatterns();
      return;
    }

    const toolId = TOOL_SHORTCUTS[ev.key.toLowerCase()];
    if (toolId && !ev.ctrlKey && !ev.metaKey && !ev.defaultPrevented) {
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
