import type { CADDocument } from "../model/document";
import { ICONS } from "../tools/icons";
import { FileMenu, type FileMenuCallbacks } from "./fileMenu";
import { EditMenu, type EditMenuCallbacks } from "./editMenu";
import { InsertMenu, type InsertMenuCallbacks } from "./insertMenu";
import { ViewMenu, type ViewMenuCallbacks } from "./viewMenu";
import { HelpMenu } from "./helpMenu";

export interface TopBarCallbacks {
  onUndo: () => void;
  onRedo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  getProjectName: () => string;
  isDirty: () => boolean;
  onSettings: () => void;
  file: FileMenuCallbacks;
  edit: EditMenuCallbacks;
  insert: InsertMenuCallbacks;
  view: ViewMenuCallbacks;
}

export class TopBar {
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private nameEl!: HTMLElement;

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

    // Project name + dirty marker beside the logo. The tab title carries the same
    // two facts, but pro-CAD keeps the document name in the chrome where the eye
    // lands while working.
    this.nameEl = el("div", "topbar-filename");
    this.host.appendChild(this.nameEl);

    // Undo/redo sit with the document, before the menus (quick-access position)
    // rather than trailing after Help.
    this.undoBtn = button("", () => this.cb.onUndo());
    this.undoBtn.innerHTML = ICONS.undo;
    this.undoBtn.title = "Undo (Ctrl+Z)";
    this.undoBtn.setAttribute("aria-label", "Undo");
    this.redoBtn = button("", () => this.cb.onRedo());
    this.redoBtn.innerHTML = ICONS.redo;
    this.redoBtn.title = "Redo (Ctrl+Y / Ctrl+Shift+Z)";
    this.redoBtn.setAttribute("aria-label", "Redo");
    this.host.appendChild(this.undoBtn);
    this.host.appendChild(this.redoBtn);

    new FileMenu(this.host, this.cb.file);
    new EditMenu(this.host, this.cb.edit);
    new InsertMenu(this.host, this.cb.insert);
    new ViewMenu(this.host, this.cb.view);

    // Machine configuration (post-processor, tool changer, coolant capability,
    // custom program G-code) — the single home, kept out of the per-project
    // settings panel. Sits before Help, which stays last by convention.
    const settingsBtn = button("Settings", () => this.cb.onSettings());
    settingsBtn.title = "Machine settings: controller, coolant, custom program G-code";
    this.host.appendChild(settingsBtn);

    new HelpMenu(this.host);

    const spacer = el("div", "topbar-spacer");
    this.host.appendChild(spacer);
  }

  private refresh(): void {
    this.undoBtn.disabled = !this.cb.canUndo();
    this.redoBtn.disabled = !this.cb.canRedo();
    this.renderName();
  }

  /** Reflect the project name and its dirty marker in the chrome readout. */
  private renderName(): void {
    const name = this.cb.getProjectName() || "Untitled";
    this.nameEl.textContent = this.cb.isDirty() ? `● ${name}` : name;
    this.nameEl.title = name;
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
