import type { RecentEntry } from "../io/fileio";
import { getRecents } from "../io/fileio";

export interface FileMenuCallbacks {
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onOpenRecent: (entry: RecentEntry) => void;
  onExportSvg: () => void;
}

export class FileMenu {
  private btn: HTMLButtonElement;
  private dropdown: HTMLElement;
  private isOpen = false;

  constructor(host: HTMLElement, private cb: FileMenuCallbacks) {
    this.btn = document.createElement("button");
    this.btn.className = "btn";
    this.btn.textContent = "File";
    this.btn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggle();
    });
    host.appendChild(this.btn);

    this.dropdown = document.createElement("div");
    this.dropdown.className = "fmenu-dropdown";
    this.dropdown.addEventListener("click", (e) => e.stopPropagation());
    document.body.appendChild(this.dropdown);

    document.addEventListener("click", () => this.close());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen) this.close();
    });
  }

  private toggle(): void {
    this.isOpen ? this.close() : this.openMenu();
  }

  private openMenu(): void {
    this.buildItems();
    const rect = this.btn.getBoundingClientRect();
    this.dropdown.style.top = `${rect.bottom + 4}px`;
    this.dropdown.style.left = `${rect.left}px`;
    this.dropdown.style.display = "block";
    this.isOpen = true;
    this.btn.classList.add("active");
  }

  close(): void {
    if (!this.isOpen) return;
    this.dropdown.style.display = "none";
    this.isOpen = false;
    this.btn.classList.remove("active");
  }

  private buildItems(): void {
    this.dropdown.innerHTML = "";
    this.item("New Project", "Ctrl+N", () => { this.close(); this.cb.onNew(); });
    this.sep();
    this.item("Open…", "Ctrl+O", () => { this.close(); this.cb.onOpen(); });
    this.item("Save…", "Ctrl+S", () => { this.close(); this.cb.onSave(); });
    this.sep();
    this.item("Export SVG", "", () => { this.close(); this.cb.onExportSvg(); });

    const recents = getRecents();
    if (recents.length) {
      this.sep();
      this.sectionLabel("Recent Files");
      for (const entry of recents) {
        this.item(entry.name, "", () => { this.close(); this.cb.onOpenRecent(entry); });
      }
    }
  }

  private item(text: string, shortcut: string, onClick: () => void): void {
    const div = document.createElement("div");
    div.className = "fmenu-item";
    const label = document.createElement("span");
    label.textContent = text;
    div.appendChild(label);
    if (shortcut) {
      const kbd = document.createElement("span");
      kbd.className = "fmenu-kbd";
      kbd.textContent = shortcut;
      div.appendChild(kbd);
    }
    div.addEventListener("click", onClick);
    this.dropdown.appendChild(div);
  }

  private sep(): void {
    const div = document.createElement("div");
    div.className = "fmenu-sep";
    this.dropdown.appendChild(div);
  }

  private sectionLabel(text: string): void {
    const div = document.createElement("div");
    div.className = "fmenu-section-label";
    div.textContent = text;
    this.dropdown.appendChild(div);
  }
}
