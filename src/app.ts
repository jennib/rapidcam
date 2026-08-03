/**
 * Application shell: owns the document, view, tools, and UI, and translates raw
 * DOM input into tool/viewport actions. This is the only place that touches the
 * browser event system — everything below it works in clean model/view terms.
 */

import { track } from "./analytics";
import { getPostFor } from "./core/prefs";
import { buildSideA, buildSideB, opFace } from "./cam/flip";
import { defaultRotarySettings } from "./cam/klein";
import { laserPreviewPaths } from "./cam/lasergcode";
import { rasterizeStock } from "./cam/stockRasterizer";
import { type CAMOperation, getAssociatedOperations } from "./cam/types";
import { WebGLPreview } from "./cam/webglPreview";
import { initBundledFonts } from "./core/fontManager";
import { placePasteClones, PASTE_OFFSET_MM } from "./core/paste";
import { dist, type Vec2 } from "./core/vec2";
import { SnapEngine, type SnapResult } from "./input/snapping";
import { ProjectManager } from "./io/projectManager";
import { consumeSharedDesign } from "./io/shareLink";
import type { Geo } from "./model/constraints";
import { type Dimension, dimensionLayout, dimensionHitDistance } from "./model/dimensions";
import { CADDocument, ORIGIN_ENTITY_ID, STOCK_ENTITY_ID, stockRefEntity } from "./model/document";
import type { Bounds, Entity, EntityId } from "./model/entities";
import { nextId } from "./model/ids";
import { regenerateAllStalePatterns, regenerateStalePatterns } from "./model/patternEngine";
import { computeSourceSnapshot } from "./model/patterns";
import { evaluateAll, varMap } from "./model/variables";
import {
  computeEntityDofStatus,
  constraintJacobianRankChange,
  type PinMap,
  solve,
} from "./solver/solver";
import { ArcTool } from "./tools/arcTool";
import { BezierTool } from "./tools/bezierTool";
import { type CenterAxis, canCenter, planCenter } from "./tools/centerCommand";
import { ChamferTool } from "./tools/chamferTool";
import { CircleTool } from "./tools/circleTool";
import { DimensionTool } from "./tools/dimensionTool";
import { explodeSelected } from "./tools/explodeCommand";
import { ExtendTool } from "./tools/extendTool";
import { FilletTool } from "./tools/filletTool";
import { joinSelected } from "./tools/joinCommand";
import { LineTool } from "./tools/lineTool";
import { MeasureTool } from "./tools/measureTool";
import { MirrorTool } from "./tools/mirrorTool";
import { OffsetTool } from "./tools/offsetTool";
import { PolygonTool } from "./tools/polygonTool";
import { PolylineTool } from "./tools/polylineTool";
import { RectTool } from "./tools/rectTool";
import { RotateTool } from "./tools/rotateTool";
import { ScaleTool } from "./tools/scaleTool";
import {
  computeTransformBox,
  meanDeviation,
  pickConstraintAt,
  SelectTool,
  selectionSnapPositions,
} from "./tools/selectTool";
import { TOOL_HINTS, TOOL_SHORTCUTS } from "./tools/shortcuts";
import { SlotTool } from "./tools/slotTool";
import { TextTool } from "./tools/textTool";
import { ToolManager, type ToolPointerEvent } from "./tools/tool";
import { TrimTool } from "./tools/trimTool";
import { AlignBar } from "./ui/alignBar";
import { openCircArrayDialog, openRectArrayDialog } from "./ui/arrayDialogs";
import { GENERATORS, findFeatureForEntities, regenerateStaleFeatures } from "./generators/index";
import { openGeneratorDialog } from "./ui/generatorDialog";
import { CamBar } from "./ui/camBar";
import { ConstraintBar } from "./ui/constraintBar";
import { ContextMenu, type ContextMenuEntry } from "./ui/contextMenu";
import { DesignTreePanel } from "./ui/designTree";
import { DimEditor } from "./ui/dimEditor";
import { LayersBar } from "./ui/layersBar";
import { closeAllModals, confirmDialog, isModalOpen } from "./ui/modal";
import { openCircularPatternDialog, openLinearPatternDialog } from "./ui/patternDialogs";
import { showMachineSettingsDialog } from "./ui/postSettingsDialog";
import { PropertiesBar } from "./ui/propertiesBar";
import { SettingsBar } from "./ui/settingsBar";
import { showShortcutOverlay } from "./ui/shortcutOverlay";
import { StatusBar } from "./ui/statusBar";
import { toast } from "./ui/toast";
import { ToolPalette } from "./ui/toolPalette";
import { TopBar } from "./ui/topBar";
import { VariablesBar } from "./ui/variablesBar";
import { showWelcomeScreen } from "./ui/welcomeScreen";
import type {
  DiagnosticMarker,
  FlipPreview,
  Overlay,
  PreviewShape,
  StitchPreview,
} from "./view/overlay";
import { Renderer } from "./view/renderer";
import { Viewport } from "./view/viewport";

const HOVER_TOLERANCE_PX = 8;

/** Directional resize cursors for the transform-box scale handles. */
const RESIZE_CURSORS: Record<string, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
};

/** Circular-arrow cursor for the rotate handle (CSS has no native one). White
 *  under-stroke keeps it legible on the dark canvas; crosshair is the fallback. */
const ROTATE_CURSOR =
  `url("data:image/svg+xml,` +
  `%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'%3E` +
  `%3Cpath d='M4.7 6.5A5 5 0 1 1 4.7 11.5' fill='none' stroke='%23fff' stroke-width='4'/%3E` +
  `%3Cpolygon points='6.2,10.5 1.4,10.2 4.9,15.2' fill='%23fff'/%3E` +
  `%3Cpath d='M4.7 6.5A5 5 0 1 1 4.7 11.5' fill='none' stroke='%23000' stroke-width='2'/%3E` +
  `%3Cpolygon points='5.6,11 2.6,10.8 4.8,13.9' fill='%23000'/%3E` +
  `%3C/svg%3E") 9 9, crosshair`;

export class App {
  private doc: CADDocument;
  private view = new Viewport();
  private renderer: Renderer;
  private snapEngine = new SnapEngine();
  private tools: ToolManager;
  private statusBar: StatusBar;
  private designTree: DesignTreePanel;
  private contextMenu = new ContextMenu();

  private currentSnap: SnapResult["snap"] = null;
  private currentHover: EntityId | null = null;
  private currentHoverConstraint: EntityId | null = null;
  private currentHoverDimension: string | null = null;
  /** Babel diagnose-mode markers over located DXF-import problems, if any. */
  private dxfDiagnostics: DiagnosticMarker[] | null = null;
  /** Stitch tiled-milling preview (tile grid + registration features), if any. */
  private stitchPreview: StitchPreview | null = null;
  /** Ghost of the generator dialog's pending output (flipPreview idiom). */
  private generatorPreview: PreviewShape[] | null = null;
  private readonly generatorPreviewSink = (s: PreviewShape[] | null): void => {
    this.generatorPreview = s;
    this.requestRender();
  };
  /** Flip (double-sided) preview (flip axis + registration pins), if any. */
  private flipPreview: FlipPreview | null = null;
  private renderScheduled = false;

  /** In-app clipboard: detached entity clones plus the group structure among
   *  them (index lists into `clipboard`). Constraints/dimensions don't travel —
   *  copies come in unconstrained, like pattern instances. */
  private clipboard: Entity[] = [];
  private clipboardGroups: number[][] = [];
  /** How many times the current clipboard has been plain-pasted, so repeat
   *  pastes cascade (offset grows) instead of stacking. Reset on copy/cut. */
  private pasteCount = 0;

  /** Last pointer position on the canvas (CSS px), for cursor feedback. */
  private lastScreen: Vec2 | null = null;
  /** True between pointerdown and pointerup on the canvas. */
  private pointerActive = false;
  /** The affordance cursor computed at press time, held for the whole drag so
   *  a scale/rotate drag keeps its cursor even as the pointer leaves the handle. */
  private pressCursor: string | null = null;

  /** Public for the `window.__app` dev hook (CDP verification, CLI render). */
  readonly project: ProjectManager;

  // pan state
  private panning = false;
  private panLast: Vec2 = { x: 0, y: 0 };
  private spaceDown = false;

  private dimEditor = new DimEditor();
  private valueEditor: HTMLElement | null = null;

  private webglPreview: WebGLPreview | null = null;
  private preview3DVisible = false;
  /** Which face the 3D preview carves for a double-sided (flip) job. */
  private preview3DSide: "A" | "B" = "A";
  /** The A/B side-toggle overlay in the 3D pane (double-sided jobs only). */
  private sideToggle: HTMLElement | null = null;
  /** Flat laser-path preview (the laser machine's analogue of the 3D preview). */
  private laserPreviewVisible = false;
  private previewDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private laserPreviewTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    dom: {
      palette: HTMLElement;
      designtree: HTMLElement;
      topbar: HTMLElement;
      settingsbar: HTMLElement;
      propertiesbar: HTMLElement;
      cambar: HTMLElement;
      constraintbar: HTMLElement;
      alignbar: HTMLElement;
      statusbar: HTMLElement;
      layersbar: HTMLElement;
      variablesbar: HTMLElement;
      canvasHost: HTMLElement;
      webglHost: HTMLElement;
      splitDivider: HTMLElement;
    },
  ) {
    this.doc = new CADDocument({ width: 200, height: 150 }, "mm");
    this.renderer = new Renderer(canvas);

    this.project = new ProjectManager(this.doc, {
      onDocumentChange: () => this.requestRender(),
      onSolve: () => this.runSolve(),
      onFitView: () => this.fitView(),
      onCloseEditors: () => {
        this.dimEditor.close();
        this.closeValueEditor();
        // A document swap (New Project / open / draft restore) must not leave a
        // dialog open over the new document — it would act on geometry that's gone.
        closeAllModals();
      },
      onDiagnostics: (diags) => {
        this.dxfDiagnostics = diags?.length
          ? diags.map((d) => ({ pos: d.pos, kind: d.kind }))
          : null;
        this.requestRender();
      },
    });

    this.tools = new ToolManager(
      {
        doc: this.doc,
        view: this.view,
        requestRender: this.requestRender,
        snap: this.snapEngine,
        solve: (pins) => this.runSolve(pins),
        pushHistory: this.project.pushHistory,
        openDimEditor: (dim) => setTimeout(() => this.openDimEditor(dim), 0),
        openValueEditor: (worldPos, placeholder, onCommit, onCancel, onTab) => {
          setTimeout(() => this.openValueEditor(worldPos, placeholder, onCommit, onCancel, onTab), 0);
        },
        openMultiValueEditor: (worldPos, fields, onCommit, onCancel, onChange) => {
          setTimeout(() => this.openMultiValueEditor(worldPos, fields, onCommit, onCancel, onChange), 0);
        },
        closeValueEditor: () => this.closeValueEditor(),
        currentDof: () => this.currentDof(),
        notify: (msg) => this.statusBar.flash(msg),
        setHint: (text) => this.statusBar.setHint(text ?? TOOL_HINTS[this.tools.active.id] ?? ""),
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
        new MeasureTool(),
        // modify
        new OffsetTool(),
        new FilletTool(),
        new ChamferTool(),
        new TrimTool(),
        new ExtendTool(),
        new MirrorTool(),
        new RotateTool(),
        new ScaleTool(),
      ],
      "select",
    );

    this.tools.onActiveChange(() => {
      this.updateCursor();
      this.statusBar.setHint(TOOL_HINTS[this.tools.active.id] ?? "");
      track("tool_activated", { tool: this.tools.active.id });
    });
    this.updateCursor();

    this.designTree = new DesignTreePanel({
      container: dom.designtree,
      doc: this.doc,
      onHoverEntity: (id) => this.setTreeHover({ entity: id }),
      onHoverDimension: (id) => this.setTreeHover({ dimension: id }),
      onHoverConstraint: (id) => this.setTreeHover({ constraint: id }),
      pushHistory: this.project.pushHistory,
      onSolve: () => this.runSolve(),
    });
    new ToolPalette(dom.palette, this.tools, () => this.designTree.toggle());
    new TopBar(dom.topbar, this.doc, {
      onUndo: () => this.project.undoRedo("undo"),
      onRedo: () => this.project.undoRedo("redo"),
      canUndo: () => this.project.history.canUndo,
      canRedo: () => this.project.history.canRedo,
      onSettings: () =>
        showMachineSettingsDialog({
          doc: this.doc,
          pushHistory: this.project.pushHistory,
        }),
      file: {
        onNew: () => this.project.fileNew(),
        onStartScreen: () => this.openStartScreen(true),
        onOpen: () => this.project.fileOpen(),
        onSave: () => this.project.fileSave(),
        onShareLink: () => {
          void this.project.copyShareLink();
        },
        onOpenRecent: (e) => this.project.fileOpenRecent(e),
        onOpenExample: (e) => this.project.loadExample(e),
        onAiAssistant: async () => {
          // Lazy-loaded so the AI assistant (and its deps) code-split out of the
          // initial bundle — it's a click-to-open, rarely-first feature.
          const { showAiAssistantDialog } = await import("./ui/aiAssistantDialog");
          showAiAssistantDialog(this.doc, this.project.currentFileName, {
            onImport: (file, name) => this.project.importChecked(file, name),
          });
        },
        onImportSvg: () => this.project.svgImport(),
        onImportDxf: () => this.project.dxfImport(),
        onExportDxf: () => this.project.dxfExport(),
        onImportImage: () => this.project.imageImport(),
        onExportSvg: () => this.project.svgExport(),
      },
      edit: {
        onCopy: () => this.copySelected(),
        onCut: () => this.cutSelected(),
        onPaste: () => this.paste(),
        onDuplicate: () => this.duplicateSelected(),
        onSelectAll: () => this.selectAll(),
        onDelete: () => this.deleteSelected(),
        onJoin: () => this.joinSelectedEntities(),
        onExplode: () => this.explodeSelectedEntities(),
        onLinearPattern: () => openLinearPatternDialog(this.doc, this.project.pushHistory),
        onCircularPattern: () => openCircularPatternDialog(this.doc, this.project.pushHistory),
        onRegeneratePatterns: () => this.doRegeneratePatterns(),
        onRectArray: () => openRectArrayDialog(this.doc, this.project.pushHistory),
        onCircArray: () => openCircArrayDialog(this.doc, this.project.pushHistory),
        onEditFeature: () => {
          const feat = findFeatureForEntities(
            this.doc,
            this.doc.selected.map((e) => e.id),
          );
          if (!feat) {
            toast("Select a generated feature to edit.");
            return;
          }
          openGeneratorDialog({
            doc: this.doc,
            pushHistory: this.project.pushHistory,
            gen: GENERATORS[feat.generatorId],
            editFeatureId: feat.id,
            onPreview: this.generatorPreviewSink,
          });
        },
      },
      insert: {
        generators: Object.values(GENERATORS).map((g) => ({ id: g.id, name: g.name })),
        onInsertGenerator: (id) =>
          openGeneratorDialog({
            doc: this.doc,
            pushHistory: this.project.pushHistory,
            gen: GENERATORS[id],
            onInserted: () => this.fitView(),
            onPreview: this.generatorPreviewSink,
          }),
      },
      view: {
        onFit: () => this.fitView(),
        onToggle3D: () => this.toggle3DPreview(dom.canvasHost, dom.webglHost, dom.splitDivider),
        is3DVisible: () => this.preview3DVisible || this.laserPreviewVisible,
        previewLabel: () => (this.doc.isLaser ? "Laser Preview" : "3D Preview"),
        onToggleDimensions: () => {
          this.renderer.showDimensions = !this.renderer.showDimensions;
          this.requestRender();
        },
        areDimensionsVisible: () => this.renderer.showDimensions,
        onToggleRotaryWrap: () => {
          this.renderer.showRotaryWrap = !this.renderer.showRotaryWrap;
          this.requestRender();
        },
        isRotaryWrapVisible: () => this.renderer.showRotaryWrap,
        isRotaryDoc: () => this.doc.isRotary,
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
      (dim, v, expr) => this.commitDimValue(dim, v, expr),
      this.generatorPreviewSink,
    );
    this.statusBar = new StatusBar(dom.statusbar, this.doc, this.snapEngine, this.requestRender);
    this.statusBar.setHint(TOOL_HINTS[this.tools.active.id] ?? "");
    new ConstraintBar(
      dom.constraintbar,
      this.doc,
      () => {
        this.runSolve();
        return this.lastSolveResult;
      },
      this.project.pushHistory,
      () => this.project.undoRedo("undo"),
    );
    new AlignBar(dom.alignbar, this.doc, (axis) => this.centerSelection(axis));
    new CamBar(
      dom.cambar,
      this.doc,
      this.project.pushHistory,
      (p) => {
        this.stitchPreview = p;
        this.requestRender();
      },
      (p) => {
        this.flipPreview = p;
        this.requestRender();
      },
      () => this.project.currentFileName,
    );
    new VariablesBar(
      dom.variablesbar,
      this.doc,
      () => this.onVariablesChanged(),
      this.project.pushHistory,
    );

    this.doc.onChange(this.requestRender);
    this.doc.onChange(() => this.schedulePreviewUpdate());

    this.bindSplitDivider(dom.canvasHost, dom.splitDivider);
    this.bindEvents();
    this.handleResize();
    this.initialFit();

    document.getElementById("floating-3d-btn")?.addEventListener("click", () => {
      this.toggle3DPreview(dom.canvasHost, dom.webglHost, dom.splitDivider);
    });
    document.getElementById("floating-3d-close-btn")?.addEventListener("click", () => {
      this.toggle3DPreview(dom.canvasHost, dom.webglHost, dom.splitDivider);
    });

    // Load bundled fonts in the background; re-SOLVE when they arrive. A text
    // entity's centre/box points derive from real ink extents, so any centring or
    // dimension constraint solved against the pre-load 0.6-em estimate must be
    // re-solved once the font lands (runSolve ends with a render). Bundled fonts
    // aren't embedded in .rcam files, so this is the common open-a-file path.
    void initBundledFonts(() => this.runSolve());

    // A shared-design link (#d=…) takes over startup; otherwise show the welcome
    // screen for a fresh empty project.
    void this.openInitialContent();
  }

  private async openInitialContent(): Promise<void> {
    const shared = await consumeSharedDesign();
    if (shared) {
      track("design_link_opened");
      this.project.loadDocument(shared.file, shared.name);
      return;
    }
    this.openStartScreen();
  }

  /** Show the start screen (welcome splash). At launch it is a STRICT modal —
   *  nothing exists behind it, the user must pick an option. Reopened from
   *  File → Start Screen it is dismissable (Escape / click outside the card):
   *  every card replaces the current document, so peeking at the examples must
   *  not strand the user away from their work. */
  private openStartScreen(dismissable = false): void {
    showWelcomeScreen(
      // fileNew (not openSetupDialog) so a mid-session "New Project" from the
      // reopened splash still confirms before discarding real work; at launch the
      // doc is empty so the confirm is skipped — same as before.
      () => this.project.fileNew(),
      () => {
        void this.project.fileOpen();
      },
      (entry) => this.project.fileOpenRecent(entry),
      () => this.project.restoreDraft(),
      (entry) => this.project.loadExample(entry),
      { dismissable },
    );
  }

  private toggle3DPreview(
    canvasHost: HTMLElement,
    webglHost: HTMLElement,
    divider: HTMLElement,
  ): void {
    this.preview3DVisible = !this.preview3DVisible;

    // For laser machines, keep the flat cut-path overlay on the 2D canvas synced
    // with the 3D preview state.
    if (this.doc.isLaser) {
      this.laserPreviewVisible = this.preview3DVisible;
      if (this.laserPreviewVisible)
        this.computeLaserPreview(); // instant on toggle
      else this.renderer.laserPreview = null;
      this.requestRender();
    }

    if (this.preview3DVisible) {
      webglHost.classList.remove("hidden");
      divider.classList.remove("hidden");
      // Default 55/45 split — set canvas-host to a fixed pixel width
      const totalW = canvasHost.parentElement!.clientWidth;
      canvasHost.style.flex = "none";
      canvasHost.style.width = `${Math.round(totalW * 0.55)}px`;

      if (!this.webglPreview) {
        this.webglPreview = new WebGLPreview(webglHost);
      }
      this.ensureSideToggle(webglHost);
      this.updateSideToggle();
      this.schedulePreviewUpdate();
      document.getElementById("floating-3d-btn")?.classList.add("hidden");
    } else {
      webglHost.classList.add("hidden");
      divider.classList.add("hidden");
      canvasHost.style.flex = "";
      canvasHost.style.width = "";
      this.updateSideToggle();
      document.getElementById("floating-3d-btn")?.classList.remove("hidden");
    }
  }

  /** Lazily create the A/B side-toggle overlay in the 3D pane. */
  private ensureSideToggle(webglHost: HTMLElement): void {
    if (this.sideToggle) return;
    const wrap = document.createElement("div");
    wrap.className = "webgl-side-toggle";
    const mk = (label: string, side: "A" | "B"): HTMLButtonElement => {
      const b = document.createElement("button");
      b.textContent = label;
      b.dataset.side = side;
      b.title =
        side === "A"
          ? "Top face (cut as drawn, with pin holes)"
          : "Bottom face (flipped and mirrored)";
      b.addEventListener("click", () => {
        this.preview3DSide = side;
        this.updateSideToggle();
        this.schedulePreviewUpdate();
      });
      return b;
    };
    wrap.append(mk("Side A", "A"), mk("Side B", "B"));
    webglHost.appendChild(wrap);
    this.sideToggle = wrap;
  }

  /** Show the toggle only for a double-sided job with bottom ops; sync its active state. */
  private updateSideToggle(): void {
    if (!this.sideToggle) return;
    const twoSided = !!this.doc.flip && this.doc.operations.some((op) => opFace(op) === "bottom");
    const show = this.preview3DVisible && twoSided;
    if (!twoSided) this.preview3DSide = "A"; // don't strand the preview on a side that no longer exists
    this.sideToggle.style.display = show ? "flex" : "none";
    for (const b of Array.from(this.sideToggle.children) as HTMLElement[]) {
      b.classList.toggle("active", b.dataset.side === this.preview3DSide);
    }
  }

  /**
   * The (ops, document) the 3D preview should carve, honouring the flip side.
   * Builds ONLY the requested side (each build clones the document), so a
   * two-sided preview doesn't pay to construct the face it isn't showing.
   */
  private previewInput(): { ops: CAMOperation[]; doc: CADDocument } {
    const twoSided = !!this.doc.flip && this.doc.operations.some((op) => opFace(op) === "bottom");
    if (!twoSided) return { ops: this.doc.operations, doc: this.doc };
    if (this.preview3DSide === "B") {
      const sideB = buildSideB(this.doc);
      if (sideB) return sideB;
    }
    return buildSideA(this.doc);
  }

  /** Recompute the flat laser overlay now (cut-path geometry → renderer). */
  private computeLaserPreview(): void {
    if (!this.laserPreviewVisible) return;
    this.renderer.laserPreview = laserPreviewPaths(this.doc.operations, this.doc, getPostFor("laser"));
    this.requestRender();
  }

  private schedulePreviewUpdate(): void {
    if (this.laserPreviewVisible && !this.doc.isLaser) {
      this.laserPreviewVisible = false;
      this.renderer.laserPreview = null;
    }
    // Flat laser preview: debounce the recompute. A large area-fill is thousands
    // of scan segments; recomputing synchronously on every doc change (drag,
    // keystroke) would stutter, so coalesce bursts like the 3D preview does.
    if (this.laserPreviewVisible) {
      if (this.laserPreviewTimer !== null) clearTimeout(this.laserPreviewTimer);
      this.laserPreviewTimer = setTimeout(() => {
        this.laserPreviewTimer = null;
        this.computeLaserPreview();
      }, 200);
    }
    if (!this.preview3DVisible || !this.webglPreview) return;
    this.updateSideToggle(); // a face change / op edit may have added or removed a bottom side
    if (this.previewDebounceTimer !== null) clearTimeout(this.previewDebounceTimer);
    this.previewDebounceTimer = setTimeout(() => {
      this.previewDebounceTimer = null;
      if (this.webglPreview && this.preview3DVisible) {
        const { ops, doc } = this.previewInput();
        // For a rotary job, wrap the preview onto the cylinder (diameter from the
        // per-job rotary settings, or the stock-derived default before one is set).
        const rotary = doc.isRotary
          ? (() => {
              const s = doc.rotary ?? defaultRotarySettings(doc);
              return { diameter: s.diameter, wrapAxis: s.wrapAxis };
            })()
          : null;
        this.webglPreview.render(rasterizeStock(ops, doc), rotary, ops.length > 0);
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
      canvasHost.style.width = `${newW}px`;
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      divider.classList.remove("dragging");
    });
  }

  /**
   * With a selection: toggles THOSE entities' own `isConstruction` — a
   * property of the selected geometry, nothing else. With nothing selected:
   * toggles `doc.isConstructionMode`, the mode that decides what NEW shapes
   * get drawn as. These used to be coupled (selecting a shape and marking it
   * construction also silently armed construction mode for whatever you drew
   * next) — surprising, and not what either action asked for.
   */
  private toggleConstruction(): void {
    const selected = this.doc.selected;
    this.project.pushHistory();
    if (selected.length > 0) {
      const allAreConstruction = selected.every((e) => e.isConstruction);
      for (const e of selected) e.isConstruction = !allAreConstruction;
    } else {
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

  private autoRegenerating = false;

  /**
   * A variable was committed (name/value/delete). Re-evaluate variables and
   * solve so any variable-driven dimensions move their geometry into place, then
   * regenerate any pattern OR generator feature that became stale — whether its
   * count/spacing/param expression changed or (for patterns) its source moved —
   * and solve again to refresh. All inside the history transaction the
   * VariablesBar already opened, so one undo reverts the edit and the regen
   * together. The guard keeps a regen's emitChange from recursing back in.
   */
  private onVariablesChanged(): void {
    this.runSolve(); // re-evaluates variables/dimensions and settles geometry
    if (this.autoRegenerating) return;
    this.autoRegenerating = true;
    try {
      const p = regenerateStalePatterns(this.doc);
      const f = regenerateStaleFeatures(this.doc);
      if (p || f) this.runSolve();
    } finally {
      this.autoRegenerating = false;
    }
    this.doc.emitChange();
  }

  private runSolve(pins?: PinMap): void {
    evaluateAll(this.doc.variables, this.doc.dimensions, this.doc.displayUnit, this.doc.stockThickness);
    const res = solve(this.doc, pins);
    if (!pins) {
      this.lastSolveResult = res;
      this.renderer.entityStatus = computeEntityDofStatus(this.doc, res);
      this.updatePatternStaleness();
    }
    // Always report definedness (solveStatusLabel blanks an empty canvas): a
    // fresh, unconstrained sketch reads "under-constrained" and draws blue, per
    // the SolidWorks model — the status bar must agree with the geometry colour.
    // Pass whether anything is ACTUALLY drawn under-defined so a feature-only
    // sketch (controlled geometry, free solver DOF but not loose) reads
    // "Fully constrained" instead of contradicting its own layer-coloured parts.
    const anyUnderDefined = [...this.renderer.entityStatus.values()].some(
      (s) => s === "under-defined",
    );
    this.statusBar.setSolveStatus(res, anyUnderDefined);
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
      previews: this.generatorPreview ? to.previews.concat(this.generatorPreview) : to.previews,
      selectionRect: to.selectionRect,
      snap: to.snap ?? this.currentSnap,
      hover: this.currentHover,
      hoverConstraint: this.currentHoverConstraint,
      hoverDimension: this.currentHoverDimension,
      transformBox: to.transformBox,
      diagnostics: this.dxfDiagnostics,
      stitchPreview: this.stitchPreview,
      flipPreview: this.flipPreview,
    };
    this.renderer.render(this.doc, this.view, overlay);
    this.statusBar.setZoom(this.view.scale);
  }

  // --- view fitting --------------------------------------------------------
  private fitView(): void {
    const wa: Bounds = {
      min: { x: 0, y: 0 },
      max: { x: this.doc.canvas.width, y: this.doc.canvas.height },
    };
    const gb = this.doc.bounds();
    const b = gb ? unionBounds(wa, gb) : wa;
    this.view.fit(b, 48);
    this.requestRender();
  }

  /** Initial view for a new empty document: origin near lower-left with work area visible above. */
  private initialFit(): void {
    const w = this.view.width;
    const h = this.view.height;
    if (w === 0 || h === 0) {
      this.fitView();
      return;
    }
    const workW = this.doc.canvas.width;
    const workH = this.doc.canvas.height;
    // Scale so the work area fills ~65% of the viewport in the tighter dimension.
    const scale = Math.min((w * 0.65) / workW, (h * 0.6) / workH);
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
      this.onContextMenu(e);
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

  // --- cursor feedback ------------------------------------------------------

  private updateCursor(): void {
    this.canvas.style.cursor = this.computeCursor();
  }

  /** What a click at the current pointer position would act on, as a cursor:
   *  resize/rotate over transform handles, pointer over grabbable points,
   *  move/grabbing over entity bodies, grab(bing) for panning. */
  private computeCursor(): string {
    if (this.panning) return "grabbing";
    if (this.spaceDown) return "grab";
    if (this.tools.active.id !== "select") return "crosshair";
    if (this.pointerActive && this.pressCursor) {
      return this.pressCursor === "move" ? "grabbing" : this.pressCursor;
    }
    const screen = this.lastScreen;
    if (!screen) return "default";

    const box = computeTransformBox(this.doc, this.view);
    if (box) {
      for (const h of box.handles) {
        if (dist(screen, this.view.worldToScreen(h.pos)) <= 10) {
          return h.type === "rotate" ? ROTATE_CURSOR : (RESIZE_CURSORS[h.id] ?? "default");
        }
      }
    }
    for (const ent of this.doc.entities) {
      if (!ent.selected || this.doc.groupOf(ent.id)) continue;
      for (const p of ent.dofPoints()) {
        if (dist(screen, this.view.worldToScreen(p.pos)) < 10) return "pointer";
      }
    }

    const geo: Geo = (id: string) =>
      id === STOCK_ENTITY_ID ? stockRefEntity(this.doc) : this.doc.entities.find((e) => e.id === id);
    for (const dim of this.doc.dimensions) {
      const layout = dimensionLayout(dim, geo, this.doc.displayUnit, this.view.scale);
      if (layout) {
        const labelScreenDist = dist(screen, this.view.worldToScreen(layout.textPos));
        if (labelScreenDist < 12) return "move";
      }
    }

    if (this.currentHover) return "move";
    return "default";
  }

  // --- pointer -------------------------------------------------------------
  private onPointerDown = (ev: PointerEvent): void => {
    const screen = this.screenOf(ev);
    this.lastScreen = screen;
    const isPan = ev.button === 1 || (ev.button === 0 && this.spaceDown);
    if (isPan) {
      this.panning = true;
      this.panLast = screen;
      this.canvas.setPointerCapture(ev.pointerId);
      this.updateCursor();
      ev.preventDefault();
      return;
    }
    if (ev.button === 0 && this.doc.regionPickHandler) {
      if (this.doc.regionPickHandler(this.view.screenToWorld(screen))) {
        this.requestRender();
        return;
      }
    }
    // Freeze the affordance cursor for the duration of the drag.
    if (ev.button === 0) {
      this.pointerActive = true;
      const c = this.computeCursor();
      this.pressCursor = c === "default" ? null : c;
    }
    this.canvas.setPointerCapture(ev.pointerId);
    this.tools.pointerDown(this.toolEvent(ev, screen));
    this.updateCursor();
    this.requestRender();
  };

  /**
   * Highlight what the pointer is over in the design tree. Exactly one kind of
   * hover can be live at a time — the same invariant the canvas hover keeps —
   * so passing one clears the other two, and passing null clears everything.
   * Safe to leave set while the pointer is on the panel: the next canvas
   * pointermove recomputes all three from the cursor anyway.
   */
  private setTreeHover(h: {
    entity?: EntityId | null;
    dimension?: string | null;
    constraint?: EntityId | null;
  }): void {
    const next = {
      hover: h.entity ?? null,
      dim: h.dimension ?? null,
      con: h.constraint ?? null,
    };
    if (
      this.currentHover === next.hover &&
      this.currentHoverDimension === next.dim &&
      this.currentHoverConstraint === next.con
    )
      return;
    this.currentHover = next.hover;
    this.currentHoverDimension = next.dim;
    this.currentHoverConstraint = next.con;
    this.requestRender();
  }

  private onPointerMove = (ev: PointerEvent): void => {
    const screen = this.screenOf(ev);
    this.lastScreen = screen;
    if (this.panning) {
      this.view.panBy(screen.x - this.panLast.x, screen.y - this.panLast.y);
      this.panLast = screen;
      this.statusBar.setCursor(this.view.screenToWorld(screen));
      this.requestRender();
      return;
    }
    const e = this.toolEvent(ev, screen);
    if (this.doc.regionHoverHandler) this.doc.regionHoverHandler(e.worldRaw);
    const prevHover = this.currentHover;
    const prevHoverConstraint = this.currentHoverConstraint;
    const prevHoverDim = this.currentHoverDimension;

    this.currentHover =
      this.tools.active.id === "select" || this.tools.active.id === "offset"
        ? (this.doc.hitTest(e.worldRaw, this.view.toWorldLen(HOVER_TOLERANCE_PX))?.id ?? null)
        : null;

    this.currentHoverConstraint =
      this.tools.active.id === "select"
        ? (pickConstraintAt(this.doc, this.view, e.screen)?.id ?? null)
        : null;

    let hitHoverDimId: string | null = null;
    if (this.tools.active.id === "select") {
      const byId = new Map(this.doc.entities.map((ent) => [ent.id, ent]));
      const geo: Geo = (id) =>
        id === STOCK_ENTITY_ID ? stockRefEntity(this.doc) : byId.get(id);
      for (const dim of this.doc.dimensions) {
        const d =
          dimensionHitDistance(dim, geo, e.worldRaw, this.doc.displayUnit, this.view.scale) *
          this.view.scale;
        if (d < 10) {
          hitHoverDimId = dim.id;
          break;
        }
      }
    }
    this.currentHoverDimension = hitHoverDimId;

    this.statusBar.setCursor(e.world);
    this.tools.pointerMove(e);
    this.updateCursor();

    // Only repaint when something on the canvas would actually differ. A full
    // scene repaint is by far the most expensive thing a mouse move can trigger
    // — ~75ms on a 2000-entity document, against ~5ms for all the hit-testing
    // and picking put together — so moving the pointer across empty space, or
    // within the same entity, should cost nothing.
    //
    // Deliberately narrow. The skip applies only while IDLE-HOVERING: with a
    // button down a tool is mid-gesture (rubber band, in-progress line, snap
    // marker) and paints a preview this method cannot see, since pointerMove
    // returns void and no tool can report that it drew something. Anything other
    // than a plain hover still repaints exactly as before.
    const idleHover = ev.buttons === 0;
    const hoverChanged =
      this.currentHover !== prevHover ||
      this.currentHoverConstraint !== prevHoverConstraint ||
      this.currentHoverDimension !== prevHoverDim;
    if (!idleHover || hoverChanged) this.requestRender();
  };

  private onPointerUp = (ev: PointerEvent): void => {
    if (this.panning) {
      this.panning = false;
      this.canvas.releasePointerCapture(ev.pointerId);
      this.updateCursor();
      return;
    }
    const screen = this.screenOf(ev);
    this.tools.pointerUp(this.toolEvent(ev, screen));
    this.canvas.releasePointerCapture(ev.pointerId);
    this.pointerActive = false;
    this.pressCursor = null;
    this.updateCursor();
    this.requestRender();
  };

  private onDoubleClick = (ev: MouseEvent): void => {
    const screen = this.screenOf(ev);
    const world = this.view.screenToWorld(screen);
    // Editing a dimension's value works in any tool.
    const dim = this.doc.dimensionAt(world, this.view.toWorldLen(8), this.view.scale);
    if (dim) {
      this.openDimEditor(dim);
      return;
    }
    // Double-clicking generated geometry with the select tool active opens the
    // owning feature for editing — this intentionally supersedes the select
    // tool's default double-click behavior (e.g. polyline chain-select) for
    // anything a generator produced, since re-opening its params is almost
    // always the more useful action.
    if (this.tools.active.id === "select") {
      const hitId = this.pickEntityAt(world);
      const feat = hitId ? findFeatureForEntities(this.doc, [hitId]) : null;
      const gen = feat ? GENERATORS[feat.generatorId] : undefined;
      if (feat && gen) {
        openGeneratorDialog({
          doc: this.doc,
          pushHistory: this.project.pushHistory,
          gen,
          editFeatureId: feat.id,
          onPreview: this.generatorPreviewSink,
        });
        return;
      }
    }
    this.tools.doubleClick(this.toolEvent(ev, screen));
    this.requestRender();
  };

  // --- inline dimension value editor ---------------------------------------
  private openDimEditor(dim: Dimension): void {
    const byId = new Map(this.doc.entities.map((e) => [e.id, e]));
    const geo: Geo = (id) =>
      id === STOCK_ENTITY_ID || id.startsWith(STOCK_ENTITY_ID)
        ? stockRefEntity(this.doc)
        : byId.get(id);
    const layout = dimensionLayout(dim, geo, this.doc.displayUnit, this.view.scale);
    if (!layout) return;

    this.dimEditor.open({
      dim,
      container: this.canvas.parentElement!,
      screenPos: this.view.worldToScreen(layout.textPos),
      displayUnit: this.doc.displayUnit,
      vars: varMap(this.doc.variables, this.doc.stockThickness),
      onCommit: (v, expr) => this.commitDimValue(dim, v, expr),
      onError: (msg) => this.statusBar.flash(msg),
      commitFailureReason: () => this.dimCommitFailure,
    });
  }

  /** Why the last commitDimValue refused, for the editor to report. */
  private dimCommitFailure: string | null = null;

  private commitDimValue(dimArg: Dimension, v: number, expr?: string): boolean {
    this.dimCommitFailure = null;
    // Re-resolve by id to the live instance: a prior rejected commit calls
    // doc.restore(), which rebuilds every Dimension as a new object. The editor
    // stays open holding its original reference, so on the retry `dimArg` may be
    // an orphan no longer in the document — mutating that would silently no-op.
    const dim = this.doc.dimensions.find((d) => d.id === dimArg.id) ?? dimArg;

    // Arc-length cannot exceed full circumference.
    if (dim.type === "arclength") {
      const byId = new Map(this.doc.entities.map((e) => [e.id, e]));
      const ent = byId.get(dim.entities[0]) as import("./model/entities").ArcEntity | undefined;
      if (ent?.type === "arc" && v >= 2 * Math.PI * ent.radius) return false;
    }

    const docSnap = this.doc.snapshot();

    dim.value = v;
    dim.expr = expr;
    dim.driving = true;
    this.runSolve();

    if (this.lastSolveResult && !this.lastSolveResult.converged) {
      // Say WHICH kind of refusal this is while the failing state is still
      // loaded — "over-constrained" and "this value is unreachable" need
      // different fixes, and after the rollback below the evidence is gone.
      // A non-positive DOF means the sketch had no freedom left to absorb the
      // new dimension; otherwise there was room and the solver still could not
      // reach this particular value (e.g. a length longer than the geometry
      // it is attached to allows).
      this.dimCommitFailure =
        this.currentDof() <= 0
          ? "The sketch is already fully constrained — remove a dimension or constraint first"
          : "The solver couldn't reach that value — it may not be geometrically possible";
      // Full rollback to the captured snapshot: the solver already moved geometry,
      // so reverting just the three dim fields and re-solving isn't guaranteed to
      // reproduce the prior state (and that re-solve could itself fail to converge,
      // leaving the document corrupted). Restoring the snapshot is exact.
      this.doc.restore(docSnap);
      this.runSolve();
      return false;
    }

    this.project.pushHistory(docSnap);
    return true;
  }

  private openValueEditor(
    worldPos: Vec2,
    placeholder: string,
    onCommit: (raw: string) => boolean | undefined,
    onCancel: () => void,
    onTab?: () => void,
  ): void {
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
          setTimeout(() => {
            input.style.color = "";
          }, 600);
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

  private openMultiValueEditor(
    worldPos: Vec2,
    fields: { placeholder: string; initial?: string }[],
    onCommit: (raws: string[]) => boolean | undefined,
    onCancel: () => void,
    onChange?: (raws: string[]) => void,
  ): void {
    this.closeValueEditor();
    const pos = this.view.worldToScreen(worldPos);
    
    const container = document.createElement("div");
    container.className = "dim-multi-edit";
    container.style.left = `${pos.x - 36}px`;
    container.style.top = `${pos.y + 14}px`;

    const inputs: HTMLInputElement[] = [];
    
    const tryCommit = () => {
      const raws = inputs.map(i => i.value);
      const ok = onCommit(raws);
      if (ok === false) {
        container.style.borderColor = "#e05555";
        setTimeout(() => {
          container.style.borderColor = "";
        }, 600);
      } else {
        this.closeValueEditor();
      }
    };

    fields.forEach((field, idx) => {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "dim-multi-input";
      input.placeholder = field.placeholder;
      if (field.initial !== undefined) {
        input.value = field.initial;
      }
      
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          tryCommit();
          e.preventDefault();
        } else if (e.key === "Escape") {
          this.closeValueEditor();
          onCancel();
          e.preventDefault();
        }
        e.stopPropagation();
      });
      
      input.addEventListener("input", () => {
        if (onChange) {
          onChange(inputs.map(i => i.value));
        }
      });
      
      // Blur closes if focus moves outside the container
      input.addEventListener("blur", () => {
        setTimeout(() => {
          if (this.valueEditor === container && !container.contains(document.activeElement)) {
            this.closeValueEditor();
          }
        }, 0);
      });
      
      input.addEventListener("focus", () => {
        input.select();
      });

      container.appendChild(input);
      inputs.push(input);
      
      // Add a subtle separator between inputs
      if (idx < fields.length - 1) {
        const sep = document.createElement("div");
        sep.className = "dim-multi-separator";
        container.appendChild(sep);
      }
    });

    this.canvas.parentElement!.appendChild(container);
    this.valueEditor = container;
    
    if (inputs.length > 0) {
      inputs[0].focus();
      inputs[0].select();
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

  private explodeSelectedEntities(): void {
    if (this.doc.selected.length === 0) return;
    this.project.pushHistory();
    if (!explodeSelected(this.doc)) this.project.undoRedo("undo");
    else this.runSolve();
  }

  /** Centre the selected item(s) inside the largest selected shape by pinning
   *  their centre coordinate (one-axis fixedPoint). Only the movers move; the
   *  reference is untouched. Guards against over-constraining, like a constraint. */
  private centerSelection(axis: CenterAxis): void {
    const plan = planCenter(this.doc, axis);
    if (!plan.ok) {
      this.statusBar.flash(plan.reason);
      return;
    }
    // Same rank-based guard the Constraints bar uses: reject a redundant or
    // over-constraining add rather than fighting the solver / silently failing.
    const { variables, rankWithout, rankWith } = constraintJacobianRankChange(
      this.doc,
      plan.constraints,
    );
    if (rankWith - rankWithout === 0) {
      this.statusBar.flash("Already centred on that axis");
      return;
    }
    if (rankWith - rankWithout > variables - rankWithout) {
      this.statusBar.flash("Already positioned — remove a constraint to re-centre");
      return;
    }
    this.project.pushHistory();
    for (const c of plan.constraints) this.doc.addConstraint(c);
    this.runSolve();
    if (this.lastSolveResult && !this.lastSolveResult.converged) {
      this.project.undoRedo("undo");
      this.statusBar.flash("Couldn't centre — it conflicts with an existing constraint");
      return;
    }
    this.statusBar.flash(
      axis === "both" ? "Centred" : `Centred ${axis === "h" ? "horizontally" : "vertically"}`,
    );
  }

  private async deleteSelected(): Promise<void> {
    this.dimEditor.close();
    this.closeValueEditor();

    if (this.doc.selectedConstraintId) {
      this.project.pushHistory();
      this.doc.removeConstraint(this.doc.selectedConstraintId);
      this.runSolve();
    } else if (this.doc.selectedDimensionId) {
      this.project.pushHistory();
      this.doc.removeDimension(this.doc.selectedDimensionId);
      this.runSolve();
    } else if (this.doc.selected.length > 0 || this.doc.selectedPoints.length > 0) {
      const selectedEntities = this.doc.selected;
      const pointEntityIds = this.doc.selectedPoints.map((p) => p.entityId);
      const allTargetIds = [...new Set([...selectedEntities.map((e) => e.id), ...pointEntityIds])];

      const ops = getAssociatedOperations(this.doc.operations, allTargetIds);
      if (ops.length > 0) {
        const names = [...new Set(ops.map((o) => o.name))];
        const count = allTargetIds.length;
        const ok = await confirmDialog({
          title: "Delete object with toolpath?",
          message: `The selected object${count > 1 ? "s are" : " is"} associated with toolpath${names.length > 1 ? "s" : ""}:\n\n${names.map((n) => `• ${n}`).join("\n")}\n\nAre you sure you want to delete ${count > 1 ? "them" : "it"}?`,
          confirmLabel: "Delete",
          danger: true,
        });
        if (!ok) return;
      }
      this.project.pushHistory();
      this.doc.removeSelected();
      this.runSolve();
    }
  }

  // --- clipboard -----------------------------------------------------------

  /** Detached clones of the selection plus its fully-contained groups
   *  (as index lists into the clone array), or null when nothing is selected. */
  private snapshotSelection(): { clones: Entity[]; groups: number[][] } | null {
    const sel = this.doc.selected;
    if (sel.length === 0) return null;
    const idToIdx = new Map(sel.map((e, i) => [e.id, i]));
    return {
      clones: sel.map((e) => e.duplicate()),
      groups: this.doc.groups
        .filter((g) => g.entityIds.every((id) => idToIdx.has(id)))
        .map((g) => g.entityIds.map((id) => idToIdx.get(id)!)),
    };
  }

  /** Add clones to the document as the new selection, recreating groups. */
  private insertClones(clones: Entity[], groups: number[][]): void {
    this.doc.clearSelection();
    for (const c of clones) {
      this.doc.entities.push(c);
      c.selected = true;
    }
    for (const idxs of groups) {
      this.doc.groups.push({
        id: nextId("grp"),
        name: "",
        entityIds: idxs.map((i) => clones[i].id),
      });
    }
    this.runSolve();
    this.doc.emitChange();
  }

  private copySelected(): void {
    const snap = this.snapshotSelection();
    if (!snap) return;
    this.clipboard = snap.clones;
    this.clipboardGroups = snap.groups;
    this.pasteCount = 0;
  }

  private cutSelected(): void {
    const snap = this.snapshotSelection();
    if (!snap) return;
    this.clipboard = snap.clones;
    this.clipboardGroups = snap.groups;
    this.pasteCount = 0;
    this.project.pushHistory();
    this.doc.removeSelected();
    this.runSolve();
  }

  /** Paste at `at` (clipboard bounds centred on it) or, without a target,
   *  offset from the source — cascading, so repeat pastes don't stack. */
  private paste(at?: Vec2): void {
    if (this.clipboard.length === 0) return;
    this.project.pushHistory();
    // Placement (clone-then-offset, never mutating the clipboard) lives in the pure
    // placePasteClones helper. The cascade counter — so repeat plain pastes step
    // away instead of stacking — is the only per-App state; it's reset on copy/cut.
    const count = at ? 0 : ++this.pasteCount;
    const clones = placePasteClones(this.clipboard, count, at);
    this.insertClones(clones, this.clipboardGroups);
  }

  private duplicateSelected(): void {
    const snap = this.snapshotSelection();
    if (!snap) return;
    this.project.pushHistory();
    for (const c of snap.clones) c.translate({ x: PASTE_OFFSET_MM, y: -PASTE_OFFSET_MM });
    this.insertClones(snap.clones, snap.groups);
  }

  private selectAll(): void {
    let changed = false;
    for (const e of this.doc.entities) {
      if (e.id === ORIGIN_ENTITY_ID || e.selected) continue;
      if (!this.doc.isPickable(e)) continue;
      e.selected = true;
      changed = true;
    }
    if (changed) this.doc.emitChange();
  }

  /** Move the selection by (dx, dy) mm from the arrow keys, through the solver
   *  so constrained geometry follows, exactly like an entity-body drag. */
  private nudgeSelected(dx: number, dy: number, firstPress: boolean): void {
    if (this.doc.selected.length === 0) return;
    if (this.currentDof() <= 0) {
      this.statusBar.flash(
        "Fully constrained — edit a dimension or remove a constraint to move this",
      );
      return;
    }
    if (firstPress) this.project.pushHistory();
    const before = selectionSnapPositions(this.doc);
    const pins: PinMap = new Map();
    for (const e of this.doc.selected) {
      if (this.doc.isMovable(e)) e.translate({ x: dx, y: dy });
      for (const p of e.dofPoints()) pins.set(`${e.id}:${p.key}`, p.pos);
    }
    this.runSolve(pins);
    // Same resistance check as an entity drag: when constraints anchored to
    // unselected geometry pull the nudge back, say so instead of staying mute.
    const req = Math.hypot(dx, dy);
    if (
      before.length > 0 &&
      meanDeviation(before, { x: dx, y: dy }, selectionSnapPositions(this.doc)) > 0.4 * req
    ) {
      this.statusBar.flash(
        "Constraints resisted the move — double-click selects connected geometry",
      );
    }
    this.doc.emitChange();
  }

  // --- context menu --------------------------------------------------------
  private onContextMenu(ev: MouseEvent): void {
    // For drawing tools, right-click cancels/finishes the current operation
    // (its long-standing behavior) rather than popping a menu.
    if (this.tools.active.id !== "select") {
      this.tools.cancelActive();
      this.requestRender();
      return;
    }

    const screen = this.screenOf(ev);
    const world = this.view.screenToWorld(screen);

    // Right-clicking an unselected entity selects it (with its group) so the
    // menu acts on a sensible target. Right-clicking empty space keeps the
    // current selection.
    const hitId = this.pickEntityAt(world);
    if (hitId) {
      const ent = this.doc.entities.find((e) => e.id === hitId)!;
      if (!ent.selected) {
        this.doc.clearSelection();
        const group = this.doc.groupOf(ent.id);
        if (group) {
          for (const id of group.entityIds) {
            const ge = this.doc.entities.find((x) => x.id === id);
            if (ge) ge.selected = true;
          }
        } else {
          ent.selected = true;
        }
        this.doc.emitChange();
      }
    }

    const sel = this.doc.selected;
    const entries: ContextMenuEntry[] = [];

    if (sel.length > 0) {
      entries.push({ label: "Copy", shortcut: "^C", onClick: () => this.copySelected() });
      entries.push({ label: "Cut", shortcut: "^X", onClick: () => this.cutSelected() });
      entries.push({ label: "Duplicate", shortcut: "^D", onClick: () => this.duplicateSelected() });
    }
    entries.push({
      label: "Paste",
      shortcut: "^V",
      enabled: this.clipboard.length > 0,
      onClick: () => this.paste(world),
    });
    entries.push("sep");

    if (sel.length > 0) {
      const allConstruction = sel.every((e) => e.isConstruction);
      entries.push({ label: "Delete", shortcut: "Del", onClick: () => this.deleteSelected() });
      entries.push({
        label: "Join",
        shortcut: "^J",
        enabled: sel.length >= 2,
        onClick: () => this.joinSelectedEntities(),
      });
      entries.push({
        label: "Explode",
        shortcut: "^⇧J",
        onClick: () => this.explodeSelectedEntities(),
      });
      entries.push({
        label: allConstruction ? "Make Normal" : "Make Construction",
        shortcut: "X",
        onClick: () => this.toggleConstruction(),
      });
      if (canCenter(this.doc)) {
        entries.push("sep");
        entries.push({
          label: "Center Horizontally",
          onClick: () => this.centerSelection("h"),
        });
        entries.push({ label: "Center Vertically", onClick: () => this.centerSelection("v") });
        entries.push({ label: "Center in Shape", onClick: () => this.centerSelection("both") });
      }
      entries.push("sep");
      entries.push({
        label: "Linear Pattern…",
        onClick: () => openLinearPatternDialog(this.doc, this.project.pushHistory),
      });
      entries.push({
        label: "Circular Pattern…",
        onClick: () => openCircularPatternDialog(this.doc, this.project.pushHistory),
      });
      entries.push({
        label: "Rectangular Array…",
        onClick: () => openRectArrayDialog(this.doc, this.project.pushHistory),
      });
      entries.push({
        label: "Circular Array…",
        onClick: () => openCircArrayDialog(this.doc, this.project.pushHistory),
      });
      entries.push("sep");
    }

    if (this.stalePatternIds.size > 0) {
      entries.push({
        label: "Regenerate Patterns",
        shortcut: "^⇧P",
        onClick: () => this.doRegeneratePatterns(),
      });
    }
    entries.push({ label: "Fit View", onClick: () => this.fitView() });

    this.contextMenu.show(ev.clientX, ev.clientY, entries);
  }

  /** Nearest entity body under a world point (within 10px on screen), or null. */
  private pickEntityAt(world: Vec2): EntityId | null {
    let hitId: EntityId | null = null;
    let best = Infinity;
    for (const ent of this.doc.entities) {
      const px = ent.distanceTo(world) * this.view.scale;
      if (px < 10 && px < best) {
        best = px;
        hitId = ent.id;
      }
    }
    return hitId;
  }

  // --- keyboard ------------------------------------------------------------
  private onKeyDown = (ev: KeyboardEvent): void => {
    if (isTypingTarget(ev.target)) return;
    // While a dialog is open it owns the keyboard: don't let editor shortcuts
    // (Ctrl+N, undo, Delete, single-key tool switches) mutate the document
    // underneath it. Escape-to-close is handled by the modal manager itself.
    if (isModalOpen()) return;

    if (ev.key === " ") {
      this.spaceDown = true;
      this.updateCursor();
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

    // Ctrl+B, not the plain "B" the design docs suggested: "b" is already the
    // Bezier tool (tools/shortcuts.ts), and a modifier-less key that both draws
    // and opens a panel is not a trade worth making.
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "b") {
      this.designTree.toggle();
      ev.preventDefault();
      return;
    }

    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "j") {
      if (ev.shiftKey) this.explodeSelectedEntities();
      else this.joinSelectedEntities();
      ev.preventDefault();
      return;
    }

    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "g") {
      ev.preventDefault();
      if (ev.shiftKey) {
        // Ungroup
        const selectedIds = new Set(this.doc.selected.map((e) => e.id));
        const groupsToKeep = this.doc.groups.filter(
          (g) => !g.entityIds.some((id) => selectedIds.has(id)),
        );
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
            entityIds: this.doc.selected.map((e) => e.id),
          };
          this.doc.groups.push(group);
          this.doc.emitChange();
        }
      }
      return;
    }

    if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey) {
      const k = ev.key.toLowerCase();
      if (k === "a") {
        this.selectAll();
        ev.preventDefault();
        return;
      }
      if (k === "c") {
        this.copySelected();
        ev.preventDefault();
        return;
      }
      if (k === "x") {
        this.cutSelected();
        ev.preventDefault();
        return;
      }
      if (k === "v") {
        this.paste();
        ev.preventDefault();
        return;
      }
      if (k === "d") {
        this.duplicateSelected();
        ev.preventDefault();
        return;
      }
    }

    // Arrow-key nudge: 1 mm (0.05 in), Shift = ×10, Alt = ÷10 — in the
    // document's display unit. Runs through the solver like a drag, so
    // constrained geometry follows or resists.
    const NUDGE: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, 1],
      ArrowDown: [0, -1],
    };
    const dir = NUDGE[ev.key];
    if (dir && !ev.ctrlKey && !ev.metaKey && this.doc.selected.length > 0) {
      const base = this.doc.displayUnit === "in" ? 1.27 : 1; // 0.05 in
      const step = ev.shiftKey ? base * 10 : ev.altKey ? base / 10 : base;
      this.nudgeSelected(dir[0] * step, dir[1] * step, !ev.repeat);
      ev.preventDefault();
      return;
    }

    if (ev.key === "?") {
      showShortcutOverlay();
      ev.preventDefault();
      return;
    }

    // Let the active tool consume the key first (Enter, Backspace, Escape…).
    this.tools.keyDown(ev);

    if (ev.key === "Escape") {
      this.tools.cancelActive();
      // In select mode Escape also clears the selection (universal convention).
      if (
        this.tools.active.id === "select" &&
        (this.doc.selected.length > 0 ||
          this.doc.selectedPoints.length > 0 ||
          this.doc.selectedConstraintId !== null ||
          this.doc.selectedDimensionId !== null)
      ) {
        this.doc.clearSelection();
        this.doc.emitChange();
      }
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
    if (ev.key === " ") {
      this.spaceDown = false;
      this.updateCursor();
    }
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
