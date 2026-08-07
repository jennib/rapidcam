/**
 * Toolpath Multi-Selection Manager.
 * Tracks transient selection of operations for combined/batch export workflows.
 */
export class CamSelectionManager {
  readonly selectedOpIds = new Set<string>();
  private exportSelBtn: HTMLButtonElement | null = null;

  syncWithLiveOps(liveOpIds: Set<string>): void {
    for (const id of [...this.selectedOpIds]) {
      if (!liveOpIds.has(id)) this.selectedOpIds.delete(id);
    }
    this.updateButton();
  }

  toggle(id: string, selected: boolean): void {
    if (selected) this.selectedOpIds.add(id);
    else this.selectedOpIds.delete(id);
    this.updateButton();
  }

  clear(): void {
    this.selectedOpIds.clear();
    this.updateButton();
  }

  createButton(
    container: HTMLElement,
    onExport: (selectedIds: Set<string>) => void,
  ): HTMLButtonElement {
    // Export a chosen subset of toolpaths into a single file (e.g. all the ops
    // that share a tool). Appears only when ≥1 toolpath is checked.
    const exportSelBtn = document.createElement("button");
    exportSelBtn.className = "cam-add-btn cam-export-sel-btn";
    exportSelBtn.style.cssText = "width:100%;margin-top:6px;display:none;";
    exportSelBtn.addEventListener("click", () => onExport(this.selectedOpIds));
    this.exportSelBtn = exportSelBtn;
    container.appendChild(exportSelBtn);
    this.updateButton();
    return exportSelBtn;
  }

  updateButton(): void {
    if (!this.exportSelBtn) return;
    const n = this.selectedOpIds.size;
    this.exportSelBtn.style.display = n > 0 ? "" : "none";
    this.exportSelBtn.textContent = `Export ${n} selected to one file`;
  }
}
