/**
 * CAM / Toolpaths Side Panel.
 *
 * Coordinates the operations list, toolpath CRUD dialog, export workflows,
 * and machine integrations.
 */
import type { CADDocument } from "../model/document";
import type { StitchPreview, FlipPreview } from "../view/overlay";
import type { CAMOperation } from "../cam/types";
import { collectClosedLoops } from "../cam/loops";
import { resolveRegion } from "../cam/regions";
import { generateMaterialTest } from "../cam/materialTest";
import { buildJobFromLayers } from "../cam/laserJob";
import { openToolLibraryDialog } from "./toolLibraryDialog";
import { openLaserPresetsDialog } from "./laserPresetsDialog";
import { openFlipDialog } from "./flipDialog";
import { openStitchDialog } from "./stitchDialog";
import { openMaterialTestDialog } from "./materialTestDialog";
import { confirmDialog } from "./modal";
import { toast } from "./toast";
import { nextId } from "../model/ids";
import type { Vec2 } from "../core/vec2";
import { timeStamp } from "../cam/exportName";
import { generateGCode } from "../cam/gcode";
import { CamExportService } from "./camBar/camExportService";
import { OpEstimateManager } from "./camBar/opEstimateManager";
import { openOpDialog } from "./camBar/dialog/opDialog";
import { buildOpItem, TP_PALETTE } from "./camBar/opItemBuilder";

export class CamBar {
  private content!: HTMLElement;
  private opsList!: HTMLElement;
  private isCollapsed = false;
  private highlightedOpId: string | null = null;
  private dragState = { srcIndex: null as number | null };
  /** Transient selection of toolpaths for combined export. */
  private selectedOpIds = new Set<string>();

  private exportSelBtn: HTMLButtonElement | null = null;
  private libBtn: HTMLButtonElement | null = null;
  private testBtn: HTMLButtonElement | null = null;
  private presetBtn: HTMLButtonElement | null = null;
  private fromLayersBtn: HTMLButtonElement | null = null;
  private stitchBtn: HTMLButtonElement | null = null;
  private flipBtn: HTMLButtonElement | null = null;

  private exportService: CamExportService;
  private estimateManager: OpEstimateManager;

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

    this.build();
    doc.onChange(() => this.renderOps());
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
    testBtn.addEventListener("click", () => this.runMaterialTest());
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
    fromLayersBtn.addEventListener("click", () => void this.toolpathsFromLayers());
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

    const exportSelBtn = document.createElement("button");
    exportSelBtn.className = "cam-add-btn cam-export-sel-btn";
    exportSelBtn.style.cssText = "width:100%;margin-top:6px;display:none;";
    exportSelBtn.addEventListener("click", () => void this.exportService.exportSelected(this.selectedOpIds));
    this.exportSelBtn = exportSelBtn;
    this.content.appendChild(exportSelBtn);
    this.updateExportSelBtn();

    if (this.onStitchPreview) {
      const stitchBtn = document.createElement("button");
      stitchBtn.className = "cam-add-btn";
      stitchBtn.style.cssText = "width:100%;margin-top:6px;";
      stitchBtn.textContent = "Tile for small machine…";
      stitchBtn.title = "Split a design larger than the machine bed into per-tile G-code";
      stitchBtn.addEventListener("click", () => this.openStitch());
      this.content.appendChild(stitchBtn);
      this.stitchBtn = stitchBtn;
    }

    if (this.onFlipPreview) {
      const flipBtn = document.createElement("button");
      flipBtn.className = "cam-add-btn";
      flipBtn.style.cssText = "width:100%;margin-top:6px;";
      flipBtn.textContent = "Two-sided (flip)…";
      flipBtn.title = "Set up double-sided machining with registration pins";
      flipBtn.addEventListener("click", () => this.openFlip());
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

  private openFlip(): void {
    if (this.doc.machineKind !== "mill") {
      toast("Two-sided machining is for flat (non-rotary) milling jobs.");
      return;
    }
    openFlipDialog({
      doc: this.doc,
      pushHistory: this.pushHistory,
      onPreview: (p) => this.onFlipPreview?.(p),
      onDone: () => this.renderOps(),
    });
  }

  private openStitch(): void {
    if (this.doc.operations.length === 0) {
      toast("No toolpaths to tile — add some first.");
      return;
    }
    if (this.doc.machineKind !== "mill") {
      toast("Stitch tiling is for flat (non-rotary) milling jobs.");
      return;
    }
    const gcode = generateGCode(this.doc.operations, this.doc, this.exportService.gcodeOpts());
    openStitchDialog({
      gcode,
      doc: this.doc,
      baseName: `${this.exportService.projectName()}_tiles_${timeStamp()}`,
      onPreview: (p) => this.onStitchPreview?.(p),
    });
  }

  private updateExportSelBtn(): void {
    if (!this.exportSelBtn) return;
    const n = this.selectedOpIds.size;
    this.exportSelBtn.style.display = n > 0 ? "" : "none";
    this.exportSelBtn.textContent = `Export ${n} selected to one file`;
  }

  private renderOps(): void {
    const laser = this.doc.isLaser;
    if (this.libBtn) this.libBtn.style.display = laser ? "none" : "";
    if (this.testBtn) this.testBtn.style.display = laser ? "" : "none";
    if (this.presetBtn) this.presetBtn.style.display = laser ? "" : "none";
    if (this.fromLayersBtn) this.fromLayersBtn.style.display = laser ? "" : "none";
    this.updateModeButtons();

    const live = new Set(this.doc.operations.map((o) => o.id));
    for (const id of [...this.selectedOpIds]) if (!live.has(id)) this.selectedOpIds.delete(id);

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
      this.updateExportSelBtn();
      return;
    }

    const opItemCtx = {
      doc: this.doc,
      opsList: this.opsList,
      selectedOpIds: this.selectedOpIds,
      highlightedOpId: this.highlightedOpId,
      dragState: this.dragState,
      estimateManager: this.estimateManager,
      onHighlightOp: (id: string | null) => this.highlightOp(id),
      onToggleSelectOp: (id: string, selected: boolean) => {
        if (selected) this.selectedOpIds.add(id);
        else this.selectedOpIds.delete(id);
        this.updateExportSelBtn();
      },
      onEditOp: (op: CAMOperation) => this.openDialog(op),
      onDeleteOp: (op: CAMOperation) => {
        this.pushHistory?.();
        if (this.highlightedOpId === op.id) this.highlightOp(null);
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
      if (op.id === this.highlightedOpId) item.classList.add("tp-op-active");
      this.opsList.appendChild(item);
    }
    this.updateExportSelBtn();
    this.estimateManager.scheduleOpEstimates();
  }

  private highlightOp(id: string | null): void {
    this.highlightedOpId = id;
    const opIndex = id ? this.doc.operations.findIndex((o) => o.id === id) : -1;
    const op = opIndex >= 0 ? this.doc.operations[opIndex] : null;
    this.doc.toolpathHighlightColor = op ? TP_PALETTE[opIndex % TP_PALETTE.length] : null;
    if (op?.regions?.length) {
      const loops = collectClosedLoops(this.doc.entities);
      const highlight = new Set<string>();
      const fills: Vec2[][][] = [];
      for (const ref of op.regions) {
        const region = resolveRegion(ref, loops);
        if (!region) continue;
        for (const lid of region.loopIds) highlight.add(lid);
        fills.push([region.outer, ...region.holes]);
      }
      this.doc.toolpathHighlightIds = highlight;
      this.doc.regionPickFills = fills;
    } else {
      this.doc.toolpathHighlightIds = op ? new Set(op.entityIds) : null;
      this.doc.regionPickFills = null;
    }
    this.doc.emitChange();
    this.renderOps();
  }

  private openDialog(existing: CAMOperation | null): void {
    openOpDialog({
      doc: this.doc,
      existing,
      pushHistory: this.pushHistory,
      renderOps: () => this.renderOps(),
      highlightOp: (op) => this.highlightOp(op?.id ?? null),
    });
  }

  private async toolpathsFromLayers(): Promise<void> {
    const { operations, skipped } = buildJobFromLayers(this.doc);

    if (operations.length === 0) {
      const why = skipped.length
        ? skipped.map((s: { layer: string; why: string }) => `“${s.layer}” — ${s.why}`).join("; ")
        : "no layer has a job type yet";
      toast(`Nothing to build: ${why}. Set one with ⚡ in the Layers panel.`, 4200);
      return;
    }

    if (this.doc.operations.length > 0) {
      const ok = await confirmDialog({
        title: "Rebuild toolpaths from layers?",
        message:
          `This replaces the ${this.doc.operations.length} existing toolpath` +
          `${this.doc.operations.length > 1 ? "s" : ""} with ${operations.length} built from ` +
          `your layers (${operations.map((o: CAMOperation) => o.name).join(", ")}).\n\n` +
          "Any settings you changed on the existing toolpaths will be lost. Undo restores them.",
        confirmLabel: "Rebuild",
        danger: true,
      });
      if (!ok) return;
    }

    this.pushHistory?.();
    this.doc.operations = operations;
    this.doc.emitChange();
    this.renderOps();

    const note = skipped.length
      ? ` (skipped ${skipped.map((s: { layer: string; why: string }) => `“${s.layer}”: ${s.why}`).join("; ")})`
      : "";
    toast(
      `Built ${operations.length} toolpath${operations.length > 1 ? "s" : ""} from layers${note}.`,
      skipped.length ? 4200 : 2600,
    );
  }

  private runMaterialTest(): void {
    openMaterialTestDialog((cfg) => {
      const ts = Math.max(2, Math.min(cfg.cellSize * 0.4, 6));
      const origin = { x: ts * 3.2 + 5, y: ts + cfg.cellSize * 0.15 + 5 };
      const { entities, operations } = generateMaterialTest({ ...cfg, origin });
      if (entities.length === 0) return;

      this.pushHistory?.();
      for (const e of entities) {
        e.layerId = this.doc.activeLayerId;
        this.doc.entities.push(e);
      }
      this.doc.groups.push({
        id: nextId("group"),
        name: "Material Test",
        entityIds: entities.map((e) => e.id),
      });
      for (const op of operations) this.doc.operations.push(op);
      this.doc.emitChange();
      this.renderOps();
    });
  }

  private toggleCollapse(): void {
    this.isCollapsed = !this.isCollapsed;
    this.host.classList.toggle("collapsed", this.isCollapsed);
  }
}
