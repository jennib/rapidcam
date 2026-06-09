export interface EditMenuCallbacks {
  onDelete: () => void;
  onJoin: () => void;
  onLinearPattern: () => void;
  onCircularPattern: () => void;
  onRegeneratePatterns: () => void;
  onRectArray: () => void;
  onCircArray: () => void;
}

export class EditMenu {
  private btn: HTMLButtonElement;
  private dropdown: HTMLElement;
  private isOpen = false;

  constructor(host: HTMLElement, private cb: EditMenuCallbacks) {
    this.btn = document.createElement("button");
    this.btn.className = "btn";
    this.btn.textContent = "Edit";
    this.btn.addEventListener("click", () => this.toggle());
    host.appendChild(this.btn);

    this.dropdown = document.createElement("div");
    this.dropdown.className = "fmenu-dropdown";
    this.dropdown.addEventListener("click", (e) => e.stopPropagation());
    document.body.appendChild(this.dropdown);

    document.addEventListener("click", (e) => {
      if (!this.btn.contains(e.target as Node)) this.close();
    });
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
    this.item("Delete Selected", "Del", () => { this.close(); this.cb.onDelete(); });
    this.item("Join", "^J", () => { this.close(); this.cb.onJoin(); });
    this.sep();
    this.item("Linear Pattern…",    "", () => { this.close(); this.cb.onLinearPattern(); });
    this.item("Circular Pattern…",  "", () => { this.close(); this.cb.onCircularPattern(); });
    this.item("Regenerate Patterns", "^⇧P", () => { this.close(); this.cb.onRegeneratePatterns(); });
    this.sep();
    this.item("Rectangular Array…", "", () => { this.close(); this.cb.onRectArray(); });
    this.item("Circular Array…",    "", () => { this.close(); this.cb.onCircArray(); });
  }

  private sep(): void {
    const div = document.createElement("div");
    div.className = "fmenu-sep";
    this.dropdown.appendChild(div);
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
}
