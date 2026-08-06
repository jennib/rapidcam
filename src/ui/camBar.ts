/**
 * CAM / Toolpaths Side Panel.
 *
 * Coordinates the operations list, toolpath CRUD dialog, export workflows,
 * and machine integrations.
 */
import type { CADDocument } from "../model/document";
import type { StitchPreview, FlipPreview } from "../view/overlay";
import type { CAMOperation } from "../cam/types";
import { openToolLibraryDialog } from "./toolLibraryDialog";
import { openLaserPresetsDialog } from "./laserPresetsDialog";
import { CamExportService } from "./camBar/camExportService";
import { OpEstimateManager } from "./camBar/opEstimateManager";
import { CamHighlighter } from "./camBar/camHighlighter";
import { CamSelectionManager } from "./camBar/camSelectionManager";
import {
  type CamWorkflowContext,
  toolpathsFromLayersWorkflow,
  runMaterialTestWorkflow,
  openFlipWorkflow,
  openStitchWorkflow,
} from "./camBar/camWorkflows";
import { openOpDialog } from "./camBar/dialog/opDialog";
import { buildOpItem } from "./camBar/opItemBuilder";

export class CamBar {
  private content!: HTMLElement;
  private opsList!: HTMLElement;
  private isCollapsed = false;
  private dragState = { srcIndex: null as number | null };

  private libBtn: HTMLButtonElement | null = null;
  private testBtn: HTMLButtonElement | null = null;
  private presetBtn: HTMLButtonElement | null = null;
  private fromLayersBtn: HTMLButtonElement | null = null;
  private stitchBtn: HTMLButtonElement | null = null;
  private flipBtn: HTMLButtonElement | null = null;

  private exportService: CamExportService;
  private estimateManager: OpEstimateManager;
  private highlighter: CamHighlighter;
  private selectionManager: CamSelectionManager;

  constructor(
    private host: HTMLElement,
    private doc: CADDocument,
    private pushHistory?: () => void,
    private onStitchPreview?: (p: StitchPreview | null) => void,
    private onFlipPreview?: (p: FlipPreview | null) => void,
    private getProjectName?: () => string,
  ) {
    this.exportService = new CamExportService({
      doc: this.doc,
      getProjectName: this.getProjectName,
    });
    this.estimateManager = new OpEstimateManager(
      this.doc,
      () => this.exportService.gcodeOpts(),
    );
    this.highlighter = new CamHighlighter(this.doc);
    this.selectionManager = new CamSelectionManager();

    this.build();
    doc.onChange(() => this.renderOps());
  }

  private get workflowContext(): CamWorkflowContext {
    return {
      doc: this.doc,
      pushHistory: this.pushHistory,
      renderOps: () => this.renderOps(),
    };
  }

  private build(): void {
    const header = document.createElement("div");
    header.className = "cam-header";
    const title = document.createElement("div");
    title.className = "cam-title";
    title.textContent = "Toolpaths";
    header.appendChild(title);
    const toggle = document.createElement("button");
    toggle.className = "cam-toggle";
    toggle.textContent = "›";
    toggle.title = "Collapse/Expand";
    toggle.addEventListener("click", () => this.toggleCollapse());
    header.appendChild(toggle);
    this.host.appendChild(header);

    this.content = document.createElement("div");
    this.content.className = "cam-content";
    this.host.appendChild(this.content);

    this.opsList = document.createElement("div");
    this.opsList.className = "cam-ops-list";
    this.content.appendChild(this.opsList);

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:6px;";

    const addBtn = document.createElement("button");
    addBtn.className = "cam-add-btn";
    addBtn.style.flex = "1";
    addBtn.textContent = "+ Add Toolpath";
    addBtn.addEventListener("click", () => this.openDialog(null));
    btnRow.appendChild(addBtn);

    const libBtn = document.createElement("button");
    libBtn.className = "cam-add-btn";
    libBtn.style.flex = "1";
    libBtn.textContent = "Manage Tools";
    libBtn.addEventListener("click", () => openToolLibraryDialog(this.doc.displayUnit));
    btnRow.appendChild(libBtn);
    this.libBtn = libBtn;

    const testBtn = document.createElement("button");
    testBtn.className = "cam-add-btn";
    testBtn.style.flex = "1";
    testBtn.textContent = "Material Test";
    testBtn.title = "Generate a power×speed test grid to dial in laser settings";
    testBtn.addEventListener("click", () => runMaterialTestWorkflow(this.workflowContext));
    btnRow.appendChild(testBtn);
    this.testBtn = testBtn;

    const presetBtn = document.createElement("button");
    presetBtn.className = "cam-add-btn cam-presets-btn";
    presetBtn.style.flex = "1";
    presetBtn.textContent = "Presets";
    presetBtn.title = "Manage saved laser material presets (power / speed / passes)";
    presetBtn.addEventListener("click", () => openLaserPresetsDialog(this.doc.displayUnit));
    btnRow.appendChild(presetBtn);
    this.presetBtn = presetBtn;

    this.content.appendChild(btnRow);

    const fromLayersBtn = document.createElement("button");
    fromLayersBtn.className = "cam-add-btn cam-from-layers-btn";
    fromLayersBtn.style.cssText = "width:100%;margin-top:6px;";
    fromLayersBtn.textContent = "Toolpaths from Layers";
    fromLayersBtn.title =
      "Create one toolpath per layer, using the job type and beam settings set on each layer";
    fromLayersBtn.addEventListener("click", () => void toolpathsFromLayersWorkflow(this.workflowContext));
    this.content.appendChild(fromLayersBtn);
    this.fromLayersBtn = fromLayersBtn;

    const sep = document.createElement("div");
    sep.className = "cam-sep";
    this.content.appendChild(sep);

    const genBtn = document.createElement("button");
    genBtn.className = "cam-gen-btn";
    genBtn.textContent = "Generate G-code";
    genBtn.addEventListener("click", () => void this.exportService.generate());
    this.content.appendChild(genBtn);

    const sendBtn = document.createElement("button");
    sendBtn.className = "cam-add-btn";
    sendBtn.style.cssText = "width:100%;margin-top:6px;";
    sendBtn.textContent = "Send G-code";
    sendBtn.title = "Load these toolpaths into a running sender application";
    sendBtn.addEventListener("click", () => void this.exportService.sendToMachine());
    this.content.appendChild(sendBtn);

    this.selectionManager.createButton(this.content, (selectedIds) => {
      void this.exportService.exportSelected(selectedIds);
    });

    if (this.onStitchPreview) {
      const stitchBtn = document.createElement("button");
      stitchBtn.className = "cam-add-btn";
      stitchBtn.style.cssText = "width:100%;margin-top:6px;";
      stitchBtn.textContent = "Tile for small machine…";
      stitchBtn.title = "Split a design larger than the machine bed into per-tile G-code";
      stitchBtn.addEventListener("click", () => {
        openStitchWorkflow(
          this.doc,
          this.exportService.gcodeOpts(),
          this.exportService.projectName(),
          this.onStitchPreview,
        );
      });
      this.content.appendChild(stitchBtn);
      this.stitchBtn = stitchBtn;
    }

    if (this.onFlipPreview) {
      const flipBtn = document.createElement("button");
      flipBtn.className = "cam-add-btn";
      flipBtn.style.cssText = "width:100%;margin-top:6px;";
      flipBtn.textContent = "Two-sided (flip)…";
      flipBtn.title = "Set up double-sided machining with registration pins";
      flipBtn.addEventListener("click", () => {
        openFlipWorkflow(this.workflowContext, this.onFlipPreview);
      });
      this.content.appendChild(flipBtn);
      this.flipBtn = flipBtn;
    }

    this.renderOps();
  }

  private updateModeButtons(): void {
    const millOnly = this.doc.machineKind === "mill";
    if (this.stitchBtn) this.stitchBtn.style.display = millOnly ? "" : "none";
    if (this.flipBtn) this.flipBtn.style.display = millOnly ? "" : "none";
  }

  private renderOps(): void {
    const laser = this.doc.isLaser;
    if (this.libBtn) this.libBtn.style.display = laser ? "none" : "";
    if (this.testBtn) this.testBtn.style.display = laser ? "" : "none";
    if (this.presetBtn) this.presetBtn.style.display = laser ? "" : "none";
    if (this.fromLayersBtn) this.fromLayersBtn.style.display = laser ? "" : "none";
    this.updateModeButtons();

    const live = new Set(this.doc.operations.map((o) => o.id));
    this.selectionManager.syncWithLiveOps(live);

    this.opsList.innerHTML = "";
    this.estimateManager.clearElements();

    if (this.doc.operations.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state cam-ops-empty";
      empty.innerHTML = `
        <div class="empty-icon">⬚</div>
        <div>No toolpaths yet — select a shape, then “+ Add Toolpath”.</div>
      `;
      this.opsList.appendChild(empty);
      return;
    }

    const opItemCtx = {
      doc: this.doc,
      opsList: this.opsList,
      selectedOpIds: this.selectionManager.selectedOpIds,
      highlightedOpId: this.highlighter.currentId,
      dragState: this.dragState,
      estimateManager: this.estimateManager,
      onHighlightOp: (id: string | null) => {
        this.highlighter.highlightOp(id);
        this.renderOps();
      },
      onToggleSelectOp: (id: string, selected: boolean) => {
        this.selectionManager.toggle(id, selected);
      },
      onEditOp: (op: CAMOperation) => this.openDialog(op),
      onDeleteOp: (op: CAMOperation) => {
        this.pushHistory?.();
        if (this.highlighter.currentId === op.id) this.highlighter.highlightOp(null);
        this.doc.operations = this.doc.operations.filter((o) => o.id !== op.id);
        this.doc.emitChange();
        this.renderOps();
      },
      onExportOp: (op: CAMOperation, index: number) => {
        void this.exportService.exportSingleOp(op, index);
      },
      onReorderOps: (srcIndex: number, destIndex: number, insertBefore: boolean) => {
        const ops = [...this.doc.operations];
        const [moved] = ops.splice(srcIndex, 1);
        const tgt = srcIndex < destIndex ? destIndex - 1 : destIndex;
        ops.splice(insertBefore ? tgt : tgt + 1, 0, moved);
        this.pushHistory?.();
        this.doc.operations = ops;
        this.doc.emitChange();
        this.renderOps();
      },
    };

    for (let i = 0; i < this.doc.operations.length; i++) {
      const op = this.doc.operations[i];
      const item = buildOpItem(op, i, opItemCtx);
      if (op.id === this.highlighter.currentId) item.classList.add("tp-op-active");
      this.opsList.appendChild(item);
    }
    this.estimateManager.scheduleOpEstimates();
  }

  private openDialog(existing: CAMOperation | null): void {
    openOpDialog({
      doc: this.doc,
      existing,
      pushHistory: this.pushHistory,
      renderOps: () => this.renderOps(),
      highlightOp: (op) => {
        this.highlighter.highlightOp(op?.id ?? null);
        this.renderOps();
      },
    });
  }

  private toggleCollapse(): void {
    this.isCollapsed = !this.isCollapsed;
    this.host.classList.toggle("collapsed", this.isCollapsed);
  }
}
