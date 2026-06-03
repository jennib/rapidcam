import { Unit, parseLength, formatLength } from "../core/units";
import { CADDocument } from "../model/document";

export class SettingsBar {
  private widthInput!: HTMLInputElement;
  private heightInput!: HTMLInputElement;
  private unitSelect!: HTMLSelectElement;
  private content!: HTMLElement;
  private isCollapsed = false;
  private panelWidth = 200;

  constructor(
    private host: HTMLElement,
    private doc: CADDocument,
  ) {
    this.build();
    this.doc.onChange(() => this.refresh());
    this.refresh();
  }

  private build(): void {
    // Resizer handle
    const resizer = document.createElement("div");
    resizer.className = "settings-resizer";
    this.host.appendChild(resizer);
    this.bindResizer(resizer);

    // Header
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

    // Content area
    this.content = document.createElement("div");
    this.content.className = "settings-content";
    this.host.appendChild(this.content);

    const canvasGroup = this.group("Canvas Size");
    canvasGroup.appendChild(this.field("Width", (this.widthInput = this.dimInput())));
    canvasGroup.appendChild(this.field("Height", (this.heightInput = this.dimInput())));
    this.content.appendChild(canvasGroup);

    // Unit selector
    this.unitSelect = document.createElement("select");
    this.unitSelect.className = "unit";
    for (const u of ["mm", "in"] as Unit[]) {
      const opt = document.createElement("option");
      opt.value = u;
      opt.textContent = u;
      this.unitSelect.appendChild(opt);
    }
    this.content.appendChild(this.field("Units", this.unitSelect));

    // events
    this.widthInput.addEventListener("change", () => this.commitSize());
    this.heightInput.addEventListener("change", () => this.commitSize());
    this.unitSelect.addEventListener("change", () => {
      this.doc.displayUnit = this.unitSelect.value as Unit;
      this.doc.emitChange();
    });
  }

  private get panel(): HTMLElement {
    return this.host.parentElement as HTMLElement;
  }

  private bindResizer(resizer: HTMLElement): void {
    let startX = 0;
    let startWidth = 0;

    const onMove = (e: PointerEvent) => {
      const delta = startX - e.clientX;
      this.panelWidth = Math.max(120, Math.min(600, startWidth + delta));
      this.panel.style.width = `${this.panelWidth}px`;
      // canvas listens to window resize to recalculate layout dimensions
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
      startX = e.clientX;
      startWidth = this.panel.offsetWidth;
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
    if (this.isCollapsed) {
      this.host.classList.add("collapsed");
    } else {
      this.host.classList.remove("collapsed");
    }
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
    i.className = "dim";
    i.type = "text";
    i.spellcheck = false;
    return i;
  }

  private commitSize(): void {
    const u = this.doc.displayUnit;
    const w = parseLength(this.widthInput.value, u);
    const h = parseLength(this.heightInput.value, u);
    if (w !== null && w > 0) this.doc.canvas.width = w;
    if (h !== null && h > 0) this.doc.canvas.height = h;
    this.doc.emitChange();
  }

  private refresh(): void {
    const u = this.doc.displayUnit;
    if (document.activeElement !== this.widthInput) {
      this.widthInput.value = formatLength(this.doc.canvas.width, u);
    }
    if (document.activeElement !== this.heightInput) {
      this.heightInput.value = formatLength(this.doc.canvas.height, u);
    }
    this.unitSelect.value = u;
  }
}
