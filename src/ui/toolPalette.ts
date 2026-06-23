/** Left-hand tool palette. Builds a button per tool and reflects the active one. */

import { ToolManager } from "../tools/tool";
import { shortcutForTool } from "../tools/shortcuts";

// Tool IDs after which a visual separator is inserted.
const SEP_AFTER = new Set(["select", "text", "measure"]);

export class ToolPalette {
  private buttons = new Map<string, HTMLButtonElement>();

  constructor(host: HTMLElement, private manager: ToolManager) {
    const tools = manager.list();
    tools.forEach((tool) => {
      const btn = document.createElement("button");
      btn.className = "tool-btn";
      const key = shortcutForTool(tool.id);
      btn.dataset.tip = key ? `${tool.label} (${key})` : tool.label;
      btn.innerHTML = tool.icon;
      btn.addEventListener("click", () => manager.activate(tool.id));
      host.appendChild(btn);
      this.buttons.set(tool.id, btn);
      if (SEP_AFTER.has(tool.id)) {
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
