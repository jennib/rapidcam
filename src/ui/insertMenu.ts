/**
 * Insert menu: one entry per registered parametric generator (see
 * generators/index.ts), each opening that generator's parameter dialog to add
 * a fresh feature. Structurally a clone of EditMenu — same dropdown idiom,
 * just a different item list.
 */

export interface InsertMenuCallbacks {
  /** Available parametric generators, listed in the menu. */
  generators: { id: string; name: string }[];
  /** Insert a new feature from the generator with this id. */
  onInsertGenerator: (id: string) => void;
}

export class InsertMenu {
  private btn: HTMLButtonElement;
  private dropdown: HTMLElement;
  private isOpen = false;

  constructor(
    host: HTMLElement,
    private cb: InsertMenuCallbacks,
  ) {
    this.btn = document.createElement("button");
    this.btn.className = "btn";
    this.btn.textContent = "Insert";
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
    for (const g of this.cb.generators) {
      this.item(`${g.name}…`, "", () => {
        this.close();
        this.cb.onInsertGenerator(g.id);
      });
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
}
