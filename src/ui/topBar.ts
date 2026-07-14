import type { CADDocument } from "../model/document";
import { FileMenu, type FileMenuCallbacks } from "./fileMenu";
import { EditMenu, type EditMenuCallbacks } from "./editMenu";
import { ViewMenu, type ViewMenuCallbacks } from "./viewMenu";
import { HelpMenu } from "./helpMenu";

export interface TopBarCallbacks {
  onUndo: () => void;
  onRedo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  onSettings: () => void;
  /** Returns the current file name (without extension). */
  getFileName: () => string;
  /** Returns true when the document has unsaved changes. */
  isDirty: () => boolean;
  file: FileMenuCallbacks;
  edit: EditMenuCallbacks;
  view: ViewMenuCallbacks;
}

export class TopBar {
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private fileNameLabel!: HTMLElement;

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

    // File name indicator — sits right after the logo so the user always
    // knows which file is open. A dot prefix appears when dirty.
    this.fileNameLabel = el("div", "topbar-filename");
    this.host.appendChild(this.fileNameLabel);

    new FileMenu(this.host, this.cb.file);
    new EditMenu(this.host, this.cb.edit);
    new ViewMenu(this.host, this.cb.view);

    // Machine configuration (post-processor, tool changer, coolant capability,
    // custom program G-code) — the single home, kept out of the per-project
    // settings panel. Sits before Help, which stays last by convention.
    const settingsBtn = button("Settings", () => this.cb.onSettings());
    settingsBtn.title = "Machine settings: controller, coolant, custom program G-code";
    this.host.appendChild(settingsBtn);

    new HelpMenu(this.host);

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
    const name = this.cb.getFileName();
    const dirty = this.cb.isDirty();
    this.fileNameLabel.textContent = dirty ? `● ${name}` : name;
    this.fileNameLabel.title = dirty ? `${name} — unsaved changes` : name;
    this.fileNameLabel.classList.toggle("dirty", dirty);
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
