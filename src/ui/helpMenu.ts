import { showAboutDialog } from "./aboutDialog";
import { showFeedbackDialog } from "./feedbackDialog";

const REPO_URL = "https://github.com/jennib/rapidcam";
const FORMAT_DOC_URL = `${REPO_URL}/blob/main/docs/rcam-format-v2.md`;
const SCHEMA_URL = "https://rapidcam.app/schema/rcam-v2.schema.json";

function openExternal(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

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
    this.item("Send Feedback…", () => { this.close(); showFeedbackDialog(); });
    this.item("About RapidCAM…", () => { this.close(); showAboutDialog(); });

    this.sep();
    this.sectionLabel("File Format & Source");
    this.externalItem(".rcam File Format Guide", FORMAT_DOC_URL);
    this.externalItem(".rcam JSON Schema", SCHEMA_URL);
    this.externalItem("Source on GitHub", REPO_URL);
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

  /** A menu item that opens an external URL in a new tab, marked with a ↗ glyph. */
  private externalItem(text: string, url: string): void {
    const div = document.createElement("div");
    div.className = "fmenu-item";
    const label = document.createElement("span");
    label.textContent = text;
    div.appendChild(label);
    const arrow = document.createElement("span");
    arrow.className = "fmenu-kbd";
    arrow.textContent = "↗";
    div.appendChild(arrow);
    div.addEventListener("click", () => { this.close(); openExternal(url); });
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
