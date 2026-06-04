import { CADDocument, DocSnapshot } from "../model/document";
import { History } from "../model/history";
import { openFile, saveFile, applyFile, serializeDoc, pushRecent } from "./fileio";
import { exportSvg } from "./svgExport";
import type { RecentEntry, RcamFile } from "./fileio";
import { openNewProjectDialog } from "../ui/newProjectDialog";

export interface ProjectManagerCallbacks {
  onDocumentChange: () => void;
  onSolve: () => void;
  onFitView: () => void;
  onCloseEditors: () => void;
}

export class ProjectManager {
  history = new History<DocSnapshot>();
  currentFileName = "Untitled";
  currentFileHandle: FileSystemFileHandle | null = null;
  private isDocumentLoading = false;
  isDirty = false;

  private autosaveTimeout: number | null = null;

  constructor(
    private doc: CADDocument,
    private cb: ProjectManagerCallbacks
  ) {
    this.doc.onChange(() => { this.markDirty(); this.scheduleAutosave(); });
    this.updateTitle();
  }

  // --- title / dirty flag ---
  updateTitle(): void {
    document.title = this.isDirty
      ? `${this.currentFileName}* — RapidCAM`
      : `${this.currentFileName} — RapidCAM`;
  }

  markDirty(): void {
    if (this.isDocumentLoading) return;
    if (this.isDirty) return;
    this.isDirty = true;
    this.updateTitle();
  }

  markClean(): void {
    this.isDirty = false;
    this.updateTitle();
  }

  // --- history ---
  pushHistory = (snap?: DocSnapshot): void => {
    this.history.push(snap ?? this.doc.snapshot());
  };

  undoRedo(dir: "undo" | "redo"): void {
    const snap =
      dir === "undo"
        ? this.history.undo(this.doc.snapshot())
        : this.history.redo(this.doc.snapshot());
    if (!snap) return;
    this.cb.onCloseEditors();
    this.doc.restore(snap);
    this.cb.onSolve();
  }

  // --- file operations ---
  fileNew(): void {
    if (this.doc.entities.length && !confirm("Discard current drawing and start new?")) return;
    this.openSetupDialog();
  }

  openSetupDialog(): void {
    openNewProjectDialog(
      {
        name: this.currentFileName === "Untitled" ? "Untitled" : this.currentFileName,
      },
      (cfg) => {
        this.isDocumentLoading = true;
        this.history = new History<DocSnapshot>();
        this.doc.clear();
        this.doc.canvas = { width: cfg.width, height: cfg.height };
        this.doc.stockThickness = cfg.stockThickness;
        this.doc.displayUnit = cfg.displayUnit;
        this.doc.origin = { ...cfg.origin };
        this.doc.hasToolChanger = cfg.hasToolChanger;
        this.currentFileName = cfg.name;
        this.currentFileHandle = null;
        localStorage.removeItem("rapidcam:autosave-draft");
        this.doc.emitChange();
        this.cb.onFitView();
        this.isDocumentLoading = false;
        this.markClean();
      },
    );
  }

  async fileOpen(): Promise<void> {
    const result = await openFile();
    if (!result) return;
    this.loadDocument(result.file, result.name, result.handle ?? null);
  }

  async fileSave(): Promise<void> {
    if ('showSaveFilePicker' in window) {
      if (this.currentFileHandle) {
        try {
          const data = await this.writeToHandle(this.currentFileHandle);
          pushRecent({ name: this.currentFileName, savedAt: Date.now(), data });
          localStorage.removeItem("rapidcam:autosave-draft");
          this.markClean();
          return;
        } catch (e) {
          console.error("Save to file handle failed, prompting for a new file:", e);
        }
      }

      try {
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: this.currentFileName.endsWith(".rcam") ? this.currentFileName : `${this.currentFileName}.rcam`,
          types: [{
            description: "RapidCAM Project (.rcam)",
            accept: { "application/json": [".rcam"] }
          }]
        });
        this.currentFileHandle = handle;
        this.currentFileName = handle.name.replace(/\.rcam$/i, "");
        const data = await this.writeToHandle(handle);
        pushRecent({ name: this.currentFileName, savedAt: Date.now(), data });
        localStorage.removeItem("rapidcam:autosave-draft");
        this.markClean();
        return;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
      }
    }

    const name = prompt("Save as:", this.currentFileName);
    if (name === null) return;
    this.currentFileName = name || "Untitled";
    this.currentFileHandle = null;
    saveFile(this.doc, this.currentFileName);
    localStorage.removeItem("rapidcam:autosave-draft");
    this.markClean();
  }

  fileOpenRecent(entry: RecentEntry): void {
    if (this.doc.entities.length && !confirm(`Discard current drawing and open "${entry.name}"?`)) return;
    this.loadDocument(entry.data, entry.name);
  }

  /** Shared load path for open-file, open-recent, and draft-restore. */
  loadDocument(file: RcamFile, name: string, handle: FileSystemFileHandle | null = null, clearDraft = true): void {
    this.isDocumentLoading = true;
    this.history = new History<DocSnapshot>();
    this.cb.onCloseEditors();
    applyFile(this.doc, file);
    this.currentFileName = name;
    this.currentFileHandle = handle;
    if (clearDraft) localStorage.removeItem("rapidcam:autosave-draft");
    this.cb.onSolve();
    this.cb.onFitView();
    this.isDocumentLoading = false;
    this.markClean();
  }

  async writeToHandle(handle: FileSystemFileHandle): Promise<RcamFile> {
    const data = serializeDoc(this.doc, this.currentFileName);
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
    return data;
  }

  scheduleAutosave(): void {
    if (this.isDocumentLoading) return;
    if (this.autosaveTimeout !== null) {
      clearTimeout(this.autosaveTimeout);
    }
    this.autosaveTimeout = window.setTimeout(() => {
      void this.performAutosave();
    }, 2000);
  }

  async performAutosave(): Promise<void> {
    if (this.isDocumentLoading) return;

    if (this.currentFileHandle) {
      try {
        const data = await this.writeToHandle(this.currentFileHandle);
        localStorage.setItem("rapidcam:autosave-draft", JSON.stringify({
          name: this.currentFileName, savedAt: Date.now(), data,
        }));
        return;
      } catch (e) {
        console.error("Autosave to file handle failed:", e);
      }
    }

    const data = serializeDoc(this.doc, this.currentFileName);
    localStorage.setItem("rapidcam:autosave-draft", JSON.stringify({
      name: this.currentFileName, savedAt: Date.now(), data,
    }));
  }

  svgExport(): void {
    const svg = exportSvg(this.doc);
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${this.currentFileName}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }

  restoreDraft(): void {
    const raw = localStorage.getItem("rapidcam:autosave-draft");
    if (!raw) return;
    try {
      const draft = JSON.parse(raw);
      this.isDocumentLoading = true;
      this.history = new History<DocSnapshot>();
      this.cb.onCloseEditors();
      applyFile(this.doc, draft.data);
      this.currentFileName = draft.name;
      this.currentFileHandle = null;
      this.cb.onSolve();
      this.cb.onFitView();
      this.isDocumentLoading = false;
      this.markClean();
    } catch (e) {
      console.error("Failed to restore draft:", e);
    }
  }
}
