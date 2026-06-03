/** Top bar: fit & clear actions. */

import { CADDocument } from "../model/document";
import { FileMenu, FileMenuCallbacks } from "./fileMenu";

export interface TopBarCallbacks {
  onFit: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onConstructionToggle: () => void;
  onDelete: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  file: FileMenuCallbacks;
}

export class TopBar {
  private constructionBtn!: HTMLButtonElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private deleteBtn!: HTMLButtonElement;

  constructor(
    private host: HTMLElement,
    private doc: CADDocument,
    private cb: TopBarCallbacks,
  ) {
    this.build();
    this.doc.onChange(() => this.refresh());
    this.refresh();
  }

  private build(): void {
    const brand = el("div", "brand");
    brand.innerHTML = "Rapid<span>CAM</span>";
    this.host.appendChild(brand);

    new FileMenu(this.host, this.cb.file);

    this.undoBtn = button("↩", () => this.cb.onUndo());
    this.undoBtn.title = "Undo (Ctrl+Z)";
    this.redoBtn = button("↪", () => this.cb.onRedo());
    this.redoBtn.title = "Redo (Ctrl+Y / Ctrl+Shift+Z)";
    this.host.appendChild(this.undoBtn);
    this.host.appendChild(this.redoBtn);

    const spacer = el("div", "topbar-spacer");
    this.host.appendChild(spacer);

    this.deleteBtn = button("Delete", () => this.cb.onDelete());
    this.deleteBtn.classList.add("danger");
    this.deleteBtn.title = "Delete Selected (Delete / Backspace)";
    this.host.appendChild(this.deleteBtn);

    this.constructionBtn = button("Construction", () => this.cb.onConstructionToggle());
    const fitBtn = button("Fit", () => this.cb.onFit());
    const clearBtn = button("Clear", () => {
      if (this.doc.entities.length && confirm("Delete all geometry?")) this.doc.clear();
    });
    this.host.appendChild(this.constructionBtn);
    this.host.appendChild(fitBtn);
    this.host.appendChild(clearBtn);
  }

  private refresh(): void {
    this.undoBtn.disabled = !this.cb.canUndo();
    this.redoBtn.disabled = !this.cb.canRedo();

    if (this.doc.isConstructionMode) {
      this.constructionBtn.classList.add("active");
    } else {
      this.constructionBtn.classList.remove("active");
    }

    const hasSelection =
      this.doc.selected.length > 0 ||
      this.doc.selectedPoints.length > 0 ||
      this.doc.selectedConstraintId !== null ||
      this.doc.selectedDimensionId !== null;
    this.deleteBtn.disabled = !hasSelection;
  }
}

// --- small DOM helpers -------------------------------------------------------
function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}
function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "btn";
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}
