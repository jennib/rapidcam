/** Left-hand tool palette. Builds a button per tool and reflects the active one. */

import type { ToolManager } from "../tools/tool";
import { shortcutForTool } from "../tools/shortcuts";

// Tool IDs after which a visual separator is inserted.
const SEP_AFTER = new Set(["select", "text", "measure"]);

export class ToolPalette {
  private buttons = new Map<string, HTMLButtonElement>();

  constructor(
    host: HTMLElement,
    private manager: ToolManager,
    onToggleTree?: () => void,
  ) {
    // The design-tree toggle isn't a tool — it opens a panel — so it sits above
    // the separator and never participates in the active-tool highlight.
    if (onToggleTree) {
      const treeBtn = document.createElement("button");
      treeBtn.id = "design-tree-toggle";
      treeBtn.className = "tool-btn tree-toggle-btn";
      treeBtn.dataset.tip = "Design Tree (^B)";
      treeBtn.setAttribute("aria-label", "Toggle the design tree");
      treeBtn.textContent = "🌳";
      treeBtn.addEventListener("click", () => onToggleTree());
      host.appendChild(treeBtn);

      const topSep = document.createElement("div");
      topSep.className = "tool-sep";
      host.appendChild(topSep);
    }

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
