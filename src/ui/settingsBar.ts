import { Unit, parseLength, formatLength } from "../core/units";
import { type CADDocument, type OriginX, type OriginY, type OriginZ } from "../model/document";

export class SettingsBar {
  private widthInput!: HTMLInputElement;
  private heightInput!: HTMLInputElement;
  private stockInput!: HTMLInputElement;
  private originXSelect!: HTMLSelectElement;
  private originYSelect!: HTMLSelectElement;
  private originZSelect!: HTMLSelectElement;
  private endReturnCheck!: HTMLInputElement;
  private endXInput!: HTMLInputElement;
  private endYInput!: HTMLInputElement;
  private parkGroup!: HTMLElement;
  private parkCheck!: HTMLInputElement;
  private parkXInput!: HTMLInputElement;
  private parkYInput!: HTMLInputElement;
  private jobInput!: HTMLInputElement;
  private revisionInput!: HTMLInputElement;
  private notesInput!: HTMLTextAreaElement;
  private unitSelect!: HTMLSelectElement;
  private content!: HTMLElement;
  private isCollapsed = false;
  private panelWidth = 200;

  constructor(
    private host: HTMLElement,
    private doc: CADDocument,
    private pushHistory: () => void,
  ) {
    this.build();
    this.doc.onChange(() => this.refresh());
    this.refresh();
  }

  private build(): void {
    const resizer = document.createElement("div");
    resizer.className = "settings-resizer";
    this.host.appendChild(resizer);
    this.bindResizer(resizer);

    const header = document.createElement("div");
    header.className = "settings-header";
    const title = document.createElement("div");
    title.className = "settings-title";
    title.textContent = "Project Settings";
    header.appendChild(title);
    const toggleBtn = document.createElement("button");
    toggleBtn.className = "settings-toggle";
    toggleBtn.textContent = "›";
    toggleBtn.title = "Collapse/Expand";
    toggleBtn.addEventListener("click", () => this.toggleCollapse());
    header.appendChild(toggleBtn);
    this.host.appendChild(header);

    this.content = document.createElement("div");
    this.content.className = "settings-content";
    this.host.appendChild(this.content);

    // Canvas size
    const canvasGroup = this.group("Canvas Size");
    canvasGroup.appendChild(this.field("Width", (this.widthInput = this.dimInput())));
    canvasGroup.appendChild(this.field("Height", (this.heightInput = this.dimInput())));
    this.content.appendChild(canvasGroup);

    // Material
    const stockGroup = this.group("Material");
    stockGroup.appendChild(this.field("Stock thickness", (this.stockInput = this.dimInput())));
    this.content.appendChild(stockGroup);

    // Origin (WCS)
    const originGroup = this.group("Origin (WCS)");

    this.originXSelect = this.makeSelect([
      ["left",   "Left"],
      ["center", "Center"],
      ["right",  "Right"],
    ]);
    originGroup.appendChild(this.field("X", this.originXSelect));

    this.originYSelect = this.makeSelect([
      ["front",  "Front"],
      ["center", "Center"],
      ["back",   "Back"],
    ]);
    originGroup.appendChild(this.field("Y", this.originYSelect));

    this.originZSelect = this.makeSelect([
      ["top", "Top of stock"],
      ["bed", "Bed"],
    ]);
    originGroup.appendChild(this.field("Z", this.originZSelect));

    this.content.appendChild(originGroup);

    // (Machine config — post-processor, tool changer — lives in the top-bar
    // Settings dialog, not this per-project panel.)

    // Program end — optional park position at program end (before M30).
    const endGroup = this.group("Program End");
    this.endReturnCheck = document.createElement("input");
    this.endReturnCheck.type = "checkbox";
    this.endReturnCheck.className = "settings-checkbox";
    endGroup.appendChild(this.field("Return to position", this.endReturnCheck));
    this.endXInput = this.dimInput();
    this.endYInput = this.dimInput();
    endGroup.appendChild(this.field("End X", this.endXInput));
    endGroup.appendChild(this.field("End Y", this.endYInput));
    this.content.appendChild(endGroup);

    // Tool-change park — where the tool rapids for a manual tool change (mill
    // only; hidden for lasers, which have no tool changes).
    this.parkGroup = this.group("Tool Change");
    this.parkCheck = document.createElement("input");
    this.parkCheck.type = "checkbox";
    this.parkCheck.className = "settings-checkbox";
    this.parkGroup.appendChild(this.field("Park for change", this.parkCheck));
    this.parkXInput = this.dimInput();
    this.parkYInput = this.dimInput();
    this.parkGroup.appendChild(this.field("Park X", this.parkXInput));
    this.parkGroup.appendChild(this.field("Park Y", this.parkYInput));
    this.content.appendChild(this.parkGroup);

    // Job metadata (informational; written to the G-code header)
    const jobGroup = this.group("Job");
    jobGroup.appendChild(this.field("Job", (this.jobInput = this.textInput("part / job name"))));
    jobGroup.appendChild(this.field("Revision", (this.revisionInput = this.textInput("e.g. A"))));
    this.notesInput = document.createElement("textarea");
    this.notesInput.className = "dim"; this.notesInput.rows = 2;
    this.notesInput.placeholder = "notes (optional)";
    jobGroup.appendChild(this.field("Notes", this.notesInput));
    this.content.appendChild(jobGroup);

    // Units
    this.unitSelect = document.createElement("select");
    this.unitSelect.className = "unit";
    for (const u of ["mm", "in"] as Unit[]) {
      const opt = document.createElement("option");
      opt.value = u; opt.textContent = u;
      this.unitSelect.appendChild(opt);
    }
    this.content.appendChild(this.field("Units", this.unitSelect));

    // Events
    this.widthInput.addEventListener("change", () => this.commitSize());
    this.heightInput.addEventListener("change", () => this.commitSize());
    this.stockInput.addEventListener("change", () => {
      const v = parseLength(this.stockInput.value, this.doc.displayUnit);
      if (v !== null && v > 0) { this.pushHistory(); this.doc.stockThickness = v; this.doc.emitChange(); }
    });
    this.originXSelect.addEventListener("change", () => {
      this.pushHistory();
      this.doc.origin.x = this.originXSelect.value as OriginX;
      this.doc.emitChange();
    });
    this.originYSelect.addEventListener("change", () => {
      this.pushHistory();
      this.doc.origin.y = this.originYSelect.value as OriginY;
      this.doc.emitChange();
    });
    this.originZSelect.addEventListener("change", () => {
      this.pushHistory();
      this.doc.origin.z = this.originZSelect.value as OriginZ;
      this.doc.emitChange();
    });
    this.endReturnCheck.addEventListener("change", () => {
      this.pushHistory();
      if (this.endReturnCheck.checked) {
        const x = parseLength(this.endXInput.value, this.doc.displayUnit) ?? 0;
        const y = parseLength(this.endYInput.value, this.doc.displayUnit) ?? 0;
        this.doc.endPosition = { x, y };
      } else {
        this.doc.endPosition = null;
      }
      this.doc.emitChange();
    });
    const commitEnd = (): void => {
      if (!this.doc.endPosition) return;
      const x = parseLength(this.endXInput.value, this.doc.displayUnit);
      const y = parseLength(this.endYInput.value, this.doc.displayUnit);
      this.pushHistory();
      this.doc.endPosition = {
        x: x ?? this.doc.endPosition.x,
        y: y ?? this.doc.endPosition.y,
      };
      this.doc.emitChange();
    };
    this.endXInput.addEventListener("change", commitEnd);
    this.endYInput.addEventListener("change", commitEnd);
    this.parkCheck.addEventListener("change", () => {
      this.pushHistory();
      if (this.parkCheck.checked) {
        const x = parseLength(this.parkXInput.value, this.doc.displayUnit) ?? 0;
        const y = parseLength(this.parkYInput.value, this.doc.displayUnit) ?? 0;
        this.doc.toolChangePosition = { x, y };
      } else {
        this.doc.toolChangePosition = null;
      }
      this.doc.emitChange();
    });
    const commitPark = (): void => {
      if (!this.doc.toolChangePosition) return;
      const x = parseLength(this.parkXInput.value, this.doc.displayUnit);
      const y = parseLength(this.parkYInput.value, this.doc.displayUnit);
      this.pushHistory();
      this.doc.toolChangePosition = {
        x: x ?? this.doc.toolChangePosition.x,
        y: y ?? this.doc.toolChangePosition.y,
      };
      this.doc.emitChange();
    };
    this.parkXInput.addEventListener("change", commitPark);
    this.parkYInput.addEventListener("change", commitPark);
    const commitMeta = (): void => {
      const job = this.jobInput.value.trim();
      const revision = this.revisionInput.value.trim();
      const notes = this.notesInput.value.trim();
      const next = { ...(job && { job }), ...(revision && { revision }), ...(notes && { notes }) };
      const cur = this.doc.metadata ?? {};
      if (cur.job === next.job && cur.revision === next.revision && cur.notes === next.notes) return;
      this.pushHistory();
      this.doc.metadata = next;
      this.doc.emitChange();
    };
    this.jobInput.addEventListener("change", commitMeta);
    this.revisionInput.addEventListener("change", commitMeta);
    this.notesInput.addEventListener("change", commitMeta);
    this.unitSelect.addEventListener("change", () => {
      this.doc.displayUnit = this.unitSelect.value as Unit;
      this.doc.emitChange();
    });
  }

  private get panel(): HTMLElement {
    return this.host.parentElement as HTMLElement;
  }

  private bindResizer(resizer: HTMLElement): void {
    let startX = 0, startWidth = 0;
    const onMove = (e: PointerEvent) => {
      const delta = startX - e.clientX;
      this.panelWidth = Math.max(120, Math.min(600, startWidth + delta));
      this.panel.style.width = `${this.panelWidth}px`;
      window.dispatchEvent(new Event("resize"));
    };
    const onUp = (e: PointerEvent) => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      this.panel.classList.remove("resizing");
      resizer.releasePointerCapture(e.pointerId);
    };
    resizer.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      startX = e.clientX; startWidth = this.panel.offsetWidth;
      this.panel.classList.add("resizing");
      resizer.setPointerCapture(e.pointerId);
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.body.style.cursor = "col-resize";
      e.preventDefault();
    });
  }

  private toggleCollapse(): void {
    this.isCollapsed = !this.isCollapsed;
    this.host.classList.toggle("collapsed", this.isCollapsed);
    this.host.addEventListener("transitionend", () => {
      window.dispatchEvent(new Event("resize"));
    }, { once: true });
  }

  private group(title: string): HTMLElement {
    const g = document.createElement("div");
    g.className = "settings-section";
    const h = document.createElement("div");
    h.className = "settings-section-title";
    h.textContent = title;
    g.appendChild(h);
    return g;
  }

  private field(label: string, control: HTMLElement): HTMLElement {
    const group = document.createElement("div");
    group.className = "settings-field-group";
    const lab = document.createElement("label");
    lab.textContent = label;
    group.appendChild(lab);
    group.appendChild(control);
    return group;
  }

  private dimInput(): HTMLInputElement {
    const i = document.createElement("input");
    i.className = "dim"; i.type = "text"; i.spellcheck = false;
    return i;
  }

  private textInput(placeholder: string): HTMLInputElement {
    const i = document.createElement("input");
    i.className = "dim"; i.type = "text"; i.placeholder = placeholder;
    return i;
  }

  private makeSelect(options: [string, string][]): HTMLSelectElement {
    const sel = document.createElement("select");
    sel.className = "unit";
    for (const [v, l] of options) {
      const opt = document.createElement("option");
      opt.value = v; opt.textContent = l;
      sel.appendChild(opt);
    }
    return sel;
  }

  private commitSize(): void {
    const u = this.doc.displayUnit;
    const w = parseLength(this.widthInput.value, u);
    const h = parseLength(this.heightInput.value, u);
    if ((w !== null && w > 0) || (h !== null && h > 0)) this.pushHistory();
    if (w !== null && w > 0) this.doc.canvas.width = w;
    if (h !== null && h > 0) this.doc.canvas.height = h;
    this.doc.emitChange();
  }

  private refresh(): void {
    const u = this.doc.displayUnit;
    if (document.activeElement !== this.widthInput)
      this.widthInput.value = formatLength(this.doc.canvas.width, u);
    if (document.activeElement !== this.heightInput)
      this.heightInput.value = formatLength(this.doc.canvas.height, u);
    if (document.activeElement !== this.stockInput)
      this.stockInput.value = formatLength(this.doc.stockThickness, u);
    this.originXSelect.value = this.doc.origin.x;
    this.originYSelect.value = this.doc.origin.y;
    this.originZSelect.value = this.doc.origin.z;
    const ep = this.doc.endPosition;
    this.endReturnCheck.checked = !!ep;
    this.endXInput.disabled = !ep;
    this.endYInput.disabled = !ep;
    if (document.activeElement !== this.endXInput)
      this.endXInput.value = formatLength(ep ? ep.x : 0, u);
    if (document.activeElement !== this.endYInput)
      this.endYInput.value = formatLength(ep ? ep.y : 0, u);
    // Tool-change park — mill only.
    this.parkGroup.style.display = this.doc.machineKind === "laser" ? "none" : "";
    const tp = this.doc.toolChangePosition;
    this.parkCheck.checked = !!tp;
    this.parkXInput.disabled = !tp;
    this.parkYInput.disabled = !tp;
    if (document.activeElement !== this.parkXInput)
      this.parkXInput.value = formatLength(tp ? tp.x : 0, u);
    if (document.activeElement !== this.parkYInput)
      this.parkYInput.value = formatLength(tp ? tp.y : 0, u);
    const md = this.doc.metadata ?? {};
    if (document.activeElement !== this.jobInput)
      this.jobInput.value = md.job ?? "";
    if (document.activeElement !== this.revisionInput)
      this.revisionInput.value = md.revision ?? "";
    if (document.activeElement !== this.notesInput)
      this.notesInput.value = md.notes ?? "";
    this.unitSelect.value = u;
  }
}
