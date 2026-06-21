import type { CADDocument, GroupDef } from "../model/document";
import {
  type Entity,
  LineEntity,
  ArcEntity,
  BezierEntity,
  TextEntity,
} from "../model/entities";
import { textToContours } from "../cam/textOutlines";
import { signedArea } from "../cam/offset";
import type { Vec2 } from "../core/vec2";
import { formatLength } from "../core/units";
import { DEFAULTS, TOOL_TYPE_LABELS, selectedOpsInOrder, type CAMOperation, type CAMOpType, type ChamferSide, type CoolantMode, type LeadType, type ToolDef, type ToolType } from "../cam/types";
import { loadLibrary, addTool } from "../cam/toolLibrary";
import { openToolLibraryDialog } from "./toolLibraryDialog";
import { generateGCode } from "../cam/gcode";
import { getCustomGcode, getMachineHasCoolant } from "../core/prefs";
import { isFontResolvable } from "../core/fontManager";
import { groupLinesIntoClosedChains, collectClosedLoops, pointInPolygon } from "../cam/loops";
import { regionAtPoint, resolveRegion, interiorPoint } from "../cam/regions";
import { nextId } from "../model/ids";
import { track } from "../analytics";
import { StorageKeys } from "../core/storageKeys";
import {
  type OpCombo,
  AUTO_NAME_RE,
  comboOf,
  describeEntity,
  isValidFor,
  seedsFromEntityIds,
  legacyPocketSeeds,
  refsFromSeeds,
  seedsFromRegions,
  findContiguousChain,
} from "./camBarHelpers";

// ---- ToolpathsBar -----------------------------------------------------------

/** Mutable working copy of a CAM operation while the Add/Edit dialog is open. */
interface OpState {
  name: string;
  combo: OpCombo;
  /** Library tool this op references, or undefined for a one-off tool. */
  toolId?: string;
  toolType: ToolType;
  toolNumber: number;
  diameter: number;
  vAngle: number;
  tipAngle: number;
  feedrate: number;
  plungeRate: number;
  spindleSpeed: number;
  safeZ: number;
  depth: number;
  stepdown: number;
  entityIds: Set<string>;
  islandIds: Set<string>;
  regionSeeds: Vec2[];
  tabsEnabled: boolean;
  tabCount: number;
  tabWidth: number;
  tabHeight: number;
  stepover: number;
  pocketStrategy: "offset" | "raster";
  leadInType: LeadType;
  leadInLen: number;
  leadOutType: LeadType;
  leadOutLen: number;
}

/**
 * Late-bound callbacks shared between dialog sections. The tool-section inputs
 * trigger the cut-section V-bit hint, which is created later; the hook starts as
 * a no-op and is overwritten when the cut section builds it.
 */
interface DialogHooks {
  updateVBitHint(): void;
  /** Set the tool type from outside the tool section (e.g. force V-bit for chamfer). */
  setToolType(t: ToolType): void;
}

const TP_PALETTE = [
  "#4aa3ff", "#f59e42", "#4cdc9a", "#e05a9f",
  "#b97cf5", "#f5e04c", "#5ad8e0", "#f55a5a",
];

export class CamBar {
  private content!: HTMLElement;
  private opsList!: HTMLElement;
  private isCollapsed = false;
  private highlightedOpId: string | null = null;
  private dragSrcIdx: number | null = null;
  /** Transient (not persisted) selection of toolpaths for a combined export. */
  private selectedOpIds = new Set<string>();
  private exportSelBtn: HTMLButtonElement | null = null;

  constructor(
    private host: HTMLElement,
    private doc: CADDocument,
    private pushHistory?: () => void,
  ) {
    this.build();
    // Re-render the ops list whenever the document is replaced (file open, undo/redo).
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
    this.renderOps();

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
    libBtn.addEventListener("click", () => openToolLibraryDialog());
    btnRow.appendChild(libBtn);

    this.content.appendChild(btnRow);

    const sep = document.createElement("div");
    sep.className = "cam-sep";
    this.content.appendChild(sep);

    const genBtn = document.createElement("button");
    genBtn.className = "cam-gen-btn";
    genBtn.textContent = "Generate G-code";
    genBtn.addEventListener("click", () => this.generate());
    this.content.appendChild(genBtn);

    // Export a chosen subset of toolpaths into a single file (e.g. all the ops
    // that share a tool). Appears only when ≥1 toolpath is checked.
    const exportSelBtn = document.createElement("button");
    exportSelBtn.className = "cam-add-btn cam-export-sel-btn";
    exportSelBtn.style.cssText = "width:100%;margin-top:6px;display:none;";
    exportSelBtn.addEventListener("click", () => this.exportSelected());
    this.exportSelBtn = exportSelBtn;
    this.content.appendChild(exportSelBtn);
    this.updateExportSelBtn();
  }

  private updateExportSelBtn(): void {
    if (!this.exportSelBtn) return;
    const n = this.selectedOpIds.size;
    this.exportSelBtn.style.display = n > 0 ? "" : "none";
    this.exportSelBtn.textContent = `Export ${n} selected to one file`;
  }

  private exportSelected(): void {
    const ops = selectedOpsInOrder(this.doc.operations, this.selectedOpIds);
    if (ops.length === 0) return;
    track("gcode_generated", { operation_count: ops.length, subset: true });
    this.download(generateGCode(ops, this.doc, this.gcodeOpts()), "toolpaths-selected");
  }

  // --- list rendering --------------------------------------------------------

  private renderOps(): void {
    // Drop selections for ops that no longer exist (deleted).
    const live = new Set(this.doc.operations.map((o) => o.id));
    for (const id of [...this.selectedOpIds]) if (!live.has(id)) this.selectedOpIds.delete(id);

    this.opsList.innerHTML = "";
    if (this.doc.operations.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cam-ops-empty";
      empty.textContent = "No toolpaths yet";
      this.opsList.appendChild(empty);
      this.updateExportSelBtn();
      return;
    }
    for (let i = 0; i < this.doc.operations.length; i++) {
      const op = this.doc.operations[i];
      const item = this.buildOpItem(op, i);
      if (op.id === this.highlightedOpId) item.classList.add("tp-op-active");
      this.opsList.appendChild(item);
    }
    this.updateExportSelBtn();
  }

  private highlightOp(id: string | null): void {
    this.highlightedOpId = id;
    const opIndex = id ? this.doc.operations.findIndex(o => o.id === id) : -1;
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

  private buildOpItem(op: CAMOperation, index: number): HTMLElement {
    const item = document.createElement("div");
    item.className = "tp-op-item";
    item.draggable = true;

    item.addEventListener("dragstart", (e) => {
      this.dragSrcIdx = index;
      e.dataTransfer!.effectAllowed = "move";
      item.classList.add("tp-dragging");
    });
    item.addEventListener("dragend", () => {
      this.dragSrcIdx = null;
      item.classList.remove("tp-dragging");
      this.opsList.querySelectorAll(".tp-drag-over-top,.tp-drag-over-bottom").forEach(
        el => el.classList.remove("tp-drag-over-top", "tp-drag-over-bottom"),
      );
    });
    item.addEventListener("dragover", (e) => {
      if (this.dragSrcIdx === null) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
      this.opsList.querySelectorAll(".tp-drag-over-top,.tp-drag-over-bottom").forEach(
        el => el.classList.remove("tp-drag-over-top", "tp-drag-over-bottom"),
      );
      const rect = item.getBoundingClientRect();
      item.classList.add(e.clientY < rect.top + rect.height / 2 ? "tp-drag-over-top" : "tp-drag-over-bottom");
    });
    item.addEventListener("dragleave", (e) => {
      if (!item.contains(e.relatedTarget as Node))
        item.classList.remove("tp-drag-over-top", "tp-drag-over-bottom");
    });
    item.addEventListener("drop", (e) => {
      e.preventDefault();
      item.classList.remove("tp-drag-over-top", "tp-drag-over-bottom");
      const src = this.dragSrcIdx;
      if (src === null || src === index) return;
      const insertBefore = e.clientY < item.getBoundingClientRect().top + item.getBoundingClientRect().height / 2;
      const ops = [...this.doc.operations];
      const [moved] = ops.splice(src, 1);
      let tgt = src < index ? index - 1 : index;
      ops.splice(insertBefore ? tgt : tgt + 1, 0, moved);
      this.pushHistory?.();
      this.doc.operations = ops;
      this.doc.emitChange();
      this.renderOps();
    });

    item.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".tp-icon-btn,.tp-drag-handle")) return;
      this.highlightOp(this.highlightedOpId === op.id ? null : op.id);
    });

    const opColor = TP_PALETTE[index % TP_PALETTE.length];
    item.style.setProperty("--tp-color", opColor);

    const sel = document.createElement("input");
    sel.type = "checkbox";
    sel.className = "tp-select";
    sel.title = "Select for combined export";
    sel.checked = this.selectedOpIds.has(op.id);
    sel.addEventListener("click", (e) => e.stopPropagation());
    sel.addEventListener("change", () => {
      if (sel.checked) this.selectedOpIds.add(op.id);
      else this.selectedOpIds.delete(op.id);
      this.updateExportSelBtn();
    });
    item.appendChild(sel);

    const handle = document.createElement("span");
    handle.className = "tp-drag-handle";
    handle.textContent = "⠿";
    handle.title = "Drag to reorder";
    item.appendChild(handle);

    const swatch = document.createElement("span");
    swatch.className = "tp-color-swatch";
    item.appendChild(swatch);

    const badge = document.createElement("span");
    badge.className = `tp-badge tp-badge-${op.type}`;
    badge.textContent =
      op.type === "profile" ? (op.side === "outside" ? "OUT" : "IN")
      : op.type === "pocket"  ? "PKT"
      : op.type === "engrave" ? "ENG"
      : op.type === "chamfer" ? "CHM"
      : op.type === "vcarve"  ? "VCV"
      : "DRL";
    item.appendChild(badge);

    const info = document.createElement("div");
    info.className = "tp-op-info";
    const nameEl = document.createElement("div");
    nameEl.className = "tp-op-name";
    nameEl.textContent = op.name;
    const params = document.createElement("div");
    params.className = "tp-op-params";
    const toolLabel = op.toolType === "v-bit" ? `V-Bit(${op.vAngle ?? 60}°)`
      : op.toolType === "drill" ? "Drill"
      : op.toolType === "ball-nose" ? "Ball Nose"
      : "End Mill";
    params.textContent = `T${op.toolNumber} ⌀${op.diameter}mm ${toolLabel}  ${op.depth}mm`;
    info.appendChild(nameEl);
    info.appendChild(params);
    item.appendChild(info);

    const dlBtn = document.createElement("button");
    dlBtn.className = "tp-icon-btn";
    dlBtn.title = "Export this toolpath";
    dlBtn.innerHTML =
      `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">` +
      `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>` +
      `<polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>` +
      `</svg>`;
    dlBtn.addEventListener("click", () => {
      const code = generateGCode([op], this.doc, this.gcodeOpts());
      this.download(code, op.name);
    });
    item.appendChild(dlBtn);

    const editBtn = document.createElement("button");
    editBtn.className = "tp-icon-btn";
    editBtn.title = "Edit";
    editBtn.innerHTML =
      `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">` +
      `<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>` +
      `<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>` +
      `</svg>`;
    editBtn.addEventListener("click", () => this.openDialog(op));
    item.appendChild(editBtn);

    const delBtn = document.createElement("button");
    delBtn.className = "tp-icon-btn tp-icon-del";
    delBtn.title = "Delete";
    delBtn.innerHTML =
      `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">` +
      `<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>` +
      `<path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>` +
      `</svg>`;
    delBtn.addEventListener("click", () => {
      this.pushHistory?.();
      if (this.highlightedOpId === op.id) this.highlightOp(null);
      this.doc.operations = this.doc.operations.filter((o) => o.id !== op.id);
      this.doc.emitChange();
      this.renderOps();
    });
    item.appendChild(delBtn);

    return item;
  }

  // --- dialog ----------------------------------------------------------------

  private openDialog(existing: CAMOperation | null): void {
    document.getElementById("tp-dialog-backdrop")?.remove();
    this.highlightOp(null); // dialog manages toolpathHighlightIds from here

    const isNew = existing === null;
    const preSelected = new Set(
      this.doc.entities.filter((e) => e.selected && !e.isConstruction).map((e) => e.id),
    );

    const initialCombo: OpCombo = existing ? comboOf(existing) : "profile-outside";
    const state = {
      name: existing?.name ?? this.autoName(initialCombo),
      combo: initialCombo,
      toolId: existing?.toolId,
      toolType: (existing?.toolType ?? DEFAULTS.toolType) as ToolType,
      toolNumber: existing?.toolNumber ?? DEFAULTS.toolNumber,
      diameter: existing?.diameter ?? DEFAULTS.diameter,
      vAngle: existing?.vAngle ?? DEFAULTS.vAngle,
      tipAngle: existing?.tipAngle ?? DEFAULTS.tipAngle,
      feedrate: existing?.feedrate ?? DEFAULTS.feedrate,
      plungeRate: existing?.plungeRate ?? DEFAULTS.plungeRate,
      spindleSpeed: existing?.spindleSpeed ?? DEFAULTS.spindleSpeed,
      safeZ: existing?.safeZ ?? DEFAULTS.safeZ,
      depth: existing?.depth ?? DEFAULTS.depth,
      stepdown: existing?.stepdown ?? DEFAULTS.stepdown,
      peckDepth: existing?.peckDepth ?? DEFAULTS.peckDepth,
      finishPass: existing?.finishPass ?? false,
      finishAllowance: existing?.finishAllowance ?? DEFAULTS.finishAllowance,
      chamferWidth: existing?.chamferWidth ?? DEFAULTS.chamferWidth,
      chamferSide: (existing?.chamferSide ?? DEFAULTS.chamferSide) as ChamferSide,
      sharpenCorners: existing?.sharpenCorners ?? false,
      vStep: existing?.vStep ?? DEFAULTS.vStep,
      coolant: (existing?.coolant ?? DEFAULTS.coolant) as CoolantMode,
      entityIds:    new Set<string>(existing?.entityIds ?? [...preSelected]),
      islandIds:    new Set<string>(existing?.islandIds ?? []),
      regionSeeds:  existing?.regions?.length
        ? seedsFromRegions(this.doc, existing.regions)
        : existing && comboOf(existing) === "pocket"
          ? legacyPocketSeeds(existing, this.doc)
          : ([] as Vec2[]),
      tabsEnabled:  existing?.tabs?.enabled ?? false,
      tabCount:     existing?.tabs?.count   ?? 4,
      tabWidth:     existing?.tabs?.width   ?? 4,
      tabHeight:    existing?.tabs?.height  ?? 2,
      stepover:     existing?.stepover ?? DEFAULTS.stepover,
      pocketStrategy: (existing?.pocketStrategy ?? "offset") as "offset" | "raster",
      leadInType:   (existing?.leadIn?.type  ?? "none") as LeadType,
      leadInLen:    existing?.leadIn?.length  ?? 2,
      leadOutType:  (existing?.leadOut?.type ?? "none") as LeadType,
      leadOutLen:   existing?.leadOut?.length ?? 2,
    };

    let geomCleanup: () => void = () => {};

    const closeDialog = () => {
      geomCleanup();
      this.doc.regionPickHandler = null;
      this.doc.regionHoverHandler = null;
      this.doc.regionPickFills = null;
      this.doc.regionPickHoverFill = null;
      this.doc.toolpathHighlightIds = null;
      this.doc.emitChange();
      document.getElementById("tp-dialog-backdrop")?.remove();
    };

    // Late-bound cross-section callbacks (see DialogHooks).
    const hooks: DialogHooks = { updateVBitHint: () => {}, setToolType: () => {} };

    // --- backdrop + draggable dialog shell ---
    const { backdrop, dialog, body } = this.buildDialogShell(isNew, closeDialog);

    // name
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "dim tp-name-input";
    nameInput.value = state.name;
    nameInput.addEventListener("input", () => { state.name = nameInput.value; });
    body.appendChild(this.dField("Name", nameInput));

    // type
    const typeSelect = document.createElement("select");
    typeSelect.className = "unit";
    const combos: [OpCombo, string][] = [
      ["profile-outside", "Profile (outside)"],
      ["profile-inside",  "Profile (inside)"],
      ["pocket",          "Pocket (interior clear)"],
      ["chamfer",         "Chamfer (V-bevel edge)"],
      ["vcarve",          "V-Carve (text/shape)"],
      ["engrave",         "Engrave"],
      ["drill",           "Drill"],
    ];
    for (const [v, l] of combos) {
      const o = document.createElement("option");
      o.value = v; o.textContent = l;
      typeSelect.appendChild(o);
    }
    typeSelect.value = state.combo;
    body.appendChild(this.dField("Type", typeSelect));

    // tool section (collapsible — starts collapsed when editing an existing op)
    body.appendChild(this.buildToolSection(state, hooks, isNew));

    // cut section
    const cutSec = this.dSection("Cut");
    const depthRow = document.createElement("div");
    depthRow.className = "tp-depth-row";
    const depthInp = document.createElement("input");
    depthInp.type = "number"; depthInp.className = "dim"; depthInp.step = "any";
    depthInp.value = String(state.depth);
    depthInp.addEventListener("change", () => {
      const v = parseFloat(depthInp.value); if (isFinite(v)) { state.depth = v; hooks.updateVBitHint(); }
    });
    const throughBtn = document.createElement("button");
    throughBtn.className = "cbtn";
    throughBtn.textContent = "⊥ stock";
    throughBtn.title = `Set to stock thickness (${this.doc.stockThickness}mm)`;
    throughBtn.addEventListener("click", () => {
      state.depth = -this.doc.stockThickness;
      depthInp.value = String(state.depth);
    });
    depthRow.appendChild(depthInp);
    depthRow.appendChild(throughBtn);
    cutSec.appendChild(this.dField("Depth (mm)", depthRow));

    // V-bit effective width hint
    const vbitHint = document.createElement("div");
    vbitHint.style.cssText = "font-size:11px;color:var(--accent);padding:3px 0 4px 0;display:none;";
    cutSec.appendChild(vbitHint);

    hooks.updateVBitHint = () => {
      if (state.toolType !== "v-bit" || state.combo !== "engrave") {
        vbitHint.style.display = "none";
        return;
      }
      const halfAngle = (state.vAngle / 2) * (Math.PI / 180);
      const width = 2 * Math.abs(state.depth) * Math.tan(halfAngle);
      vbitHint.textContent = `→ effective cut width: ${width.toFixed(3)} mm`;
      vbitHint.style.display = "block";
    };
    hooks.updateVBitHint();

    const stepInp = document.createElement("input");
    stepInp.type = "number"; stepInp.className = "dim"; stepInp.step = "any";
    stepInp.value = String(state.stepdown);
    stepInp.addEventListener("change", () => {
      const v = parseFloat(stepInp.value); if (isFinite(v)) state.stepdown = v;
    });
    const stepRow = this.dField("Stepdown (mm)", stepInp);
    cutSec.appendChild(stepRow);

    // Peck depth — drill ops only. 0 = single full-depth plunge.
    const peckInp = document.createElement("input");
    peckInp.type = "number"; peckInp.className = "dim"; peckInp.step = "any"; peckInp.min = "0";
    peckInp.value = String(state.peckDepth);
    peckInp.addEventListener("change", () => {
      const v = parseFloat(peckInp.value); state.peckDepth = isFinite(v) && v > 0 ? v : 0;
    });
    const peckRow = this.dField("Peck depth (mm, 0=off)", peckInp);
    cutSec.appendChild(peckRow);

    const stepoverInp = document.createElement("input");
    stepoverInp.type = "number"; stepoverInp.className = "dim"; stepoverInp.step = "any";
    stepoverInp.min = "0.01"; stepoverInp.max = "1";
    stepoverInp.value = String(state.stepover);
    stepoverInp.addEventListener("change", () => {
      const v = parseFloat(stepoverInp.value); if (isFinite(v)) state.stepover = Math.min(1, Math.max(0.01, v));
    });
    const stepoverRow = this.dField("Stepover (0–1)", stepoverInp);
    cutSec.appendChild(stepoverRow);

    // V-carve pitch — radial inset between offset-peel passes (mm). Smaller =
    // smoother floor, more passes. Depth field acts as the max (floor) depth.
    const vStepInp = document.createElement("input");
    vStepInp.type = "number"; vStepInp.className = "dim"; vStepInp.step = "any"; vStepInp.min = "0.01";
    vStepInp.value = String(state.vStep);
    vStepInp.addEventListener("change", () => {
      const v = parseFloat(vStepInp.value); if (isFinite(v) && v > 0) state.vStep = v;
    });
    const vStepRow = this.dField("V-carve pitch (mm)", vStepInp);
    cutSec.appendChild(vStepRow);

    const strategySelect = document.createElement("select");
    strategySelect.className = "unit";
    for (const [v, l] of [["offset", "Adaptive (contour-parallel)"], ["raster", "Raster (zig-zag)"]] as const) {
      const o = document.createElement("option");
      o.value = v; o.textContent = l;
      strategySelect.appendChild(o);
    }
    strategySelect.value = state.pocketStrategy;
    strategySelect.addEventListener("change", () => {
      state.pocketStrategy = strategySelect.value as "offset" | "raster";
    });
    const strategyRow = this.dField("Clearing", strategySelect);
    cutSec.appendChild(strategyRow);

    // Finishing pass — profile + pocket only. Leaves an allowance during
    // roughing and removes it in a final full-depth wall lap.
    const finishChk = document.createElement("input");
    finishChk.type = "checkbox";
    finishChk.className = "settings-checkbox";
    finishChk.checked = state.finishPass;
    const finishRow = this.dField("Finishing pass", finishChk);
    cutSec.appendChild(finishRow);

    const finishAllowInp = document.createElement("input");
    finishAllowInp.type = "number"; finishAllowInp.className = "dim"; finishAllowInp.step = "any"; finishAllowInp.min = "0";
    finishAllowInp.value = String(state.finishAllowance);
    finishAllowInp.addEventListener("change", () => {
      const v = parseFloat(finishAllowInp.value); state.finishAllowance = isFinite(v) && v >= 0 ? v : 0;
    });
    const finishAllowRow = this.dField("Finish allowance (mm)", finishAllowInp);
    cutSec.appendChild(finishAllowRow);

    finishChk.addEventListener("change", () => {
      state.finishPass = finishChk.checked;
      finishAllowRow.style.display = finishChk.checked ? "" : "none";
    });

    // Chamfer — width (bevel face) + side. Depth is derived from the V-bit angle.
    const chamWidthInp = document.createElement("input");
    chamWidthInp.type = "number"; chamWidthInp.className = "dim"; chamWidthInp.step = "any"; chamWidthInp.min = "0";
    chamWidthInp.value = String(state.chamferWidth);
    const chamHint = document.createElement("div");
    chamHint.className = "cam-vbit-hint";
    const updateChamHint = () => {
      const half = Math.tan(((state.vAngle ?? 60) / 2) * (Math.PI / 180));
      const depth = half > 1e-6 ? state.chamferWidth / half : 0;
      chamHint.textContent = `→ depth ${depth.toFixed(2)} mm · face ${(90 - (state.vAngle ?? 60) / 2).toFixed(0)}° from top`;
    };
    chamWidthInp.addEventListener("input", () => {
      const v = parseFloat(chamWidthInp.value); if (isFinite(v) && v >= 0) state.chamferWidth = v;
      updateChamHint();
    });
    const chamWidthRow = this.dField("Chamfer width (mm)", chamWidthInp);
    cutSec.appendChild(chamWidthRow);
    cutSec.appendChild(chamHint);

    const chamSideSelect = document.createElement("select");
    chamSideSelect.className = "unit";
    for (const [v, l] of [["on", "On edge (centred)"], ["outside", "Outside"], ["inside", "Inside"]] as const) {
      const o = document.createElement("option");
      o.value = v; o.textContent = l;
      chamSideSelect.appendChild(o);
    }
    chamSideSelect.value = state.chamferSide;
    chamSideSelect.addEventListener("change", () => { state.chamferSide = chamSideSelect.value as ChamferSide; });
    const chamSideRow = this.dField("Bevel side", chamSideSelect);
    cutSec.appendChild(chamSideRow);

    const sharpenChk = document.createElement("input");
    sharpenChk.type = "checkbox";
    sharpenChk.className = "settings-checkbox";
    sharpenChk.checked = state.sharpenCorners;
    sharpenChk.addEventListener("change", () => { state.sharpenCorners = sharpenChk.checked; });
    const sharpenRow = this.dField("Sharpen corners", sharpenChk);
    cutSec.appendChild(sharpenRow);
    updateChamHint();
    // Keep the chamfer depth readout in sync when the V-bit angle changes.
    const baseVBitHint = hooks.updateVBitHint;
    hooks.updateVBitHint = () => { baseVBitHint(); updateChamHint(); };

    const updateChamferVisibility = () => {
      const show = state.combo === "chamfer";
      chamWidthRow.style.display = show ? "" : "none";
      chamHint.style.display = show ? "" : "none";
      chamSideRow.style.display = show ? "" : "none";
      sharpenRow.style.display = show ? "" : "none";
    };

    // Coolant — per operation, shown only when the machine has coolant (a
    // machine-wide capability). Off/Mist (M7)/Flood (M8).
    if (getMachineHasCoolant()) {
      const coolantSelect = document.createElement("select");
      coolantSelect.className = "unit";
      for (const [v, l] of [["off", "Off"], ["mist", "Mist (M7)"], ["flood", "Flood (M8)"]] as const) {
        const o = document.createElement("option");
        o.value = v; o.textContent = l;
        coolantSelect.appendChild(o);
      }
      coolantSelect.value = state.coolant;
      coolantSelect.addEventListener("change", () => {
        state.coolant = coolantSelect.value as CoolantMode;
      });
      cutSec.appendChild(this.dField("Coolant", coolantSelect));
    }

    body.appendChild(cutSec);

    // tabs section — profile ops only
    const tabs = this.buildTabsSection(state);
    body.appendChild(tabs.root);
    const updateTabsVisibility = tabs.update;

    // lead-in / lead-out section (profile ops only)
    const lead = this.buildLeadSection(state);
    body.appendChild(lead.root);
    const updateLeadVisibility = lead.update;

    // geometry section
    const geom = this.buildGeometrySection(state);
    body.appendChild(geom.root);
    const { renderEntities, ensurePocketSeeds, startPickMode, stopPickMode, getPickActive } = geom;
    geomCleanup = geom.cleanup;

    typeSelect.addEventListener("change", () => {
      state.combo = typeSelect.value as OpCombo;
      // If the name is still an untouched auto-generated default, rename it
      // to match the newly chosen type.
      if (AUTO_NAME_RE.test(state.name.trim())) {
        state.name = this.autoName(state.combo);
        nameInput.value = state.name;
      }
      if (getPickActive()) stopPickMode(); // pick behaviour differs per op type
      stepRow.style.display     = state.combo === "drill" || state.combo === "vcarve" ? "none" : "";
      peckRow.style.display     = state.combo === "drill"   ? "" : "none";
      stepoverRow.style.display = state.combo === "pocket"  ? "" : "none";
      strategyRow.style.display = state.combo === "pocket"  ? "" : "none";
      vStepRow.style.display    = state.combo === "vcarve"  ? "" : "none";
      const showFinish = state.combo.startsWith("profile") || state.combo === "pocket";
      finishRow.style.display      = showFinish ? "" : "none";
      finishAllowRow.style.display = showFinish && state.finishPass ? "" : "none";
      updateChamferVisibility();
      // Chamfer and v-carve both need a V-bit (the cut angle comes from the tool).
      if ((state.combo === "chamfer" || state.combo === "vcarve") && state.toolType !== "v-bit")
        hooks.setToolType("v-bit");
      hooks.updateVBitHint();
      updateTabsVisibility();
      updateLeadVisibility();
      if (state.combo === "pocket") {
        ensurePocketSeeds();
        startPickMode(); // pocket picking is canvas-driven — make it live immediately
      }
      renderEntities();
    });
    stepRow.style.display     = state.combo === "drill" || state.combo === "vcarve" ? "none" : "";
    peckRow.style.display     = state.combo === "drill"   ? "" : "none";
    stepoverRow.style.display = state.combo === "pocket"  ? "" : "none";
    strategyRow.style.display = state.combo === "pocket"  ? "" : "none";
    vStepRow.style.display    = state.combo === "vcarve"  ? "" : "none";
    {
      const showFinish = state.combo.startsWith("profile") || state.combo === "pocket";
      finishRow.style.display      = showFinish ? "" : "none";
      finishAllowRow.style.display = showFinish && state.finishPass ? "" : "none";
    }
    updateChamferVisibility();
    updateTabsVisibility();
    updateLeadVisibility();
    if (state.combo === "pocket") {
      ensurePocketSeeds();
      startPickMode();
    }
    renderEntities();

    // footer
    const footer = document.createElement("div");
    footer.className = "tp-dialog-footer";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn"; cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => closeDialog());
    const applyBtn = document.createElement("button");
    applyBtn.className = "btn tp-apply-btn"; applyBtn.textContent = "Apply";
    applyBtn.addEventListener("click", () => {
      let ids = [...state.entityIds];
      // Pocket must be region-picked. V-carve may be region-picked OR driven by
      // selected entities (text/closed shapes); regions win when both exist.
      if (state.combo === "pocket" && state.regionSeeds.length === 0) {
        alert("Pick at least one enclosed area."); return;
      }
      const regionBased =
        (state.combo === "pocket" || state.combo === "vcarve") && state.regionSeeds.length > 0;
      if (regionBased) {
        // Store the bounding loops' ids for ops-list hover highlighting.
        const loops = collectClosedLoops(this.doc.entities);
        const hl = new Set<string>();
        for (const seed of state.regionSeeds) {
          const region = regionAtPoint(seed, loops);
          if (region) for (const id of region.loopIds) hl.add(id);
        }
        ids = [...hl];
      } else if (ids.length === 0) {
        alert("Select at least one geometry item.");
        return;
      }

      this.pushHistory?.();

      let type: CAMOpType, side: "outside" | "inside";
      if (state.combo === "profile-outside") { type = "profile"; side = "outside"; }
      else if (state.combo === "profile-inside") { type = "profile"; side = "inside"; }
      else if (state.combo === "pocket") { type = "pocket"; side = "outside"; }
      else if (state.combo === "chamfer") { type = "chamfer"; side = "outside"; }
      else if (state.combo === "vcarve") { type = "vcarve"; side = "outside"; }
      else if (state.combo === "engrave") { type = "engrave"; side = "outside"; }
      else { type = "drill"; side = "outside"; }

      const isProfile = type === "profile";

      const op: CAMOperation = {
        id: existing?.id ?? nextId("cam"),
        name: state.name || this.autoName(state.combo),
        type, side, entityIds: ids,
        toolId: state.toolId,
        toolType: state.toolType,
        toolNumber: state.toolNumber,
        diameter: state.diameter,
        vAngle: state.toolType === "v-bit" ? state.vAngle : undefined,
        tipAngle: state.toolType === "drill" ? state.tipAngle : undefined,
        feedrate: state.feedrate,
        plungeRate: state.plungeRate, spindleSpeed: state.spindleSpeed,
        safeZ: state.safeZ, depth: state.depth, stepdown: state.stepdown,
        stepover: state.stepover,
        peckDepth: type === "drill" && state.peckDepth > 0 ? state.peckDepth : undefined,
        finishPass: (type === "profile" || type === "pocket") && state.finishPass ? true : undefined,
        finishAllowance: (type === "profile" || type === "pocket") && state.finishPass ? state.finishAllowance : undefined,
        chamferWidth: type === "chamfer" ? state.chamferWidth : undefined,
        chamferSide: type === "chamfer" ? state.chamferSide : undefined,
        sharpenCorners: type === "chamfer" && state.sharpenCorners ? true : undefined,
        vStep: type === "vcarve" ? state.vStep : undefined,
        coolant: state.coolant !== "off" ? state.coolant : undefined,
        pocketStrategy: type === "pocket" ? state.pocketStrategy : undefined,
        regions: regionBased
          ? refsFromSeeds(this.doc, state.regionSeeds)
          : undefined,
        tabs: isProfile ? {
          enabled: state.tabsEnabled,
          count:   state.tabCount,
          width:   state.tabWidth,
          height:  state.tabHeight,
        } : undefined,
        leadIn:  isProfile && state.leadInType  !== "none" ? { type: state.leadInType,  length: state.leadInLen  } : undefined,
        leadOut: isProfile && state.leadOutType !== "none" ? { type: state.leadOutType, length: state.leadOutLen } : undefined,
      };

      if (existing) {
        const idx = this.doc.operations.findIndex((o) => o.id === existing.id);
        if (idx >= 0) this.doc.operations[idx] = op;
      } else {
        this.doc.operations.push(op);
      }
      this.doc.emitChange();
      this.renderOps();
      closeDialog();
    });
    footer.appendChild(cancelBtn);
    footer.appendChild(applyBtn);
    dialog.appendChild(footer);

    document.body.appendChild(backdrop);
    setTimeout(() => nameInput.select(), 40);
  }

  // --- G-code generation -----------------------------------------------------

  /** Map the machine-wide custom-G-code preference into generator options. */
  private gcodeOpts() {
    const g = getCustomGcode();
    return { customStart: g.start, customEnd: g.end, coolantSupported: getMachineHasCoolant() };
  }

  private generate(): void {
    if (this.doc.operations.length === 0) { alert("Add at least one toolpath first."); return; }
    // Text whose font can't be resolved produces no toolpath geometry. Surface
    // that as an explicit choice rather than silently omitting it from the cut.
    const missing = this.missingFontText();
    if (missing.length > 0) {
      const list = missing.map((t) => `  • "${t.text}"`).join("\n");
      const ok = confirm(
        `${missing.length} text item${missing.length > 1 ? "s" : ""} use a font that isn't ` +
        `available and will be OMITTED from the G-code:\n\n${list}\n\nGenerate anyway?`,
      );
      if (!ok) return;
    }
    track("gcode_generated", { operation_count: this.doc.operations.length });
    this.download(generateGCode(this.doc.operations, this.doc, this.gcodeOpts()), "toolpaths");
  }

  /** Text entities targeted by an operation whose font can't be resolved. */
  private missingFontText(): TextEntity[] {
    const targeted = new Set(this.doc.operations.flatMap((o) => o.entityIds));
    return this.doc.entities.filter(
      (e): e is TextEntity =>
        e instanceof TextEntity && targeted.has(e.id) && !isFontResolvable(e.fontId),
    );
  }

  private download(code: string, name: string): void {
    const safe = name.replace(/[^a-z0-9_\-]/gi, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
    const blob = new Blob([code], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safe || "toolpath"}.nc`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // --- helpers ---------------------------------------------------------------

  private autoName(combo: OpCombo): string {
    const prefix =
      combo === "profile-outside" ? "Profile (outside)"
      : combo === "profile-inside" ? "Profile (inside)"
      : combo === "pocket"  ? "Pocket"
      : combo === "chamfer" ? "Chamfer"
      : combo === "vcarve"  ? "V-Carve"
      : combo === "engrave" ? "Engrave"
      : "Drill";
    const n = this.doc.operations.filter((o) => comboOf(o) === combo).length + 1;
    return `${prefix} ${n}`;
  }

  private toggleCollapse(): void {
    this.isCollapsed = !this.isCollapsed;
    this.host.classList.toggle("collapsed", this.isCollapsed);
  }

  private dSection(title: string): HTMLElement {
    const sec = document.createElement("div");
    sec.className = "tp-dialog-section";
    const h = document.createElement("div");
    h.className = "tp-dialog-section-title";
    h.textContent = title;
    sec.appendChild(h);
    return sec;
  }

  private dField(label: string, control: HTMLElement): HTMLElement {
    const g = document.createElement("div");
    g.className = "tp-field";
    const l = document.createElement("label");
    l.textContent = label;
    g.appendChild(l);
    g.appendChild(control);
    return g;
  }

  /** Labelled number input that writes through `set` on change. */
  private numRow(label: string, get: () => number, set: (v: number) => void): { el: HTMLElement; inp: HTMLInputElement } {
    const inp = document.createElement("input");
    inp.type = "number"; inp.className = "dim"; inp.step = "any";
    inp.value = String(get());
    inp.addEventListener("change", () => { const v = parseFloat(inp.value); if (isFinite(v)) set(v); });
    return { el: this.dField(label, inp), inp };
  }

  /** Like numRow, but `set` also receives the input so a ToolDef load can repopulate it. */
  private syncableInput(label: string, get: () => number, set: (v: number, inp: HTMLInputElement) => void): { el: HTMLElement; inp: HTMLInputElement } {
    const inp = document.createElement("input");
    inp.type = "number"; inp.className = "dim"; inp.step = "any";
    inp.value = String(get());
    inp.addEventListener("change", () => { const v = parseFloat(inp.value); if (isFinite(v)) set(v, inp); });
    return { el: this.dField(label, inp), inp };
  }

  // --- Add/Edit dialog section builders --------------------------------------

  /** Backdrop + draggable dialog frame (header, close, body). */
  private buildDialogShell(isNew: boolean, onClose: () => void): { backdrop: HTMLElement; dialog: HTMLElement; body: HTMLElement } {
    const backdrop = document.createElement("div");
    backdrop.id = "tp-dialog-backdrop";
    backdrop.className = "tp-backdrop";
    backdrop.style.pointerEvents = "none";
    backdrop.style.background = "none";

    const dialog = document.createElement("div");
    dialog.className = "tp-dialog";
    dialog.style.pointerEvents = "auto";
    dialog.addEventListener("click", (e) => e.stopPropagation());
    backdrop.appendChild(dialog);

    // Position: restore the last dragged position; otherwise default to the right
    // side of the screen (just left of the right-hand panel). Once the user drags
    // it, that position is remembered (localStorage) and wins on the next open.
    const DIALOG_W = 380; // matches .tp-dialog width in style.css
    const applyPos = (left: number, top: number) => {
      const maxLeft = Math.max(0, window.innerWidth - 100);
      const maxTop = Math.max(0, window.innerHeight - 50);
      dialog.style.position = "absolute";
      dialog.style.margin = "0";
      dialog.style.left = Math.max(0, Math.min(left, maxLeft)) + "px";
      dialog.style.top = Math.max(0, Math.min(top, maxTop)) + "px";
    };

    let positioned = false;
    const storedPos = localStorage.getItem(StorageKeys.toolpathDialogPosition);
    if (storedPos) {
      try {
        const { left, top } = JSON.parse(storedPos);
        const lVal = parseFloat(left);
        const tVal = parseFloat(top);
        if (!isNaN(lVal) && !isNaN(tVal)) { applyPos(lVal, tVal); positioned = true; }
      } catch {
        // Ignore malformed localStorage data
      }
    }
    if (!positioned) {
      const rp = document.getElementById("right-panel")?.getBoundingClientRect();
      const rightEdge = rp ? rp.left : window.innerWidth;
      applyPos(rightEdge - DIALOG_W - 16, rp ? Math.max(16, rp.top) : 80);
    }

    // Re-clamp on window resize so the dialog can't strand off-screen when the
    // viewport shrinks. Self-removes on the first resize after any close path
    // (the backdrop is gone), so it needs no explicit teardown hook.
    const onResize = () => {
      if (!backdrop.isConnected) { window.removeEventListener("resize", onResize); return; }
      applyPos(parseFloat(dialog.style.left) || 0, parseFloat(dialog.style.top) || 0);
    };
    window.addEventListener("resize", onResize);

    const dheader = document.createElement("div");
    dheader.className = "tp-dialog-header";
    dheader.style.cursor = "move";

    let isDragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      dialog.style.left = startLeft + (e.clientX - startX) + "px";
      dialog.style.top = startTop + (e.clientY - startY) + "px";
    };
    const onMouseUp = () => {
      isDragging = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      localStorage.setItem(StorageKeys.toolpathDialogPosition, JSON.stringify({
        left: dialog.style.left,
        top: dialog.style.top
      }));
    };
    dheader.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest(".tp-dialog-close")) return;
      isDragging = true;
      startX = e.clientX; startY = e.clientY;
      const rect = dialog.getBoundingClientRect();
      startLeft = rect.left; startTop = rect.top;
      dialog.style.position = "absolute";
      dialog.style.margin = "0";
      dialog.style.left = startLeft + "px";
      dialog.style.top = startTop + "px";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });

    const dtitle = document.createElement("h3");
    dtitle.textContent = isNew ? "Add Toolpath" : "Edit Toolpath";
    dtitle.style.userSelect = "none";
    dheader.appendChild(dtitle);
    const closeBtn = document.createElement("button");
    closeBtn.className = "tp-dialog-close";
    closeBtn.innerHTML = "&#x2715;";
    closeBtn.addEventListener("click", () => onClose());
    dheader.appendChild(closeBtn);
    dialog.appendChild(dheader);

    const body = document.createElement("div");
    body.className = "tp-dialog-body";
    dialog.appendChild(body);

    return { backdrop, dialog, body };
  }

  /** Tool section: library load/save, tool type, diameter, feeds/speeds, conditional V-bit/drill fields. */
  private buildToolSection(state: OpState, hooks: DialogHooks, isNew: boolean): HTMLElement {
    const toolSec = this.dSection("Tool");
    const toolSectionTitle = toolSec.querySelector(".tp-dialog-section-title") as HTMLElement;
    const toolArrow = document.createElement("span");
    toolArrow.style.cssText = "float:right;margin-left:6px;font-style:normal;";
    toolSectionTitle.style.cursor = "pointer";
    toolSectionTitle.appendChild(toolArrow);

    const toolContent = document.createElement("div");
    toolContent.style.cssText = "display:flex;flex-direction:column;gap:7px;";

    let toolExpanded = isNew;
    const applyToolCollapse = () => {
      toolContent.style.display = toolExpanded ? "" : "none";
      toolArrow.textContent = toolExpanded ? "▲" : "▼";
    };
    toolSectionTitle.addEventListener("click", () => { toolExpanded = !toolExpanded; applyToolCollapse(); });
    applyToolCollapse();

    // --- library row ---
    const libRow = document.createElement("div");
    libRow.style.cssText = "display:flex;gap:6px;margin-bottom:8px;";
    const loadLibBtn = document.createElement("button");
    loadLibBtn.className = "btn";
    loadLibBtn.style.flex = "1";
    loadLibBtn.textContent = "Load from Library";
    const saveLibBtn = document.createElement("button");
    saveLibBtn.className = "btn";
    saveLibBtn.style.flex = "1";
    saveLibBtn.textContent = "Save to Library";
    libRow.appendChild(loadLibBtn);
    libRow.appendChild(saveLibBtn);
    toolContent.appendChild(libRow);

    const libPicker = document.createElement("div");
    libPicker.style.cssText = "display:none;margin-bottom:8px;max-height:140px;overflow-y:auto;" +
      "background:var(--panel);border:1px solid var(--border);border-radius:4px;";
    toolContent.appendChild(libPicker);

    const refreshPicker = () => {
      libPicker.innerHTML = "";
      const tools = loadLibrary();
      if (tools.length === 0) {
        const mt = document.createElement("div");
        mt.style.cssText = "padding:8px;font-size:11px;color:var(--text-dim)";
        mt.textContent = "Library is empty";
        libPicker.appendChild(mt);
        return;
      }
      for (const t of tools) {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:6px;padding:5px 8px;cursor:pointer;" +
          "border-bottom:1px solid var(--border);font-size:11px;";
        row.addEventListener("mouseover", () => { row.style.background = "var(--panel-2)"; });
        row.addEventListener("mouseout",  () => { row.style.background = ""; });
        const nameSpan = document.createElement("span");
        nameSpan.style.flex = "1";
        nameSpan.textContent = t.name;
        const detailSpan = document.createElement("span");
        detailSpan.style.color = "var(--text-dim)";
        detailSpan.textContent = `⌀${t.diameter}mm`;
        row.appendChild(nameSpan);
        row.appendChild(detailSpan);
        row.addEventListener("click", () => {
          applyToolDef(t);
          libPicker.style.display = "none";
          loadLibBtn.textContent = "Load from Library";
        });
        libPicker.appendChild(row);
      }
    };

    let pickerOpen = false;
    loadLibBtn.addEventListener("click", () => {
      pickerOpen = !pickerOpen;
      if (pickerOpen) {
        refreshPicker();
        libPicker.style.display = "block";
        loadLibBtn.textContent = "▲ Close Library";
      } else {
        libPicker.style.display = "none";
        loadLibBtn.textContent = "Load from Library";
      }
    });

    saveLibBtn.addEventListener("click", () => {
      const name = window.prompt("Save tool as:", state.toolType === "v-bit"
        ? `${state.vAngle}° V-Bit ⌀${state.diameter}mm`
        : `⌀${state.diameter}mm ${TOOL_TYPE_LABELS[state.toolType]}`);
      if (!name) return;
      const def: ToolDef = {
        id: `tool-${Date.now()}`,
        name,
        toolType: state.toolType,
        diameter: state.diameter,
        vAngle: state.vAngle,
        tipAngle: state.tipAngle,
        feedrate: state.feedrate,
        plungeRate: state.plungeRate,
        spindleSpeed: state.spindleSpeed,
        safeZ: state.safeZ,
      };
      addTool(def);
      if (pickerOpen) refreshPicker();
    });

    // --- tool type ---
    const toolTypeSelect = document.createElement("select");
    toolTypeSelect.className = "unit";
    for (const [v, l] of Object.entries(TOOL_TYPE_LABELS) as [ToolType, string][]) {
      const o = document.createElement("option");
      o.value = v; o.textContent = l;
      toolTypeSelect.appendChild(o);
    }
    toolTypeSelect.value = state.toolType;
    toolContent.appendChild(this.dField("Tool Type", toolTypeSelect));

    const toolNumRow  = this.numRow("Tool # (T)", () => state.toolNumber, (v) => { state.toolNumber = Math.max(1, Math.round(v)); });
    const diamRow     = this.syncableInput("Diameter (mm)", () => state.diameter, (v, i) => { fork(); state.diameter = v; i.value = String(v); hooks.updateVBitHint(); });
    const spindleRow  = this.syncableInput("Spindle (rpm)", () => state.spindleSpeed, (v, i) => { fork(); state.spindleSpeed = Math.round(v); i.value = String(Math.round(v)); });
    const feedRow     = this.syncableInput("Feed (mm/min)", () => state.feedrate, (v, i) => { fork(); state.feedrate = v; i.value = String(v); });
    const plungeRow   = this.syncableInput("Plunge (mm/min)", () => state.plungeRate, (v, i) => { fork(); state.plungeRate = v; i.value = String(v); });
    const safeZRow    = this.syncableInput("Safe Z (mm)", () => state.safeZ, (v, i) => { fork(); state.safeZ = v; i.value = String(v); });

    const vAngleInp = document.createElement("input");
    vAngleInp.type = "number"; vAngleInp.className = "dim"; vAngleInp.step = "any"; vAngleInp.min = "1"; vAngleInp.max = "179";
    vAngleInp.value = String(state.vAngle);
    vAngleInp.addEventListener("change", () => { const v = parseFloat(vAngleInp.value); if (isFinite(v)) { fork(); state.vAngle = v; hooks.updateVBitHint(); } });
    const vAngleRow = this.dField("V Angle (°)", vAngleInp);

    const tipAngleInp = document.createElement("input");
    tipAngleInp.type = "number"; tipAngleInp.className = "dim"; tipAngleInp.step = "any";
    tipAngleInp.value = String(state.tipAngle);
    tipAngleInp.addEventListener("change", () => { const v = parseFloat(tipAngleInp.value); if (isFinite(v)) { fork(); state.tipAngle = v; } });
    const tipAngleRow = this.dField("Tip Angle (°)", tipAngleInp);

    toolContent.appendChild(toolNumRow.el);
    toolContent.appendChild(diamRow.el);
    toolContent.appendChild(vAngleRow);
    toolContent.appendChild(tipAngleRow);
    toolContent.appendChild(spindleRow.el);
    toolContent.appendChild(feedRow.el);
    toolContent.appendChild(plungeRow.el);
    toolContent.appendChild(safeZRow.el);
    toolSec.appendChild(toolContent);

    const updateToolTypeVisibility = () => {
      const tt = state.toolType;
      vAngleRow.style.display   = tt === "v-bit" ? "" : "none";
      tipAngleRow.style.display = tt === "drill"  ? "" : "none";
    };

    // Manual edits to any tool-defining field fork the op off its library tool.
    const fork = () => { state.toolId = undefined; };

    const applyToolDef = (t: ToolDef) => {
      state.toolId     = t.id;
      // Embed (upsert) the tool in the document so the file is self-contained
      // and a single tool can drive multiple operations.
      const existingIdx = this.doc.tools.findIndex((x) => x.id === t.id);
      if (existingIdx >= 0) this.doc.tools[existingIdx] = { ...t };
      else this.doc.tools.push({ ...t });
      state.toolType   = t.toolType;
      state.diameter   = t.diameter;
      state.vAngle     = t.vAngle ?? DEFAULTS.vAngle;
      state.tipAngle   = t.tipAngle ?? DEFAULTS.tipAngle;
      state.feedrate   = t.feedrate;
      state.plungeRate = t.plungeRate;
      state.spindleSpeed = t.spindleSpeed;
      state.safeZ      = t.safeZ;
      toolTypeSelect.value   = t.toolType;
      diamRow.inp.value      = String(t.diameter);
      vAngleInp.value        = String(state.vAngle);
      tipAngleInp.value      = String(state.tipAngle);
      spindleRow.inp.value   = String(t.spindleSpeed);
      feedRow.inp.value      = String(t.feedrate);
      plungeRow.inp.value    = String(t.plungeRate);
      safeZRow.inp.value     = String(t.safeZ);
      updateToolTypeVisibility();
      hooks.updateVBitHint();
    };

    updateToolTypeVisibility();
    toolTypeSelect.addEventListener("change", () => {
      fork();
      state.toolType = toolTypeSelect.value as ToolType;
      updateToolTypeVisibility();
      hooks.updateVBitHint();
    });
    hooks.setToolType = (t: ToolType) => {
      if (toolTypeSelect.value === t) return;
      toolTypeSelect.value = t;
      toolTypeSelect.dispatchEvent(new Event("change"));
    };

    return toolSec;
  }

  /** Tabs/bridges section (profile ops only). Returns its visibility updater. */
  private buildTabsSection(state: OpState): { root: HTMLElement; update: () => void } {
    const tabsSec = this.dSection("Tabs / Bridges");

    const tabEnabledWrap = document.createElement("div");
    tabEnabledWrap.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:6px;";
    const tabEnabledCb = document.createElement("input");
    tabEnabledCb.type = "checkbox";
    tabEnabledCb.checked = state.tabsEnabled;
    const tabEnabledLbl = document.createElement("label");
    tabEnabledLbl.textContent = "Enable tabs";
    tabEnabledLbl.style.cssText = "font-size:12px;cursor:pointer;";
    tabEnabledLbl.addEventListener("click", () => { tabEnabledCb.click(); });
    tabEnabledWrap.appendChild(tabEnabledCb);
    tabEnabledWrap.appendChild(tabEnabledLbl);
    tabsSec.appendChild(tabEnabledWrap);

    const tabCountRow  = this.numRow("Tab count",       () => state.tabCount,  (v) => { state.tabCount  = Math.max(1, Math.round(v)); });
    const tabWidthRow  = this.numRow("Tab width (mm)",  () => state.tabWidth,  (v) => { state.tabWidth  = Math.max(0.1, v); });
    const tabHeightRow = this.numRow("Tab height (mm)", () => state.tabHeight, (v) => { state.tabHeight = Math.max(0.1, v); });
    tabsSec.appendChild(tabCountRow.el);
    tabsSec.appendChild(tabWidthRow.el);
    tabsSec.appendChild(tabHeightRow.el);

    const update = () => {
      const isProfile = state.combo === "profile-outside" || state.combo === "profile-inside";
      tabsSec.style.display = isProfile ? "" : "none";
      const fieldsOn = isProfile && state.tabsEnabled;
      tabCountRow.el.style.display  = fieldsOn ? "" : "none";
      tabWidthRow.el.style.display  = fieldsOn ? "" : "none";
      tabHeightRow.el.style.display = fieldsOn ? "" : "none";
    };
    update();

    tabEnabledCb.addEventListener("change", () => {
      state.tabsEnabled = tabEnabledCb.checked;
      update();
    });

    return { root: tabsSec, update };
  }

  /** Lead-in / lead-out section (profile ops only). Returns its visibility updater. */
  private buildLeadSection(state: OpState): { root: HTMLElement; update: () => void } {
    const leadSec = this.dSection("Lead-in / Lead-out");
    const leadTypes: [LeadType, string][] = [["none", "None"], ["linear", "Linear"], ["arc", "Arc (90°)"]];

    const update = () => {
      const isProfile = state.combo.startsWith("profile");
      leadSec.style.display     = isProfile ? "" : "none";
      liLenRow.el.style.display = (isProfile && state.leadInType  !== "none") ? "" : "none";
      loLenRow.el.style.display = (isProfile && state.leadOutType !== "none") ? "" : "none";
    };

    const makeLeadSelect = (get: () => string, set: (v: LeadType) => void) => {
      const sel = document.createElement("select");
      sel.className = "unit";
      for (const [v, l] of leadTypes) {
        const o = document.createElement("option"); o.value = v; o.textContent = l;
        sel.appendChild(o);
      }
      sel.value = get();
      sel.addEventListener("change", () => { set(sel.value as LeadType); update(); });
      return sel;
    };

    const liSel = makeLeadSelect(() => state.leadInType, (v) => { state.leadInType = v; });
    leadSec.appendChild(this.dField("Lead-in", liSel));
    const liLenRow = this.numRow("Lead-in length (mm)", () => state.leadInLen, (v) => { state.leadInLen = Math.max(0.1, v); });
    leadSec.appendChild(liLenRow.el);

    const loSel = makeLeadSelect(() => state.leadOutType, (v) => { state.leadOutType = v; });
    leadSec.appendChild(this.dField("Lead-out", loSel));
    const loLenRow = this.numRow("Lead-out length (mm)", () => state.leadOutLen, (v) => { state.leadOutLen = Math.max(0.1, v); });
    leadSec.appendChild(loLenRow.el);

    update();
    return { root: leadSec, update };
  }

  /** Geometry section: entity/region picking, canvas pick-mode, and the live entity list. */
  private buildGeometrySection(state: OpState): {
    root: HTMLElement;
    renderEntities: () => void;
    ensurePocketSeeds: () => void;
    startPickMode: () => void;
    stopPickMode: () => void;
    getPickActive: () => boolean;
    cleanup: () => void;
  } {
    let renderEntities!: () => void;
    let pickModeActive = false;
    let unsubPickMode: (() => void) | null = null;

    // geometry section
    const geoSec = this.dSection("Geometry");

    // Geometry toolbar
    const geoBar = document.createElement("div");
    geoBar.style.cssText = "display:flex;gap:6px;margin-bottom:6px;";

    const pickBtn = document.createElement("button");
    pickBtn.className = "btn";
    pickBtn.title = "Click entities on the canvas to add them to this toolpath";
    pickBtn.textContent = "Pick";

    const fromSelBtn = document.createElement("button");
    fromSelBtn.className = "btn";
    fromSelBtn.style.flex = "1";
    fromSelBtn.title = "Add whatever is currently selected on the canvas";
    fromSelBtn.textContent = "+ From Selection";
    fromSelBtn.addEventListener("click", () => {
      if (state.combo === "pocket") {
        const docLoops = collectClosedLoops(this.doc.entities);
        let added = 0;

        const addSeed = (p: Vec2, region: ReturnType<typeof regionAtPoint>) => {
          if (!region) return false;
          if (state.regionSeeds.some((s) => pointInPolygon(s, region.outer) && !region.holes.some((h) => pointInPolygon(s, h))))
            return false;
          state.regionSeeds.push(p);
          return true;
        };

        // Text entities: seed each glyph's stroke area using winding direction to
        // separate outer contours from counter holes (e.g. the hole inside 'O').
        // Outer contours are CCW in Y-up (positive signed area); holes are CW (negative).
        for (const e of this.doc.entities) {
          if (!e.selected || e.isConstruction || !(e instanceof TextEntity)) continue;
          const contours = textToContours(e).filter(c => c.closed && c.points.length >= 3);
          const outers = contours.filter(c => signedArea(c.points) > 0);
          const inners = contours.filter(c => signedArea(c.points) <= 0);
          for (const outer of outers) {
            const holes = inners
              .filter(inn => pointInPolygon(inn.points[0], outer.points))
              .map(inn => inn.points);
            const p = interiorPoint(outer.points, holes);
            if (!p) continue;
            if (addSeed(p, regionAtPoint(p, docLoops))) added++;
          }
        }

        // Non-text entities: existing region-seed behaviour.
        const selLoops = collectClosedLoops(this.doc.entities.filter((e) => e.selected && !(e instanceof TextEntity)));
        for (const loop of selLoops) {
          const p = interiorPoint(loop.verts);
          if (!p) continue;
          if (addSeed(p, regionAtPoint(p, docLoops))) added++;
        }

        if (added > 0) renderEntities();
        return;
      }
      let added = 0;
      for (const e of this.doc.entities) {
        if (e.selected && !e.isConstruction && isValidFor(e, state.combo)) {
          state.entityIds.add(e.id);
          added++;
        }
      }
      if (added > 0) renderEntities();
    });

    const clearBtn = document.createElement("button");
    clearBtn.className = "btn";
    clearBtn.textContent = "Clear";
    clearBtn.addEventListener("click", () => {
      state.regionSeeds.length = 0;
      for (const id of state.entityIds) {
        const ent = this.doc.entities.find(x => x.id === id);
        if (ent) ent.selected = false;
      }
      state.entityIds.clear();
      renderEntities();
    });

    geoBar.appendChild(pickBtn);
    geoBar.appendChild(fromSelBtn);
    geoBar.appendChild(clearBtn);
    geoSec.appendChild(geoBar);

    // Pick mode hint — visible only while pick mode is active
    const pickHint = document.createElement("div");
    pickHint.style.cssText =
      "display:none;font-size:11px;color:var(--accent);margin-bottom:6px;padding:4px 6px;" +
      "background:var(--panel-2);border-radius:4px;border:1px solid var(--accent-dim);";
    pickHint.textContent = "Click entities on the canvas to add them";
    geoSec.appendChild(pickHint);

    const stopPickMode = () => {
      if (unsubPickMode) { unsubPickMode(); unsubPickMode = null; }
      this.doc.regionPickHandler = null;
      this.doc.regionHoverHandler = null;
      this.doc.regionPickHoverFill = null;
      pickModeActive = false;
      pickBtn.classList.remove("active");
      pickHint.style.display = "none";
      this.doc.emitChange(); // clear the hover shading
    };

    const startPickMode = () => {
      pickModeActive = true;
      pickBtn.classList.add("active");
      pickHint.style.display = "block";

      if (state.combo === "pocket" || state.combo === "vcarve") {
        // Flood-fill region pick: hover previews the enclosed face under the
        // cursor (any face of the planar arrangement, including those formed
        // by overlapping shapes); click toggles it.
        pickHint.textContent = "Click an enclosed area to add it; click again to remove";
        this.doc.regionPickHandler = (world) => {
          const loops = collectClosedLoops(this.doc.entities);
          // If the click lands inside an already-picked region, remove that seed.
          const hit = state.regionSeeds.findIndex((seed) => {
            const r = regionAtPoint(seed, loops);
            return r && pointInPolygon(world, r.outer) && !r.holes.some((h) => pointInPolygon(world, h));
          });
          if (hit >= 0) state.regionSeeds.splice(hit, 1);
          else if (regionAtPoint(world, loops)) state.regionSeeds.push({ ...world });
          else return true; // miss — consume the click so the select tool stays out of the way
          renderEntities();
          return true;
        };
        this.doc.regionHoverHandler = (world) => {
          const loops = collectClosedLoops(this.doc.entities);
          const region = regionAtPoint(world, loops);
          this.doc.regionPickHoverFill = region ? [region.outer, ...region.holes] : null;
        };
        return;
      }

      // Entity pick: absorb whatever is currently selected so the listener
      // only reacts to NEW picks, then mirror new canvas selections.
      pickHint.textContent = "Click entities on the canvas to add them";
      for (const e of this.doc.entities) {
        if (!e.isConstruction && isValidFor(e, state.combo) && e.selected)
          state.entityIds.add(e.id);
      }
      renderEntities();
      unsubPickMode = this.doc.onChange(() => {
        let changed = false;
        for (const e of this.doc.entities) {
          if (!e.isConstruction && isValidFor(e, state.combo) && e.selected) {
            if (!state.entityIds.has(e.id)) {
              state.entityIds.add(e.id);
              changed = true;
            }
          }
        }
        if (changed) renderEntities();
      });
    };

    pickBtn.addEventListener("click", () => {
      if (pickModeActive) stopPickMode();
      else startPickMode();
    });

    const entityList = document.createElement("div");
    geoSec.appendChild(entityList);

    // Pocket geometry: list of picked flood-fill regions (seed points whose
    // enclosed faces are recomputed from live geometry).
    const renderRegionList = () => {
      const loops = collectClosedLoops(this.doc.entities);
      const items = state.regionSeeds.map((seed) => ({ seed, region: regionAtPoint(seed, loops) }));

      const highlight = new Set<string>();
      const fills: Vec2[][][] = [];
      for (const it of items) {
        if (!it.region) continue;
        for (const id of it.region.loopIds) highlight.add(id);
        fills.push([it.region.outer, ...it.region.holes]);
      }
      this.doc.toolpathHighlightIds = highlight;
      this.doc.regionPickFills = fills;
      this.doc.emitChange();

      entityList.innerHTML = "";
      if (items.length === 0) {
        const mt = document.createElement("div");
        mt.className = "tp-entity-empty";
        mt.textContent = pickModeActive
          ? "No areas picked yet — click inside an enclosed area on the canvas"
          : "No areas picked yet — press Pick, then click inside an enclosed area";
        entityList.appendChild(mt);
        return;
      }

      const u = this.doc.displayUnit;
      items.forEach((it, idx) => {
        const row = document.createElement("div");
        row.className = "tp-entity-row" + (it.region ? "" : " tp-entity-disabled");
        row.style.cssText = "display:flex;align-items:center;gap:8px;";

        const desc = document.createElement("span");
        desc.style.flex = "1";
        if (it.region) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const v of it.region.outer) {
            if (v.x < minX) minX = v.x;
            if (v.x > maxX) maxX = v.x;
            if (v.y < minY) minY = v.y;
            if (v.y > maxY) maxY = v.y;
          }
          const size = `${formatLength(maxX - minX, u)} × ${formatLength(maxY - minY, u)}`;
          const isl = it.region.holes.length > 0
            ? ` — ${it.region.holes.length} island${it.region.holes.length === 1 ? "" : "s"}`
            : "";
          desc.textContent = `Area ${idx + 1} — ${size}${isl}`;
        } else {
          desc.textContent = `Area ${idx + 1} — no longer enclosed`;
          desc.style.opacity = "0.45";
        }

        // Hovering the row previews the region on the canvas.
        row.addEventListener("mouseenter", () => {
          this.doc.regionPickHoverFill = it.region ? [it.region.outer, ...it.region.holes] : null;
          this.doc.emitChange();
        });
        row.addEventListener("mouseleave", () => {
          this.doc.regionPickHoverFill = null;
          this.doc.emitChange();
        });

        const rmBtn = document.createElement("button");
        rmBtn.className = "btn";
        rmBtn.style.cssText = "padding:2px 8px;font-size:10px;";
        rmBtn.textContent = "✕";
        rmBtn.title = "Remove this area";
        rmBtn.addEventListener("click", () => {
          state.regionSeeds.splice(idx, 1);
          this.doc.regionPickHoverFill = null;
          renderEntities();
        });

        row.appendChild(desc);
        row.appendChild(rmBtn);
        entityList.appendChild(row);
      });
    };

    renderEntities = () => {
      // Pocket is always region-based. V-carve supports BOTH: show the region
      // list once areas are picked (or while flood-fill picking), else fall
      // through to the entity list so text/closed shapes can be selected.
      if (state.combo === "pocket" ||
          (state.combo === "vcarve" && (state.regionSeeds.length > 0 || pickModeActive))) {
        renderRegionList();
        return;
      }
      this.doc.toolpathHighlightIds = new Set([...state.entityIds, ...state.islandIds]);
      this.doc.regionPickFills = null;
      this.doc.emitChange();
      entityList.innerHTML = "";
      // Only show entities that are valid for the current op type; silently
      // drop any invalid ones from the selection sets (safety cleanup).
      const ents = this.doc.entities.filter((e) => !e.isConstruction && isValidFor(e, state.combo));
      for (const e of this.doc.entities) {
        if (!isValidFor(e, state.combo)) {
          state.entityIds.delete(e.id);
          state.islandIds.delete(e.id);
        }
      }
      if (ents.length === 0) {
        const mt = document.createElement("div");
        mt.className = "tp-entity-empty";
        mt.textContent = "No geometry in document";
        entityList.appendChild(mt);
        return;
      }

      // Build entity → group reverse map
      const entityGroupMap = new Map<string, GroupDef>();
      for (const g of this.doc.groups)
        for (const eid of g.entityIds) entityGroupMap.set(eid, g);

      // Group entities by layer
      const byLayer = new Map<string, Entity[]>();
      for (const e of ents) {
        const arr = byLayer.get(e.layerId) ?? [];
        arr.push(e);
        byLayer.set(e.layerId, arr);
      }

      const makeEntityRow = (e: Entity, section: "boundary" | "island", indent = false) => {
        const thisSet  = section === "boundary" ? state.entityIds : state.islandIds;
        const otherSet = section === "boundary" ? state.islandIds : state.entityIds;
        const inOther  = otherSet.has(e.id);
        const disabled = inOther; // all entities in ents[] are already valid for this combo

        const row = document.createElement("div");
        row.className = "tp-entity-row" + (disabled ? " tp-entity-disabled" : "");
        row.style.cssText = "display:flex;align-items:center;" + (indent ? "padding-left:20px;" : "");

        const lbl = document.createElement("label");
        lbl.style.cssText = `display:flex;align-items:center;gap:8px;flex:1;cursor:${disabled ? "default" : "pointer"};`;

        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.className = "tp-entity-cb";
        cb.checked = thisSet.has(e.id);
        cb.disabled = disabled;
        cb.addEventListener("change", () => {
          if (cb.checked) { thisSet.add(e.id); otherSet.delete(e.id); }
          else { thisSet.delete(e.id); e.selected = false; }
          renderEntities();
        });

        const desc = document.createElement("span");
        desc.textContent = describeEntity(e, this.doc);
        if (inOther) {
          desc.style.opacity = "0.45";
          desc.title = section === "boundary" ? "Assigned to Islands" : "Assigned to Boundary";
        }

        lbl.appendChild(cb);
        lbl.appendChild(desc);
        row.appendChild(lbl);

        // Chain button: boundary section, line-like entities only
        if (section === "boundary" && !inOther &&
            (e instanceof LineEntity || e instanceof ArcEntity || e instanceof BezierEntity)) {
          const chainBtn = document.createElement("button");
          chainBtn.className = "btn";
          chainBtn.style.cssText = "padding:2px 6px;font-size:10px;";
          chainBtn.textContent = "Chain";
          chainBtn.title = "Select connected chain";
          chainBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const chainIds = findContiguousChain(e.id, this.doc, state.combo);
            for (const id of chainIds) { state.entityIds.add(id); state.islandIds.delete(id); }
            renderEntities();
          });
          row.appendChild(chainBtn);
        }

        return row;
      };

      const makeChainRow = (chain: LineEntity[], section: "boundary" | "island") => {
        const thisSet  = section === "boundary" ? state.entityIds : state.islandIds;
        const otherSet = section === "boundary" ? state.islandIds : state.entityIds;
        const allInOther  = chain.every(e => otherSet.has(e.id));
        const someInOther = chain.some(e => otherSet.has(e.id));
        const disabled = allInOther || someInOther;
        const checked  = !disabled && chain.every(e => thisSet.has(e.id));
        const indeterminate = !disabled && !checked && chain.some(e => thisSet.has(e.id));

        const row = document.createElement("div");
        row.className = "tp-entity-row" + (disabled ? " tp-entity-disabled" : "");
        row.style.cssText = "display:flex;align-items:center;";

        const lbl = document.createElement("label");
        lbl.style.cssText = `display:flex;align-items:center;gap:8px;flex:1;cursor:${disabled ? "default" : "pointer"};`;

        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.className = "tp-entity-cb";
        cb.checked = checked;
        cb.indeterminate = indeterminate;
        cb.disabled = disabled;
        cb.addEventListener("change", () => {
          for (const e of chain) {
            if (cb.checked) { thisSet.add(e.id); otherSet.delete(e.id); }
            else { thisSet.delete(e.id); e.selected = false; }
          }
          renderEntities();
        });

        const desc = document.createElement("span");
        desc.textContent = `Closed path — ${chain.length} segments`;
        if (disabled) {
          desc.style.opacity = "0.45";
          desc.title = section === "boundary" ? "Assigned to Islands" : "Assigned to Boundary";
        }

        lbl.appendChild(cb);
        lbl.appendChild(desc);
        row.appendChild(lbl);
        return row;
      };

      const renderSection = (section: "boundary" | "island", container: HTMLElement) => {
        const thisSet  = section === "boundary" ? state.entityIds : state.islandIds;
        const otherSet = section === "boundary" ? state.islandIds : state.entityIds;

        for (const layer of this.doc.layers) {
          const layerEnts = byLayer.get(layer.id) ?? [];
          if (layerEnts.length === 0) continue;

          const groupsInLayer = new Map<string, { group: GroupDef; ents: Entity[] }>();
          const ungroupedEnts: Entity[] = [];
          for (const e of layerEnts) {
            const g = entityGroupMap.get(e.id);
            if (g) {
              if (!groupsInLayer.has(g.id)) groupsInLayer.set(g.id, { group: g, ents: [] });
              groupsInLayer.get(g.id)!.ents.push(e);
            } else {
              ungroupedEnts.push(e);
            }
          }

          // Layer header (with toggle button on boundary section only)
          const lh = document.createElement("div");
          lh.style.cssText = "display:flex;justify-content:space-between;align-items:center;" +
            "padding:4px 8px;background:var(--panel);border-radius:4px;margin-top:8px;margin-bottom:4px;";
          const lhTitle = document.createElement("span");
          lhTitle.style.cssText = "font-size:11px;font-weight:700;color:var(--text);";
          lhTitle.textContent = layer.name;
          lh.appendChild(lhTitle);

          if (section === "boundary") {
            const lToggle = document.createElement("button");
            lToggle.className = "btn";
            lToggle.style.cssText = "padding:2px 6px;font-size:10px;";
            lToggle.textContent = "Toggle";
            lToggle.addEventListener("click", () => {
              const valid = layerEnts.filter(e => isValidFor(e, state.combo) && !otherSet.has(e.id));
              const allChecked = valid.every(e => thisSet.has(e.id));
              for (const e of valid) {
                if (allChecked) { thisSet.delete(e.id); e.selected = false; }
                else thisSet.add(e.id);
              }
              renderEntities();
            });
            lh.appendChild(lToggle);
          }
          container.appendChild(lh);

          // Groups
          for (const { group, ents: gEnts } of groupsInLayer.values()) {
            const validEnts  = gEnts.filter(e => isValidFor(e, state.combo));
            const available  = validEnts.filter(e => !otherSet.has(e.id));
            const isValid    = validEnts.length > 0;
            const allChecked = available.length > 0 && available.every(e => thisSet.has(e.id));
            const someChecked = available.some(e => thisSet.has(e.id));

            const groupRow = document.createElement("div");
            groupRow.className = "tp-entity-row" + (isValid ? "" : " tp-entity-disabled");
            groupRow.style.cssText = "display:flex;align-items:center;";

            const lbl = document.createElement("label");
            lbl.style.cssText = `display:flex;align-items:center;gap:8px;flex:1;cursor:${isValid ? "pointer" : "default"};`;

            const cb = document.createElement("input");
            cb.type = "checkbox"; cb.className = "tp-entity-cb";
            cb.checked = allChecked;
            cb.indeterminate = someChecked && !allChecked;
            cb.disabled = !isValid;
            cb.addEventListener("change", () => {
              for (const e of available) {
                if (cb.checked) { thisSet.add(e.id); otherSet.delete(e.id); }
                else { thisSet.delete(e.id); e.selected = false; }
              }
              renderEntities();
            });

            const nameInput = document.createElement("input");
            nameInput.type = "text";
            nameInput.value = group.name;
            nameInput.placeholder = `Group — ${gEnts.length} ${gEnts.length === 1 ? "entity" : "entities"}`;
            nameInput.style.cssText = "background:transparent;border:none;border-bottom:1px solid var(--border);" +
              "color:var(--text);font:inherit;font-style:italic;width:160px;padding:0 2px;outline:none;";
            nameInput.addEventListener("change", () => { group.name = nameInput.value.trim(); });
            nameInput.addEventListener("click", ev => ev.stopPropagation());

            lbl.appendChild(cb);
            lbl.appendChild(nameInput);
            groupRow.appendChild(lbl);
            container.appendChild(groupRow);
            for (const e of gEnts) container.appendChild(makeEntityRow(e, section, true));
          }

          // Ungrouped: group line entities into closed chains, render each chain as one item
          const ungroupedLines = ungroupedEnts.filter((e): e is LineEntity => e instanceof LineEntity);
          const ungroupedOther = ungroupedEnts.filter(e => !(e instanceof LineEntity));
          const { chains: lineChains, singles: openLines } = groupLinesIntoClosedChains(ungroupedLines);
          for (const chain of lineChains)
            container.appendChild(makeChainRow(chain, section));
          if (section === "boundary")
            for (const e of openLines) container.appendChild(makeEntityRow(e, section));
          for (const e of ungroupedOther) container.appendChild(makeEntityRow(e, section));
        }
      };

      const makeSectionList = () => {
        const el = document.createElement("div");
        el.className = "tp-entity-list";
        return el;
      };

      const list = makeSectionList();
      entityList.appendChild(list);
      renderSection("boundary", list);
    };

    // Seed regions from any closed loops already assigned/selected, so the
    // "select shapes, then Add Toolpath" workflow shades immediately.
    const ensurePocketSeeds = () => {
      if (state.regionSeeds.length > 0 || state.entityIds.size === 0) return;
      state.regionSeeds.push(...seedsFromEntityIds(this.doc, state.entityIds, state.islandIds));
    };

    return {
      root: geoSec,
      renderEntities,
      ensurePocketSeeds,
      startPickMode,
      stopPickMode,
      getPickActive: () => pickModeActive,
      cleanup: () => { if (unsubPickMode) unsubPickMode(); },
    };
  }
}
