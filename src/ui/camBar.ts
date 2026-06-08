import type { CADDocument, GroupDef } from "../model/document";
import {
  type Entity,
  CircleEntity,
  LineEntity,
  PolylineEntity,
  RectEntity,
  ArcEntity,
  BezierEntity,
  TextEntity,
} from "../model/entities";
import type { Vec2 } from "../core/vec2";
import { formatLength } from "../core/units";
import { dist } from "../core/vec2";
import { DEFAULTS, TOOL_TYPE_LABELS, type CAMOperation, type CAMOpType, type LeadType, type ToolDef, type ToolType } from "../cam/types";
import { loadLibrary, addTool } from "../cam/toolLibrary";
import { openToolLibraryDialog } from "./toolLibraryDialog";
import { generateGCode } from "../cam/gcode";
import { nextId } from "../model/ids";

// ---- helpers ----------------------------------------------------------------

type OpCombo = "profile-outside" | "profile-inside" | "pocket" | "engrave" | "drill";

function comboOf(op: CAMOperation): OpCombo {
  if (op.type === "profile") return op.side === "outside" ? "profile-outside" : "profile-inside";
  return op.type as OpCombo;
}

function describeEntity(e: Entity, doc: CADDocument): string {
  const u = doc.displayUnit;
  if (e instanceof LineEntity) return `Line — ${formatLength(dist(e.a, e.b), u)}`;
  if (e instanceof CircleEntity) return `Circle — r=${formatLength(e.radius, u)}`;
  if (e instanceof RectEntity)
    return `Rectangle — ${formatLength(e.width, u)} × ${formatLength(e.height, u)}`;
  if (e instanceof PolylineEntity)
    return `Polyline — ${e.points.length} pts${e.closed ? " (closed)" : " (open)"}`;
  if (e instanceof TextEntity)
    return `Text — "${e.text.length > 20 ? e.text.slice(0, 20) + "…" : e.text}"`;
  return "Entity";
}

function isValidFor(e: Entity, combo: OpCombo): boolean {
  if (e.isConstruction) return false;
  switch (combo) {
    case "profile-outside":
    case "profile-inside":
    case "pocket":
      return (
        e instanceof TextEntity ||
        e instanceof CircleEntity ||
        e instanceof RectEntity ||
        e instanceof LineEntity ||
        (e instanceof PolylineEntity && e.closed)
      );
    case "engrave":
      return true;
    case "drill":
      return e instanceof CircleEntity;
  }
}

function findContiguousChain(startId: string, doc: CADDocument, validCombo: OpCombo): string[] {
  const chain = new Set<string>();
  const front: Vec2[] = [];
  
  const startEnt = doc.entities.find(e => e.id === startId);
  if (!startEnt || startEnt.isConstruction) return [];
  
  const getEnds = (e: Entity): Vec2[] => {
    if (e instanceof LineEntity || e instanceof ArcEntity || e instanceof BezierEntity) {
      const p = e.pickablePoints();
      if (p.length >= 2) return [p[0].pos, p[p.length - 1].pos];
    } else if (e instanceof PolylineEntity && e.points.length > 0) {
      return [e.points[0], e.points[e.points.length - 1]];
    }
    return [];
  };

  front.push(...getEnds(startEnt));
  chain.add(startId);
  
  let added = true;
  while (added) {
    added = false;
    for (const e of doc.entities) {
      if (chain.has(e.id) || e.isConstruction || !isValidFor(e, validCombo)) continue;
      
      const ePts = getEnds(e);
      if (ePts.length === 2) {
        for (let i = 0; i < front.length; i++) {
          const f = front[i];
          if (dist(f, ePts[0]) < 1e-5) {
            chain.add(e.id);
            front[i] = ePts[1];
            added = true;
            break;
          } else if (dist(f, ePts[1]) < 1e-5) {
            chain.add(e.id);
            front[i] = ePts[0];
            added = true;
            break;
          }
        }
      }
    }
  }
  return [...chain];
}

// ---- ToolpathsBar -----------------------------------------------------------

export class CamBar {
  private content!: HTMLElement;
  private opsList!: HTMLElement;
  private isCollapsed = false;
  private highlightedOpId: string | null = null;

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
  }

  // --- list rendering --------------------------------------------------------

  private renderOps(): void {
    this.opsList.innerHTML = "";
    if (this.doc.operations.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cam-ops-empty";
      empty.textContent = "No toolpaths yet";
      this.opsList.appendChild(empty);
      return;
    }
    for (const op of this.doc.operations) {
      const item = this.buildOpItem(op);
      if (op.id === this.highlightedOpId) item.classList.add("tp-op-active");
      this.opsList.appendChild(item);
    }
  }

  private highlightOp(id: string | null): void {
    this.highlightedOpId = id;
    const op = id ? this.doc.operations.find(o => o.id === id) : null;
    this.doc.toolpathHighlightIds = op ? new Set(op.entityIds) : null;
    this.doc.emitChange();
    this.renderOps();
  }

  private buildOpItem(op: CAMOperation): HTMLElement {
    const item = document.createElement("div");
    item.className = "tp-op-item";
    item.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".tp-icon-btn")) return;
      this.highlightOp(this.highlightedOpId === op.id ? null : op.id);
    });

    const badge = document.createElement("span");
    badge.className = `tp-badge tp-badge-${op.type}`;
    badge.textContent =
      op.type === "profile" ? (op.side === "outside" ? "OUT" : "IN")
      : op.type === "pocket"  ? "PKT"
      : op.type === "engrave" ? "ENG"
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
      const code = generateGCode([op], this.doc);
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
      entityIds:    new Set<string>(existing?.entityIds ?? [...preSelected]),
      tabsEnabled:  existing?.tabs?.enabled ?? false,
      tabCount:     existing?.tabs?.count   ?? 4,
      tabWidth:     existing?.tabs?.width   ?? 4,
      tabHeight:    existing?.tabs?.height  ?? 2,
      stepover:     existing?.stepover ?? DEFAULTS.stepover,
      leadInType:   (existing?.leadIn?.type  ?? "none") as LeadType,
      leadInLen:    existing?.leadIn?.length  ?? 2,
      leadOutType:  (existing?.leadOut?.type ?? "none") as LeadType,
      leadOutLen:   existing?.leadOut?.length ?? 2,
    };

    let renderEntities: () => void;

    // Pick mode: additive-only canvas sync, active only when the user enables it.
    let pickModeActive = false;
    let unsubPickMode: (() => void) | null = null;

    const closeDialog = () => {
      if (unsubPickMode) unsubPickMode();
      this.doc.toolpathHighlightIds = null;
      this.doc.emitChange();
      document.getElementById("tp-dialog-backdrop")?.remove();
    };

    // --- backdrop + dialog shell ---
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

    // header
    const dheader = document.createElement("div");
    dheader.className = "tp-dialog-header";
    dheader.style.cursor = "move";
    
    // Drag logic
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    dheader.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest(".tp-dialog-close")) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = dialog.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      
      // Detach from flex centering
      dialog.style.position = "absolute";
      dialog.style.margin = "0";
      dialog.style.left = startLeft + "px";
      dialog.style.top = startTop + "px";

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });

    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      dialog.style.left = startLeft + (e.clientX - startX) + "px";
      dialog.style.top = startTop + (e.clientY - startY) + "px";
    };

    const onMouseUp = () => {
      isDragging = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    const dtitle = document.createElement("h3");
    dtitle.textContent = isNew ? "Add Toolpath" : "Edit Toolpath";
    dtitle.style.userSelect = "none";
    dheader.appendChild(dtitle);
    const closeBtn = document.createElement("button");
    closeBtn.className = "tp-dialog-close";
    closeBtn.innerHTML = "&#x2715;";
    closeBtn.addEventListener("click", () => closeDialog());
    dheader.appendChild(closeBtn);
    dialog.appendChild(dheader);

    // body
    const body = document.createElement("div");
    body.className = "tp-dialog-body";
    dialog.appendChild(body);

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

    // tool section
    const toolSec = this.dSection("Tool");

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
    toolSec.appendChild(libRow);

    // library picker (shown inline below the buttons)
    const libPicker = document.createElement("div");
    libPicker.style.cssText = "display:none;margin-bottom:8px;max-height:140px;overflow-y:auto;" +
      "background:var(--panel);border:1px solid var(--border);border-radius:4px;";
    toolSec.appendChild(libPicker);

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
    toolSec.appendChild(this.dField("Tool Type", toolTypeSelect));

    // --- shared number row helper ---
    const numRow = (lbl: string, get: () => number, set: (v: number) => void) => {
      const inp = document.createElement("input");
      inp.type = "number"; inp.className = "dim"; inp.step = "any";
      inp.value = String(get());
      inp.addEventListener("change", () => { const v = parseFloat(inp.value); if (isFinite(v)) set(v); });
      return { el: this.dField(lbl, inp), inp };
    };

    // helper to create an input that a ToolDef can repopulate
    const syncableInput = (lbl: string, get: () => number, set: (v: number, inp: HTMLInputElement) => void) => {
      const inp = document.createElement("input");
      inp.type = "number"; inp.className = "dim"; inp.step = "any";
      inp.value = String(get());
      inp.addEventListener("change", () => { const v = parseFloat(inp.value); if (isFinite(v)) set(v, inp); });
      return { el: this.dField(lbl, inp), inp };
    };

    const toolNumRow  = numRow("Tool # (T)", () => state.toolNumber, (v) => { state.toolNumber = Math.max(1, Math.round(v)); });
    const diamRow     = syncableInput("Diameter (mm)", () => state.diameter, (v, i) => { state.diameter = v; i.value = String(v); updateVBitHint(); });
    const spindleRow  = syncableInput("Spindle (rpm)", () => state.spindleSpeed, (v, i) => { state.spindleSpeed = Math.round(v); i.value = String(Math.round(v)); });
    const feedRow     = syncableInput("Feed (mm/min)", () => state.feedrate, (v, i) => { state.feedrate = v; i.value = String(v); });
    const plungeRow   = syncableInput("Plunge (mm/min)", () => state.plungeRate, (v, i) => { state.plungeRate = v; i.value = String(v); });
    const safeZRow    = syncableInput("Safe Z (mm)", () => state.safeZ, (v, i) => { state.safeZ = v; i.value = String(v); });

    // --- conditional V-bit fields ---
    const vAngleInp = document.createElement("input");
    vAngleInp.type = "number"; vAngleInp.className = "dim"; vAngleInp.step = "any"; vAngleInp.min = "1"; vAngleInp.max = "179";
    vAngleInp.value = String(state.vAngle);
    vAngleInp.addEventListener("change", () => { const v = parseFloat(vAngleInp.value); if (isFinite(v)) { state.vAngle = v; updateVBitHint(); } });
    const vAngleRow = this.dField("V Angle (°)", vAngleInp);

    // --- conditional drill tip angle ---
    const tipAngleInp = document.createElement("input");
    tipAngleInp.type = "number"; tipAngleInp.className = "dim"; tipAngleInp.step = "any";
    tipAngleInp.value = String(state.tipAngle);
    tipAngleInp.addEventListener("change", () => { const v = parseFloat(tipAngleInp.value); if (isFinite(v)) state.tipAngle = v; });
    const tipAngleRow = this.dField("Tip Angle (°)", tipAngleInp);

    toolSec.appendChild(toolNumRow.el);
    toolSec.appendChild(diamRow.el);
    toolSec.appendChild(vAngleRow);
    toolSec.appendChild(tipAngleRow);
    toolSec.appendChild(spindleRow.el);
    toolSec.appendChild(feedRow.el);
    toolSec.appendChild(plungeRow.el);
    toolSec.appendChild(safeZRow.el);
    body.appendChild(toolSec);

    // apply a ToolDef from the library into state + all inputs
    const applyToolDef = (t: ToolDef) => {
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
      updateVBitHint();
    };

    // show/hide conditional rows + keep drill-only type in sync with op type
    const updateToolTypeVisibility = () => {
      const tt = state.toolType;
      vAngleRow.style.display   = tt === "v-bit" ? "" : "none";
      tipAngleRow.style.display = tt === "drill"  ? "" : "none";
    };
    updateToolTypeVisibility();

    toolTypeSelect.addEventListener("change", () => {
      state.toolType = toolTypeSelect.value as ToolType;
      updateToolTypeVisibility();
      updateVBitHint();
    });

    // forward declaration — defined after the vbit hint element is created below
    let updateVBitHint: () => void = () => {};

    // cut section
    const cutSec = this.dSection("Cut");
    const depthRow = document.createElement("div");
    depthRow.className = "tp-depth-row";
    const depthInp = document.createElement("input");
    depthInp.type = "number"; depthInp.className = "dim"; depthInp.step = "any";
    depthInp.value = String(state.depth);
    depthInp.addEventListener("change", () => {
      const v = parseFloat(depthInp.value); if (isFinite(v)) { state.depth = v; updateVBitHint(); }
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

    updateVBitHint = () => {
      if (state.toolType !== "v-bit" || state.combo !== "engrave") {
        vbitHint.style.display = "none";
        return;
      }
      const halfAngle = (state.vAngle / 2) * (Math.PI / 180);
      const width = 2 * Math.abs(state.depth) * Math.tan(halfAngle);
      vbitHint.textContent = `→ effective cut width: ${width.toFixed(3)} mm`;
      vbitHint.style.display = "block";
    };
    updateVBitHint();

    const stepInp = document.createElement("input");
    stepInp.type = "number"; stepInp.className = "dim"; stepInp.step = "any";
    stepInp.value = String(state.stepdown);
    stepInp.addEventListener("change", () => {
      const v = parseFloat(stepInp.value); if (isFinite(v)) state.stepdown = v;
    });
    const stepRow = this.dField("Stepdown (mm)", stepInp);
    cutSec.appendChild(stepRow);

    const stepoverInp = document.createElement("input");
    stepoverInp.type = "number"; stepoverInp.className = "dim"; stepoverInp.step = "any";
    stepoverInp.min = "0.01"; stepoverInp.max = "1";
    stepoverInp.value = String(state.stepover);
    stepoverInp.addEventListener("change", () => {
      const v = parseFloat(stepoverInp.value); if (isFinite(v)) state.stepover = Math.min(1, Math.max(0.01, v));
    });
    const stepoverRow = this.dField("Stepover (0–1)", stepoverInp);
    cutSec.appendChild(stepoverRow);

    body.appendChild(cutSec);

    // tabs section — profile ops only
    let updateTabsVisibility: () => void = () => {};

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

    const tabCountRow  = numRow("Tab count",       () => state.tabCount,  (v) => { state.tabCount  = Math.max(1, Math.round(v)); });
    const tabWidthRow  = numRow("Tab width (mm)",  () => state.tabWidth,  (v) => { state.tabWidth  = Math.max(0.1, v); });
    const tabHeightRow = numRow("Tab height (mm)", () => state.tabHeight, (v) => { state.tabHeight = Math.max(0.1, v); });
    tabsSec.appendChild(tabCountRow.el);
    tabsSec.appendChild(tabWidthRow.el);
    tabsSec.appendChild(tabHeightRow.el);
    body.appendChild(tabsSec);

    updateTabsVisibility = () => {
      const isProfile = state.combo === "profile-outside" || state.combo === "profile-inside";
      tabsSec.style.display = isProfile ? "" : "none";
      const fieldsOn = isProfile && state.tabsEnabled;
      tabCountRow.el.style.display  = fieldsOn ? "" : "none";
      tabWidthRow.el.style.display  = fieldsOn ? "" : "none";
      tabHeightRow.el.style.display = fieldsOn ? "" : "none";
    };
    updateTabsVisibility();

    tabEnabledCb.addEventListener("change", () => {
      state.tabsEnabled = tabEnabledCb.checked;
      updateTabsVisibility();
    });

    // lead-in / lead-out section (profile ops only)
    let updateLeadVisibility: () => void = () => {};

    const leadSec = this.dSection("Lead-in / Lead-out");
    body.appendChild(leadSec);

    const leadTypes: [LeadType, string][] = [["none", "None"], ["linear", "Linear"], ["arc", "Arc (90°)"]];

    const makeLeadSelect = (get: () => string, set: (v: LeadType) => void) => {
      const sel = document.createElement("select");
      sel.className = "unit";
      for (const [v, l] of leadTypes) {
        const o = document.createElement("option"); o.value = v; o.textContent = l;
        sel.appendChild(o);
      }
      sel.value = get();
      sel.addEventListener("change", () => { set(sel.value as LeadType); updateLeadVisibility(); });
      return sel;
    };

    const liSel = makeLeadSelect(() => state.leadInType, (v) => { state.leadInType = v; });
    leadSec.appendChild(this.dField("Lead-in", liSel));
    const liLenRow = numRow("Lead-in length (mm)", () => state.leadInLen,  (v) => { state.leadInLen  = Math.max(0.1, v); });
    leadSec.appendChild(liLenRow.el);

    const loSel = makeLeadSelect(() => state.leadOutType, (v) => { state.leadOutType = v; });
    leadSec.appendChild(this.dField("Lead-out", loSel));
    const loLenRow = numRow("Lead-out length (mm)", () => state.leadOutLen, (v) => { state.leadOutLen = Math.max(0.1, v); });
    leadSec.appendChild(loLenRow.el);

    updateLeadVisibility = () => {
      const isProfile = state.combo.startsWith("profile");
      leadSec.style.display        = isProfile ? "" : "none";
      liLenRow.el.style.display    = (isProfile && state.leadInType  !== "none") ? "" : "none";
      loLenRow.el.style.display    = (isProfile && state.leadOutType !== "none") ? "" : "none";
    };
    updateLeadVisibility();

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

    const togglePickMode = () => {
      pickModeActive = !pickModeActive;
      pickBtn.classList.toggle("active", pickModeActive);
      pickHint.style.display = pickModeActive ? "block" : "none";
      if (pickModeActive) {
        // Absorb whatever is currently selected so the listener only reacts to NEW picks.
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
      } else {
        if (unsubPickMode) unsubPickMode();
        unsubPickMode = null;
      }
    };
    pickBtn.addEventListener("click", togglePickMode);

    const entityList = document.createElement("div");
    entityList.className = "tp-entity-list";
    geoSec.appendChild(entityList);
    body.appendChild(geoSec);

    renderEntities = () => {
      this.doc.toolpathHighlightIds = new Set(state.entityIds);
      this.doc.emitChange();
      entityList.innerHTML = "";
      const ents = this.doc.entities.filter((e) => !e.isConstruction);
      if (ents.length === 0) {
        const mt = document.createElement("div");
        mt.className = "tp-entity-empty";
        mt.textContent = "No geometry in document";
        entityList.appendChild(mt);
        return;
      }

      // Build entity → group reverse map
      const entityGroupMap = new Map<string, GroupDef>();
      for (const g of this.doc.groups) {
        for (const eid of g.entityIds) entityGroupMap.set(eid, g);
      }

      // Group entities by layer
      const byLayer = new Map<string, Entity[]>();
      for (const e of ents) {
        const arr = byLayer.get(e.layerId) || [];
        arr.push(e);
        byLayer.set(e.layerId, arr);
      }

      const makeEntityRow = (e: Entity, indent = false) => {
        const valid = isValidFor(e, state.combo);
        if (!valid) state.entityIds.delete(e.id);

        const row = document.createElement("div");
        row.className = "tp-entity-row" + (valid ? "" : " tp-entity-disabled");
        row.style.display = "flex";
        row.style.alignItems = "center";
        if (indent) row.style.paddingLeft = "20px";

        const lbl = document.createElement("label");
        lbl.style.display = "flex";
        lbl.style.alignItems = "center";
        lbl.style.gap = "8px";
        lbl.style.flex = "1";
        lbl.style.cursor = valid ? "pointer" : "default";

        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.className = "tp-entity-cb";
        cb.checked = valid && state.entityIds.has(e.id);
        cb.disabled = !valid;
        cb.addEventListener("change", () => {
          if (cb.checked) state.entityIds.add(e.id);
          else { state.entityIds.delete(e.id); e.selected = false; }
          renderEntities();
        });
        const desc = document.createElement("span");
        desc.textContent = describeEntity(e, this.doc);

        lbl.appendChild(cb);
        lbl.appendChild(desc);
        row.appendChild(lbl);

        if (valid && (e instanceof LineEntity || e instanceof ArcEntity || e instanceof BezierEntity)) {
          const chainBtn = document.createElement("button");
          chainBtn.className = "btn";
          chainBtn.style.padding = "2px 6px";
          chainBtn.style.fontSize = "10px";
          chainBtn.textContent = "Chain";
          chainBtn.title = "Select connected chain";
          chainBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const chainIds = findContiguousChain(e.id, this.doc, state.combo);
            for (const id of chainIds) state.entityIds.add(id);
            renderEntities();
          });
          row.appendChild(chainBtn);
        }

        return row;
      };

      for (const layer of this.doc.layers) {
        const layerEnts = byLayer.get(layer.id) || [];
        if (layerEnts.length === 0) continue;

        // Separate grouped vs ungrouped entities for this layer
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

        // Layer Header
        const lh = document.createElement("div");
        lh.style.display = "flex";
        lh.style.justifyContent = "space-between";
        lh.style.alignItems = "center";
        lh.style.padding = "4px 8px";
        lh.style.background = "var(--panel)";
        lh.style.borderRadius = "4px";
        lh.style.marginTop = "8px";
        lh.style.marginBottom = "4px";

        const lhTitle = document.createElement("span");
        lhTitle.style.fontSize = "11px";
        lhTitle.style.fontWeight = "700";
        lhTitle.style.color = "var(--text)";
        lhTitle.textContent = layer.name;
        lh.appendChild(lhTitle);

        const lToggle = document.createElement("button");
        lToggle.className = "btn";
        lToggle.style.padding = "2px 6px";
        lToggle.style.fontSize = "10px";
        lToggle.textContent = "Toggle";
        lToggle.addEventListener("click", () => {
          const valid = layerEnts.filter(e => isValidFor(e, state.combo));
          const allChecked = valid.every(e => state.entityIds.has(e.id));
          for (const e of valid) {
            if (allChecked) { state.entityIds.delete(e.id); e.selected = false; }
            else state.entityIds.add(e.id);
          }
          renderEntities();
        });
        lh.appendChild(lToggle);
        entityList.appendChild(lh);

        // Render groups
        for (const { ents: gEnts } of groupsInLayer.values()) {
          const validEnts = gEnts.filter(e => isValidFor(e, state.combo));
          const isValid = validEnts.length > 0;
          const allChecked = isValid && validEnts.every(e => state.entityIds.has(e.id));
          const someChecked = validEnts.some(e => state.entityIds.has(e.id));

          const groupRow = document.createElement("div");
          groupRow.className = "tp-entity-row" + (isValid ? "" : " tp-entity-disabled");
          groupRow.style.display = "flex";
          groupRow.style.alignItems = "center";

          const lbl = document.createElement("label");
          lbl.style.display = "flex";
          lbl.style.alignItems = "center";
          lbl.style.gap = "8px";
          lbl.style.flex = "1";
          lbl.style.cursor = isValid ? "pointer" : "default";

          const cb = document.createElement("input");
          cb.type = "checkbox"; cb.className = "tp-entity-cb";
          cb.checked = allChecked;
          cb.indeterminate = someChecked && !allChecked;
          cb.disabled = !isValid;
          cb.addEventListener("change", () => {
            for (const e of validEnts) {
              if (cb.checked) state.entityIds.add(e.id);
              else { state.entityIds.delete(e.id); e.selected = false; }
            }
            renderEntities();
          });

          const desc = document.createElement("span");
          desc.textContent = `Group — ${gEnts.length} ${gEnts.length === 1 ? "entity" : "entities"}`;
          desc.style.fontStyle = "italic";

          lbl.appendChild(cb);
          lbl.appendChild(desc);
          groupRow.appendChild(lbl);
          entityList.appendChild(groupRow);

          // Show individual members indented under the group
          for (const e of gEnts) entityList.appendChild(makeEntityRow(e, true));
        }

        // Render ungrouped entities
        for (const e of ungroupedEnts) entityList.appendChild(makeEntityRow(e, false));
      }
    };

    typeSelect.addEventListener("change", () => {
      state.combo = typeSelect.value as OpCombo;
      stepRow.style.display     = state.combo === "drill"   ? "none" : "";
      stepoverRow.style.display = state.combo === "pocket"  ? "" : "none";
      updateVBitHint();
      updateTabsVisibility();
      updateLeadVisibility();
      renderEntities();
    });
    stepRow.style.display     = state.combo === "drill"   ? "none" : "";
    stepoverRow.style.display = state.combo === "pocket"  ? "" : "none";
    updateTabsVisibility();
    updateLeadVisibility();
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
      const ids = [...state.entityIds];
      if (ids.length === 0) { alert("Select at least one geometry item."); return; }

      this.pushHistory?.();

      let type: CAMOpType, side: "outside" | "inside";
      if (state.combo === "profile-outside") { type = "profile"; side = "outside"; }
      else if (state.combo === "profile-inside") { type = "profile"; side = "inside"; }
      else if (state.combo === "pocket") { type = "pocket"; side = "outside"; }
      else if (state.combo === "engrave") { type = "engrave"; side = "outside"; }
      else { type = "drill"; side = "outside"; }

      const isProfile = type === "profile";

      const op: CAMOperation = {
        id: existing?.id ?? nextId("cam"),
        name: state.name || this.autoName(state.combo),
        type, side, entityIds: ids,
        toolType: state.toolType,
        toolNumber: state.toolNumber,
        diameter: state.diameter,
        vAngle: state.toolType === "v-bit" ? state.vAngle : undefined,
        tipAngle: state.toolType === "drill" ? state.tipAngle : undefined,
        feedrate: state.feedrate,
        plungeRate: state.plungeRate, spindleSpeed: state.spindleSpeed,
        safeZ: state.safeZ, depth: state.depth, stepdown: state.stepdown,
        stepover: state.stepover,
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

  private generate(): void {
    if (this.doc.operations.length === 0) { alert("Add at least one toolpath first."); return; }
    this.download(generateGCode(this.doc.operations, this.doc), "toolpaths");
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
}
