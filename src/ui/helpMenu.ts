import { showAboutDialog } from "./aboutDialog";

export class HelpMenu {
  private btn: HTMLButtonElement;
  private dropdown: HTMLElement;
  private isOpen = false;

  constructor(host: HTMLElement) {
    this.btn = document.createElement("button");
    this.btn.className = "btn";
    this.btn.textContent = "Help";
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
    this.item("About RapidCAM…", () => { this.close(); showAboutDialog(); });
  }

  private item(text: string, onClick: () => void): void {
    const div = document.createElement("div");
    div.className = "fmenu-item";
    const label = document.createElement("span");
    label.textContent = text;
    div.appendChild(label);
    div.addEventListener("click", onClick);
    this.dropdown.appendChild(div);
  }
}
