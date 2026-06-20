import { CADDocument, DocSnapshot, ORIGIN_ENTITY_ID } from "../model/document";
import { History } from "../model/history";
import { openFile, saveFile, applyFile, serializeDoc, pushRecent, trySetItem, stripEmbeddedFonts } from "./fileio";
import { exportSvg } from "./svgExport";
import { importSvg } from "./svgImport";
import type { RecentEntry, RcamFile } from "./fileio";
import type { ExampleEntry } from "./examples";
import { nextId } from "../model/ids";
import { TextEntity } from "../model/entities";
import { isFontResolvable } from "../core/fontManager";
import { openNewProjectDialog } from "../ui/newProjectDialog";
import { track } from "../analytics";
import { StorageKeys } from "../core/storageKeys";

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
        this.doc.postProcessor = cfg.postProcessor;
        this.currentFileName = cfg.name;
        this.currentFileHandle = null;
        localStorage.removeItem(StorageKeys.autosaveDraft);
        this.doc.emitChange();
        this.cb.onFitView();
        this.isDocumentLoading = false;
        this.markClean();
        track("project_new", { width: cfg.width, height: cfg.height, unit: cfg.displayUnit });
      },
    );
  }

  async fileOpen(): Promise<void> {
    const result = await openFile();
    if (!result) return;
    track("project_opened");
    this.loadDocument(result.file, result.name, result.handle ?? null);
  }

  async fileSave(): Promise<void> {
    if ('showSaveFilePicker' in window) {
      if (this.currentFileHandle) {
        try {
          const data = await this.writeToHandle(this.currentFileHandle);
          pushRecent({ name: this.currentFileName, savedAt: Date.now(), data });
          localStorage.removeItem(StorageKeys.autosaveDraft);
          this.markClean();
          track("project_saved");
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
        localStorage.removeItem(StorageKeys.autosaveDraft);
        this.markClean();
        track("project_saved");
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
    localStorage.removeItem(StorageKeys.autosaveDraft);
    this.markClean();
    track("project_saved");
  }

  fileOpenRecent(entry: RecentEntry): void {
    if (this.doc.entities.length && !confirm(`Discard current drawing and open "${entry.name}"?`)) return;
    track("project_opened_recent");
    this.loadDocument(entry.data, entry.name);
  }

  loadExample(entry: ExampleEntry): void {
    const hasWork = this.doc.entities.some((e) => e.id !== ORIGIN_ENTITY_ID);
    if (hasWork && !confirm(`Discard current drawing and open example "${entry.name}"?`)) return;
    track("example_opened", { name: entry.name });
    // No file handle: a later Save prompts for a new file, leaving the bundled example intact.
    this.loadDocument(entry.file, entry.name);
  }

  /** Shared load path for open-file, open-recent, and draft-restore. */
  loadDocument(file: RcamFile, name: string, handle: FileSystemFileHandle | null = null, clearDraft = true): void {
    this.isDocumentLoading = true;
    this.history = new History<DocSnapshot>();
    this.cb.onCloseEditors();
    applyFile(this.doc, file);
    this.currentFileName = name;
    this.currentFileHandle = handle;
    if (clearDraft) localStorage.removeItem(StorageKeys.autosaveDraft);
    this.cb.onSolve();
    this.cb.onFitView();
    this.isDocumentLoading = false;
    this.markClean();
    this.warnMissingFonts();
  }

  /**
   * After a load, alert if any text references a font that couldn't be resolved
   * (e.g. a hand-authored file naming a font without embedding it). Such text
   * renders as a placeholder box and is omitted from G-code, so the user should
   * know up front rather than discover it in the cut.
   */
  private warnMissingFonts(): void {
    const missing = this.doc.entities.filter(
      (e): e is TextEntity => e instanceof TextEntity && !isFontResolvable(e.fontId),
    );
    if (missing.length === 0) return;
    const list = missing.map((t) => `  • "${t.text}"  (font: ${t.fontId})`).join("\n");
    alert(
      `${missing.length} text item${missing.length > 1 ? "s" : ""} reference a font that ` +
      `isn't available:\n\n${list}\n\nThis text will show as a placeholder and will be ` +
      `omitted from G-code until the font is re-added.`,
    );
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
        trySetItem(StorageKeys.autosaveDraft, JSON.stringify({
          name: this.currentFileName, savedAt: Date.now(), data: stripEmbeddedFonts(data),
        }));
        return;
      } catch (e) {
        console.error("Autosave to file handle failed:", e);
      }
    }

    const data = serializeDoc(this.doc, this.currentFileName);
    trySetItem(StorageKeys.autosaveDraft, JSON.stringify({
      name: this.currentFileName, savedAt: Date.now(), data: stripEmbeddedFonts(data),
    }));
  }

  async svgImport(): Promise<void> {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".svg,image/svg+xml";
    const file = await new Promise<File | null>((resolve) => {
      let settled = false;
      const settle = (v: File | null) => { if (!settled) { settled = true; resolve(v); } };
      // `cancel` = picker dismissed with no file; avoids the focus+timeout race
      // that could drop a real selection (see openFile in fileio.ts).
      input.addEventListener("cancel", () => settle(null));
      input.addEventListener("change", () => settle(input.files?.[0] ?? null));
      input.click();
    });
    if (!file) return;

    const text = await file.text();
    const entities = importSvg(text);
    if (entities.length === 0) {
      alert("No supported geometry found in the SVG file.");
      return;
    }
    this.pushHistory();
    for (const e of entities) {
      e.selected = true;
      this.doc.entities.push(e);
    }
    
    if (entities.length >= 2) {
      const group = {
        id: nextId("grp"),
        name: "",
        entityIds: entities.map(e => e.id)
      };
      this.doc.groups.push(group);
    }
    this.doc.emitChange();
  }

  svgExport(): void {
    track("svg_exported");
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
    const raw = localStorage.getItem(StorageKeys.autosaveDraft);
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
      this.warnMissingFonts();
    } catch (e) {
      console.error("Failed to restore draft:", e);
    }
  }
}
