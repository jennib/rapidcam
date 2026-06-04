import type { CADDocument } from "../model/document";
import {
  type Entity,
  CircleEntity,
  LineEntity,
  PolylineEntity,
  RectEntity,
} from "../model/entities";
import { formatLength } from "../core/units";
import { dist } from "../core/vec2";
import { DEFAULTS, type CAMOperation, type CAMOpType } from "../cam/types";
import { generateGCode, checkOperations } from "../cam/gcode";
import { nextId } from "../model/ids";

// ---- helpers ----------------------------------------------------------------

type OpCombo = "profile-outside" | "profile-inside" | "engrave" | "drill";

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
  return "Entity";
}

function isValidFor(e: Entity, combo: OpCombo): boolean {
  if (e.isConstruction) return false;
  switch (combo) {
    case "profile-outside":
    case "profile-inside":
      return (
        e instanceof CircleEntity ||
        e instanceof RectEntity ||
        (e instanceof PolylineEntity && e.closed)
      );
    case "engrave":
      return true;
    case "drill":
      return e instanceof CircleEntity;
  }
}

// ---- ToolpathsBar -----------------------------------------------------------

export class CamBar {
  private ops: CAMOperation[] = [];
  private content!: HTMLElement;
  private opsList!: HTMLElement;
  private isCollapsed = false;

  constructor(
    private host: HTMLElement,
    private doc: CADDocument,
  ) {
    this.build();
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

    const addBtn = document.createElement("button");
    addBtn.className = "cam-add-btn";
    addBtn.textContent = "+ Add Toolpath";
    addBtn.addEventListener("click", () => this.openDialog(null));
    this.content.appendChild(addBtn);

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
    if (this.ops.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cam-ops-empty";
      empty.textContent = "No toolpaths yet";
      this.opsList.appendChild(empty);
      return;
    }
    for (const op of this.ops) {
      this.opsList.appendChild(this.buildOpItem(op));
    }
  }

  private buildOpItem(op: CAMOperation): HTMLElement {
    const item = document.createElement("div");
    item.className = "tp-op-item";

    const badge = document.createElement("span");
    badge.className = `tp-badge tp-badge-${op.type}`;
    badge.textContent =
      op.type === "profile" ? (op.side === "outside" ? "OUT" : "IN")
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
    params.textContent = `T${op.toolNumber} ⌀${op.diameter}mm  ${op.depth}mm`;
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
      this.ops = this.ops.filter((o) => o.id !== op.id);
      this.renderOps();
    });
    item.appendChild(delBtn);

    return item;
  }

  // --- dialog ----------------------------------------------------------------

  private openDialog(existing: CAMOperation | null): void {
    document.getElementById("tp-dialog-backdrop")?.remove();

    const isNew = existing === null;
    const preSelected = new Set(
      this.doc.entities.filter((e) => e.selected && !e.isConstruction).map((e) => e.id),
    );

    const initialCombo: OpCombo = existing ? comboOf(existing) : "profile-outside";
    const state = {
      name: existing?.name ?? this.autoName(initialCombo),
      combo: initialCombo,
      toolNumber: existing?.toolNumber ?? DEFAULTS.toolNumber,
      diameter: existing?.diameter ?? DEFAULTS.diameter,
      feedrate: existing?.feedrate ?? DEFAULTS.feedrate,
      plungeRate: existing?.plungeRate ?? DEFAULTS.plungeRate,
      spindleSpeed: existing?.spindleSpeed ?? DEFAULTS.spindleSpeed,
      safeZ: existing?.safeZ ?? DEFAULTS.safeZ,
      depth: existing?.depth ?? DEFAULTS.depth,
      stepdown: existing?.stepdown ?? DEFAULTS.stepdown,
      entityIds: new Set<string>(existing?.entityIds ?? [...preSelected]),
    };

    // --- backdrop + dialog shell ---
    const backdrop = document.createElement("div");
    backdrop.id = "tp-dialog-backdrop";
    backdrop.className = "tp-backdrop";
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });

    const dialog = document.createElement("div");
    dialog.className = "tp-dialog";
    dialog.addEventListener("click", (e) => e.stopPropagation());
    backdrop.appendChild(dialog);

    // header
    const dheader = document.createElement("div");
    dheader.className = "tp-dialog-header";
    const dtitle = document.createElement("h3");
    dtitle.textContent = isNew ? "Add Toolpath" : "Edit Toolpath";
    dheader.appendChild(dtitle);
    const closeBtn = document.createElement("button");
    closeBtn.className = "tp-dialog-close";
    closeBtn.innerHTML = "&#x2715;";
    closeBtn.addEventListener("click", () => backdrop.remove());
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
      ["profile-inside", "Profile (inside)"],
      ["engrave", "Engrave"],
      ["drill", "Drill"],
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
    const numRow = (lbl: string, get: () => number, set: (v: number) => void) => {
      const inp = document.createElement("input");
      inp.type = "number"; inp.className = "dim"; inp.step = "any";
      inp.value = String(get());
      inp.addEventListener("change", () => { const v = parseFloat(inp.value); if (isFinite(v)) set(v); });
      return this.dField(lbl, inp);
    };
    toolSec.appendChild(numRow("Tool # (T)", () => state.toolNumber, (v) => { state.toolNumber = Math.max(1, Math.round(v)); }));
    toolSec.appendChild(numRow("Diameter (mm)", () => state.diameter, (v) => { state.diameter = v; }));
    toolSec.appendChild(numRow("Spindle (rpm)", () => state.spindleSpeed, (v) => { state.spindleSpeed = Math.round(v); }));
    toolSec.appendChild(numRow("Feed (mm/min)", () => state.feedrate, (v) => { state.feedrate = v; }));
    toolSec.appendChild(numRow("Plunge (mm/min)", () => state.plungeRate, (v) => { state.plungeRate = v; }));
    toolSec.appendChild(numRow("Safe Z (mm)", () => state.safeZ, (v) => { state.safeZ = v; }));
    body.appendChild(toolSec);

    // cut section
    const cutSec = this.dSection("Cut");
    const depthRow = document.createElement("div");
    depthRow.className = "tp-depth-row";
    const depthInp = document.createElement("input");
    depthInp.type = "number"; depthInp.className = "dim"; depthInp.step = "any";
    depthInp.value = String(state.depth);
    depthInp.addEventListener("change", () => {
      const v = parseFloat(depthInp.value); if (isFinite(v)) state.depth = v;
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

    const stepInp = document.createElement("input");
    stepInp.type = "number"; stepInp.className = "dim"; stepInp.step = "any";
    stepInp.value = String(state.stepdown);
    stepInp.addEventListener("change", () => {
      const v = parseFloat(stepInp.value); if (isFinite(v)) state.stepdown = v;
    });
    const stepRow = this.dField("Stepdown (mm)", stepInp);
    cutSec.appendChild(stepRow);
    body.appendChild(cutSec);

    // geometry section
    const geoSec = this.dSection("Geometry");
    const entityList = document.createElement("div");
    entityList.className = "tp-entity-list";
    geoSec.appendChild(entityList);
    body.appendChild(geoSec);

    const renderEntities = () => {
      entityList.innerHTML = "";
      const ents = this.doc.entities.filter((e) => !e.isConstruction);
      if (ents.length === 0) {
        const mt = document.createElement("div");
        mt.className = "tp-entity-empty";
        mt.textContent = "No geometry in document";
        entityList.appendChild(mt);
        return;
      }
      for (const e of ents) {
        const valid = isValidFor(e, state.combo);
        if (!valid) state.entityIds.delete(e.id);

        const row = document.createElement("label");
        row.className = "tp-entity-row" + (valid ? "" : " tp-entity-disabled");
        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.className = "tp-entity-cb";
        cb.checked = valid && state.entityIds.has(e.id);
        cb.disabled = !valid;
        cb.addEventListener("change", () => {
          if (cb.checked) state.entityIds.add(e.id);
          else state.entityIds.delete(e.id);
        });
        const desc = document.createElement("span");
        desc.textContent = describeEntity(e, this.doc);
        row.appendChild(cb);
        row.appendChild(desc);
        entityList.appendChild(row);
      }
    };

    typeSelect.addEventListener("change", () => {
      state.combo = typeSelect.value as OpCombo;
      stepRow.style.display = state.combo === "drill" ? "none" : "";
      renderEntities();
    });
    stepRow.style.display = state.combo === "drill" ? "none" : "";
    renderEntities();

    // footer
    const footer = document.createElement("div");
    footer.className = "tp-dialog-footer";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn"; cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => backdrop.remove());
    const applyBtn = document.createElement("button");
    applyBtn.className = "btn tp-apply-btn"; applyBtn.textContent = "Apply";
    applyBtn.addEventListener("click", () => {
      const ids = [...state.entityIds];
      if (ids.length === 0) { alert("Select at least one geometry item."); return; }

      let type: CAMOpType, side: "outside" | "inside";
      if (state.combo === "profile-outside") { type = "profile"; side = "outside"; }
      else if (state.combo === "profile-inside") { type = "profile"; side = "inside"; }
      else if (state.combo === "engrave") { type = "engrave"; side = "outside"; }
      else { type = "drill"; side = "outside"; }

      const op: CAMOperation = {
        id: existing?.id ?? nextId("cam"),
        name: state.name || this.autoName(state.combo),
        type, side, entityIds: ids,
        toolNumber: state.toolNumber,
        diameter: state.diameter, feedrate: state.feedrate,
        plungeRate: state.plungeRate, spindleSpeed: state.spindleSpeed,
        safeZ: state.safeZ, depth: state.depth, stepdown: state.stepdown,
      };

      if (existing) {
        const idx = this.ops.findIndex((o) => o.id === existing.id);
        if (idx >= 0) this.ops[idx] = op;
      } else {
        this.ops.push(op);
      }
      this.renderOps();
      backdrop.remove();
    });
    footer.appendChild(cancelBtn);
    footer.appendChild(applyBtn);
    dialog.appendChild(footer);

    document.body.appendChild(backdrop);
    setTimeout(() => nameInput.select(), 40);
  }

  // --- G-code generation -----------------------------------------------------

  private generate(): void {
    if (this.ops.length === 0) { alert("Add at least one toolpath first."); return; }
    const warnings = checkOperations(this.ops, this.doc);
    if (warnings.length > 0) {
      const msg =
        `⚠ Toolpath warning${warnings.length > 1 ? "s" : ""}:\n\n` +
        warnings.map((w) => `• ${w}`).join("\n") +
        `\n\nThe miter-join offset used for concave shapes may self-intersect ` +
        `and produce incorrect or unsafe cut paths.\n\nGenerate anyway?`;
      if (!confirm(msg)) return;
    }
    this.download(generateGCode(this.ops, this.doc), "toolpaths");
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
      : combo === "engrave" ? "Engrave"
      : "Drill";
    const n = this.ops.filter((o) => comboOf(o) === combo).length + 1;
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
