import { CADDocument } from "../model/document";

export class PropertiesBar {
  private content!: HTMLElement;
  private isCollapsed = false;

  constructor(
    private host: HTMLElement,
    _doc: CADDocument,
  ) {
    this.build();
  }

  private build(): void {
    const header = document.createElement("div");
    header.className = "props-header";

    const title = document.createElement("div");
    title.className = "props-title";
    title.textContent = "Properties";
    header.appendChild(title);

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "props-toggle";
    toggleBtn.textContent = "›";
    toggleBtn.title = "Collapse/Expand";
    toggleBtn.addEventListener("click", () => this.toggleCollapse());
    header.appendChild(toggleBtn);

    this.host.appendChild(header);

    this.content = document.createElement("div");
    this.content.className = "props-content";
    this.host.appendChild(this.content);

    const empty = document.createElement("div");
    empty.className = "props-empty";
    empty.textContent = "No selection";
    this.content.appendChild(empty);
  }

  private toggleCollapse(): void {
    this.isCollapsed = !this.isCollapsed;
    if (this.isCollapsed) {
      this.host.classList.add("collapsed");
    } else {
      this.host.classList.remove("collapsed");
    }
    this.host.addEventListener("transitionend", () => {
      window.dispatchEvent(new Event("resize"));
    }, { once: true });
  }
}
