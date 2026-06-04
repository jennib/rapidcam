import { Unit, parseLength, formatLength } from "../core/units";
import { type CADDocument, type OriginX, type OriginY, type OriginZ } from "../model/document";

export class SettingsBar {
  private widthInput!: HTMLInputElement;
  private heightInput!: HTMLInputElement;
  private stockInput!: HTMLInputElement;
  private originXSelect!: HTMLSelectElement;
  private originYSelect!: HTMLSelectElement;
  private originZSelect!: HTMLSelectElement;
  private toolChangerCheck!: HTMLInputElement;
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

    // Machine
    const machineGroup = this.group("Machine");
    this.toolChangerCheck = document.createElement("input");
    this.toolChangerCheck.type = "checkbox";
    this.toolChangerCheck.className = "settings-checkbox";
    machineGroup.appendChild(this.field("Tool changer", this.toolChangerCheck));
    this.content.appendChild(machineGroup);

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
    this.toolChangerCheck.addEventListener("change", () => {
      this.pushHistory();
      this.doc.hasToolChanger = this.toolChangerCheck.checked;
      this.doc.emitChange();
    });
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
    this.toolChangerCheck.checked = this.doc.hasToolChanger;
    this.unitSelect.value = u;
  }
}
