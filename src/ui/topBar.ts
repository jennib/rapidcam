/** Top bar: fit & clear actions. */

import { CADDocument } from "../model/document";

export interface TopBarCallbacks {
  onFit: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onConstructionToggle: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

export class TopBar {
  private constructionBtn!: HTMLButtonElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;

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

    this.undoBtn = button("↩", () => this.cb.onUndo());
    this.undoBtn.title = "Undo (Ctrl+Z)";
    this.redoBtn = button("↪", () => this.cb.onRedo());
    this.redoBtn.title = "Redo (Ctrl+Y / Ctrl+Shift+Z)";
    this.host.appendChild(this.undoBtn);
    this.host.appendChild(this.redoBtn);

    const spacer = el("div", "topbar-spacer");
    this.host.appendChild(spacer);

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
