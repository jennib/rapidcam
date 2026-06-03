/** Left-hand tool palette. Builds a button per tool and reflects the active one. */

import { ToolManager } from "../tools/tool";

export class ToolPalette {
  private buttons = new Map<string, HTMLButtonElement>();

  constructor(host: HTMLElement, private manager: ToolManager) {
    const tools = manager.list();
    tools.forEach((tool, i) => {
      const btn = document.createElement("button");
      btn.className = "tool-btn";
      btn.dataset.tip = tool.label;
      btn.innerHTML = tool.icon;
      btn.addEventListener("click", () => manager.activate(tool.id));
      host.appendChild(btn);
      this.buttons.set(tool.id, btn);
      // Separate the Select tool from the drawing tools.
      if (i === 0 && tools.length > 1) {
        const sep = document.createElement("div");
        sep.className = "tool-sep";
        host.appendChild(sep);
      }
    });

    manager.onActiveChange(() => this.refresh());
    this.refresh();
  }

  private refresh(): void {
    for (const [id, btn] of this.buttons) {
      btn.classList.toggle("active", this.manager.active.id === id);
    }
  }
}
