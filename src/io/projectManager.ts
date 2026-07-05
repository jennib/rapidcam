import { CADDocument, DocSnapshot, ORIGIN_ENTITY_ID } from "../model/document";
import { History } from "../model/history";
import { openFile, saveFile, applyFile, serializeDoc, pushRecent, trySetItem, stripEmbeddedFonts } from "./fileio";
import { exportSvg } from "./svgExport";
import { importSvg } from "./svgImport";
import { importDxf } from "./dxfImport";
import { repairImportedEntities, summarizeRepairs } from "./dxfRepair";
import { exportDxf } from "./dxfExport";
import type { RecentEntry, RcamFile } from "./fileio";
import type { ExampleEntry } from "./examples";
import { nextId } from "../model/ids";
import { TextEntity, RasterImageEntity } from "../model/entities";
import { decodeImageFile, adjustGrey, registerGrey } from "../core/imageManager";
import { openImageAdjustDialog } from "../ui/imageAdjustDialog";
import { isFontResolvable } from "../core/fontManager";
import { openNewProjectDialog } from "../ui/newProjectDialog";
import { buildDesignLink } from "./shareLink";
import { copyToClipboard } from "../ui/clipboard";
import { toast } from "../ui/toast";
import { confirmDialog } from "../ui/modal";
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
    // The discard confirmation now lives inside the dialog as an inline warning
    // (shown only when there's real work), so Cancel truly loses nothing and the
    // drawing is discarded only on Create Project.
    this.openSetupDialog();
  }

  openSetupDialog(): void {
    const hasWork = this.doc.entities.some((e) => e.id !== ORIGIN_ENTITY_ID);
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
        this.doc.machineKind = cfg.machineKind;
        this.currentFileName = cfg.name;
        this.currentFileHandle = null;
        localStorage.removeItem(StorageKeys.autosaveDraft);
        this.doc.emitChange();
        this.cb.onFitView();
        this.isDocumentLoading = false;
        this.markClean();
        track("project_new", { width: cfg.width, height: cfg.height, unit: cfg.displayUnit });
      },
      { hasWork },
    );
  }

  async fileOpen(): Promise<void> {
    if (!(await this.confirmDiscard("open a file"))) return;
    const result = await openFile();
    if (!result) return;
    track("project_opened");
    this.loadDocument(result.file, result.name, result.handle ?? null);
  }

  /**
   * If the current drawing has real work, ask before discarding it. Returns true
   * to proceed (empty drawing, or user confirmed), false to abort.
   */
  private async confirmDiscard(actionLabel: string): Promise<boolean> {
    const hasWork = this.doc.entities.some((e) => e.id !== ORIGIN_ENTITY_ID);
    if (!hasWork) return true;
    return confirmDialog({
      title: "Discard current drawing?",
      message: `This will discard the current drawing to ${actionLabel}.\nSave first if you want to keep it.`,
      confirmLabel: "Discard",
      danger: true,
    });
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

  /** Copy a self-contained link to the current design to the clipboard. */
  async copyShareLink(): Promise<void> {
    const { url, tooLong } = await buildDesignLink(this.doc, this.currentFileName);
    if (tooLong) {
      alert(
        "This design is too large to share as a link.\n\n" +
        "Use File ▸ Save to share the .rcam file instead.",
      );
      return;
    }
    copyToClipboard(url);
    track("design_link_created", { length: url.length });
    toast("Design link copied — anyone with it can open this design.");
  }

  async fileOpenRecent(entry: RecentEntry): Promise<void> {
    if (!(await this.confirmDiscard(`open "${entry.name}"`))) return;
    track("project_opened_recent");
    this.loadDocument(entry.data, entry.name);
  }

  async loadExample(entry: ExampleEntry): Promise<void> {
    if (!(await this.confirmDiscard(`open example "${entry.name}"`))) return;
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

  async imageImport(): Promise<void> {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/bmp,image/gif";
    const file = await new Promise<File | null>((resolve) => {
      let settled = false;
      const settle = (v: File | null) => { if (!settled) { settled = true; resolve(v); } };
      input.addEventListener("cancel", () => settle(null));
      input.addEventListener("change", () => settle(input.files?.[0] ?? null));
      input.click();
    });
    if (!file) return;

    let decoded;
    try {
      decoded = await decodeImageFile(file);
    } catch {
      alert("Could not read that image file.");
      return;
    }

    // Offer an import-time tone adjustment (baked into the stored buffer, so it
    // feeds laser power / mill relief depth identically). "Place" bakes and drops
    // the entity; cancelling aborts the import.
    openImageAdjustDialog(decoded, (adj) => {
      const gray = adjustGrey(decoded.gray, adj);
      const id = registerGrey(decoded.name, decoded.width, decoded.height, gray);

      // Size to fit within ~60% of the smaller work-area dimension, keeping aspect,
      // and centre it on the canvas. The user can then resize/reposition or set an
      // exact size in the properties panel.
      const maxDim = Math.min(this.doc.canvas.width, this.doc.canvas.height) * 0.6;
      const widthMM = decoded.width >= decoded.height ? maxDim : (maxDim * decoded.width) / decoded.height;
      const heightMM = decoded.height >= decoded.width ? maxDim : (maxDim * decoded.height) / decoded.width;
      const pos = {
        x: this.doc.canvas.width / 2 - widthMM / 2,
        y: this.doc.canvas.height / 2 - heightMM / 2,
      };

      this.pushHistory();
      const ent = new RasterImageEntity(id, pos, widthMM, heightMM);
      this.doc.addSelected(ent);
      this.doc.emitChange();
    });
  }

  async dxfImport(): Promise<void> {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".dxf";
    const file = await new Promise<File | null>((resolve) => {
      let settled = false;
      const settle = (v: File | null) => { if (!settled) { settled = true; resolve(v); } };
      input.addEventListener("cancel", () => settle(null));
      input.addEventListener("change", () => settle(input.files?.[0] ?? null));
      input.click();
    });
    if (!file) return;

    const text = await file.text();
    let result;
    try {
      result = importDxf(text);
    } catch (e) {
      alert(`Could not import DXF: ${(e as Error).message}`);
      return;
    }
    const warnings = result.warnings;
    if (result.entities.length === 0) {
      alert(
        "No supported geometry found in the DXF file." +
        (warnings.length ? `\n\n${warnings.join("\n")}` : ""),
      );
      return;
    }
    // Babel: weld gaps, drop duplicates/degenerates so CAM can chain the loops.
    const { entities, report } = repairImportedEntities(result.entities);
    const repairs = summarizeRepairs(report);
    track("dxf_imported", {
      entities: entities.length,
      repaired: report.endpointsWelded + report.duplicatesRemoved
        + report.degenerateRemoved + report.polylinesClosed,
    });
    this.pushHistory();
    // Select exactly the imported geometry so it's ready to move/group.
    for (const e of this.doc.entities) e.selected = false;
    for (const e of entities) {
      e.selected = true;
      e.layerId = this.doc.activeLayerId;
      this.doc.entities.push(e);
    }
    if (entities.length >= 2) {
      this.doc.groups.push({
        id: nextId("grp"),
        name: file.name.replace(/\.dxf$/i, ""),
        entityIds: entities.map((e) => e.id),
      });
    }
    this.doc.emitChange();
    // DXF coordinates land wherever the source CAD put them — bring them into view.
    this.cb.onFitView();
    // Lead with what Babel fixed, then any parser warnings.
    const notes = [...repairs, ...warnings];
    if (notes.length) {
      const shown = notes.slice(0, 2).join(" · ");
      toast(
        `DXF: ${shown}${notes.length > 2 ? ` · +${notes.length - 2} more` : ""}`,
        6000,
      );
    }
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

  dxfExport(): void {
    track("dxf_exported");
    const { dxf, warnings } = exportDxf(this.doc);
    const blob = new Blob([dxf], { type: "application/dxf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${this.currentFileName}.dxf`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`Exported ${this.currentFileName}.dxf${warnings.length ? ` · ${warnings[0]}` : ""}`, 5000);
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
