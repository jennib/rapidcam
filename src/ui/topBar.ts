import { CADDocument } from "../model/document";
import { FileMenu, FileMenuCallbacks } from "./fileMenu";
import { EditMenu, EditMenuCallbacks } from "./editMenu";
import { ViewMenu, ViewMenuCallbacks } from "./viewMenu";

export interface TopBarCallbacks {
  onUndo: () => void;
  onRedo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  file: FileMenuCallbacks;
  edit: EditMenuCallbacks;
  view: ViewMenuCallbacks;
}

export class TopBar {
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
    brand.innerHTML = '<img src="/rapidcam-logo.svg" height="32" alt="RapidCAM">';
    this.host.appendChild(brand);

    new FileMenu(this.host, this.cb.file);
    new EditMenu(this.host, this.cb.edit);
    new ViewMenu(this.host, this.cb.view);

    this.undoBtn = button("↩", () => this.cb.onUndo());
    this.undoBtn.title = "Undo (Ctrl+Z)";
    this.redoBtn = button("↪", () => this.cb.onRedo());
    this.redoBtn.title = "Redo (Ctrl+Y / Ctrl+Shift+Z)";
    this.host.appendChild(this.undoBtn);
    this.host.appendChild(this.redoBtn);

    const spacer = el("div", "topbar-spacer");
    this.host.appendChild(spacer);
  }

  private refresh(): void {
    this.undoBtn.disabled = !this.cb.canUndo();
    this.redoBtn.disabled = !this.cb.canRedo();
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
