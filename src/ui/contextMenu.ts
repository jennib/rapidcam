export interface ContextMenuItem {
  label: string;
  shortcut?: string;
  /** Defaults to true. Disabled items render dimmed and ignore clicks. */
  enabled?: boolean;
  onClick: () => void;
}

export type ContextMenuEntry = ContextMenuItem | "sep";

/**
 * A right-click popup menu positioned at the cursor. Reuses the `.fmenu-*`
 * styling shared with the top-bar dropdowns. A single instance is reused for
 * every invocation; call `show()` with the entries relevant to the click.
 */
export class ContextMenu {
  private el: HTMLElement;
  private isOpen = false;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "fmenu-dropdown ctxmenu";
    this.el.addEventListener("contextmenu", (e) => e.preventDefault());
    document.body.appendChild(this.el);

    // Dismiss on any outside interaction. Capture phase so we beat handlers
    // that might stopPropagation, and pointerdown so it closes before a click.
    document.addEventListener("pointerdown", (e) => {
      if (this.isOpen && !this.el.contains(e.target as Node)) this.close();
    }, true);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen) this.close();
    });
    window.addEventListener("blur", () => this.close());
    window.addEventListener("resize", () => this.close());
  }

  show(clientX: number, clientY: number, entries: ContextMenuEntry[]): void {
    this.el.innerHTML = "";
    let itemCount = 0;
    let lastWasSep = true; // suppress a leading separator
    for (const entry of entries) {
      if (entry === "sep") {
        if (lastWasSep) continue;
        this.sep();
        lastWasSep = true;
      } else {
        this.item(entry);
        itemCount++;
        lastWasSep = false;
      }
    }
    if (itemCount === 0) return;
    // Drop a trailing separator if one slipped through.
    const last = this.el.lastElementChild;
    if (last?.classList.contains("fmenu-sep")) last.remove();

    // Render off-screen to measure, then clamp within the viewport.
    this.el.style.left = "0px";
    this.el.style.top = "0px";
    this.el.style.display = "block";
    this.isOpen = true;

    const rect = this.el.getBoundingClientRect();
    const x = Math.min(clientX, window.innerWidth - rect.width - 4);
    const y = Math.min(clientY, window.innerHeight - rect.height - 4);
    this.el.style.left = `${Math.max(4, x)}px`;
    this.el.style.top = `${Math.max(4, y)}px`;
  }

  close(): void {
    if (!this.isOpen) return;
    this.el.style.display = "none";
    this.isOpen = false;
  }

  private sep(): void {
    const div = document.createElement("div");
    div.className = "fmenu-sep";
    this.el.appendChild(div);
  }

  private item(it: ContextMenuItem): void {
    const enabled = it.enabled !== false;
    const div = document.createElement("div");
    div.className = enabled ? "fmenu-item" : "fmenu-item disabled";

    const label = document.createElement("span");
    label.textContent = it.label;
    div.appendChild(label);

    if (it.shortcut) {
      const kbd = document.createElement("span");
      kbd.className = "fmenu-kbd";
      kbd.textContent = it.shortcut;
      div.appendChild(kbd);
    }

    if (enabled) {
      div.addEventListener("click", () => {
        this.close();
        it.onClick();
      });
    }
    this.el.appendChild(div);
  }
}
