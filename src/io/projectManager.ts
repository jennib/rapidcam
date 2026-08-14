import {
  type CADDocument,
  type DocSnapshot,
  ORIGIN_ENTITY_ID,
  deriveSheet,
  isRotary,
} from "../model/document";
import { getBed } from "../core/prefs";
import { History } from "../model/history";
import { openFile, saveFile, applyFile, serializeDoc, pushRecent } from "./fileio";
import { exportSvg } from "./svgExport";
import { importSvg } from "./svgImport";
import { importDxf } from "./dxfImport";
import {
  repairImportedEntities,
  summarizeRepairs,
  diagnoseImportedEntities,
  summarizeDiagnostics,
  type DxfDiagnostic,
} from "./dxfRepair";
import { exportDxf } from "./dxfExport";
import type { RecentEntry, RcamFile } from "./fileio";
import type { ExampleEntry } from "./examples";
import { nextId } from "../model/ids";
import { TextEntity, RasterImageEntity } from "../model/entities";
import { decodeImageFile, adjustGrey, registerGrey } from "../core/imageManager";
import { openImageAdjustDialog } from "../ui/imageAdjustDialog";
import { isFontResolvable } from "../core/fontManager";
import { isImageResolvable } from "../core/imageManager";
import { openNewProjectDialog } from "../ui/newProjectDialog";
import { buildDesignLink } from "./shareLink";
import { saveDraft, loadDraftData, clearDraft as dropDraft, getDraftMeta } from "./draftStore";
import { loadRecentPayload } from "./recentsStore";
import { copyToClipboard } from "../ui/clipboard";
import { showError } from "../ui/errorNotice";
import { toast } from "../ui/toast";
import { confirmDialog, promptDialog } from "../ui/modal";
import { chooseDxfUnits, recommendDxfUnit } from "../ui/dxfUnitsDialog";
import { selectionBounds } from "../core/transform";
import { MM_PER_INCH } from "../core/units";
import { track } from "../analytics";

export interface ProjectManagerCallbacks {
  onDocumentChange: () => void;
  onSolve: () => void;
  onFitView: () => void;
  onCloseEditors: () => void;
  /** Highlight located DXF-import problems on the canvas (null clears them). */
  onDiagnostics: (diags: DxfDiagnostic[] | null) => void;
}

export class ProjectManager {
  history = new History<DocSnapshot>();
  currentFileName = "Untitled";
  currentFileHandle: FileSystemFileHandle | null = null;
  private isDocumentLoading = false;
  isDirty = false;

  private autosaveTimeout: number | null = null;
  /** Latches once autosave loses its file grant, so the warning is said once. */
  private autosaveToFileFailed = false;

  constructor(
    private doc: CADDocument,
    private cb: ProjectManagerCallbacks,
  ) {
    this.doc.onChange(() => {
      this.markDirty();
      this.scheduleAutosave();
    });
    this.updateTitle();
  }

  // --- title / dirty flag ---
  /**
   * The browser tab is where the open file's name lives — there is no copy of it
   * in the app chrome.
   *
   * The unsaved marker leads rather than trails. A browser truncates a tab title
   * from the RIGHT and shows very few characters when several tabs are open, so
   * a trailing `*` is the first thing to disappear — precisely when the user is
   * scanning tabs to find the one with unsaved work. `●` reads at small sizes
   * where `*` (which sits high and thin) does not.
   */
  updateTitle(): void {
    const name = this.currentFileName;
    document.title = this.isDirty ? `● ${name} — RapidCAM` : `${name} — RapidCAM`;
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
        this.cb.onCloseEditors();
        this.doc.clear();
        this.doc.stockThickness = cfg.stockThickness;
        this.doc.displayUnit = cfg.displayUnit;
        this.doc.origin = { ...cfg.origin };
        this.doc.machineKind = cfg.machineKind;
        this.doc.rotary = cfg.rotary ?? null;
        // What the dialog asks for under "Stock" IS the stock. It used to land on
        // doc.canvas (the sheet) — self-consistent under the old model, where a
        // null stockRect meant "stock fills the sheet", but wrong now that the
        // sheet is derived: you would get a sheet exactly the size of the blank,
        // with no room to draw the clamps that overhang it.
        //
        // A rotary job keeps the old assignment: cfg.width/height are the cylinder
        // length and its circumference, and the canvas IS that unrolled surface,
        // so there is no separate blank to position and nothing to derive.
        if (isRotary(cfg.machineKind)) {
          this.doc.canvas = { width: cfg.width, height: cfg.height };
          this.doc.stockRect = null;
        } else {
          this.doc.stockRect = { x: 0, y: 0, width: cfg.width, height: cfg.height };
          const sheet = deriveSheet(this.doc, getBed());
          if (sheet) this.doc.canvas = { ...sheet };
          // Centre the blank on the generated sheet so the margin is even and
          // there is equal room for hold-downs on every side. That evenness is
          // the whole point: a clamp can overhang any edge, so putting the blank
          // in a corner would leave two sides with nowhere to draw one.
          //
          // Do NOT "simplify" this to (0, 0) to make drawing coordinates match
          // blank coordinates. That was tried and reverted: it buys an alignment
          // that nothing needed — `resolveOrigin` already folds stockRect.x/y
          // into ox/oy, so G-code zero has always been on the blank wherever the
          // blank sits — and it costs the fixture room this margin exists for.
          this.doc.stockRect = {
            x: (this.doc.canvas.width - cfg.width) / 2,
            y: (this.doc.canvas.height - cfg.height) / 2,
            width: cfg.width,
            height: cfg.height,
          };
        }
        this.currentFileName = cfg.name;
        this.currentFileHandle = null;
        dropDraft();
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
    void this.reviewOpenedFile(result.file, result.name);
  }

  /**
   * Post-open review: run the AI Assistant's check pipeline (schema, refs,
   * solve, bounds, G-code dry-run) over a file just opened from disk and,
   * when it finds problems, offer the same copyable fix-it report the
   * paste-import shows. Runs after the document is already on screen —
   * opening is never blocked — and stays silent for clean files, which every
   * file RapidCAM itself saves should be. Disk files are the ones that arrive
   * from outside (hand-edited, AI-generated), so only fileOpen reviews;
   * recents/resume would re-nag every session for a known file.
   */
  private async reviewOpenedFile(file: RcamFile, name: string): Promise<void> {
    try {
      const [{ checkRcamText, buildErrorReport }, { loadSchemaValidator }] = await Promise.all([
        import("./aiCheck"),
        import("../ui/aiAssistantDialog"),
      ]);
      const validator = await loadSchemaValidator();
      const result = checkRcamText(JSON.stringify(file), validator ?? undefined);
      if (result.issues.length === 0) return;
      track("open_check_issues", { issues: result.issues.length });
      const shown = result.issues.slice(0, 8);
      const lines = shown.map((i) => `[${i.check}] ${i.message}`);
      if (result.issues.length > shown.length)
        lines.push(`…and ${result.issues.length - shown.length} more`);
      const n = result.issues.length;
      const copy = await confirmDialog({
        title: `"${name}" opened with ${n} issue${n === 1 ? "" : "s"}`,
        message: lines.join("\n"),
        confirmLabel: "Copy AI fix-it report",
        cancelLabel: "Close",
      });
      if (copy) {
        copyToClipboard(buildErrorReport(result, name));
        toast("Report copied — paste it to the AI (or person) that made the file.");
      }
    } catch {
      // Best-effort review; never let it interfere with opening.
    }
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
    if ("showSaveFilePicker" in window) {
      if (this.currentFileHandle) {
        try {
          const data = await this.writeToHandle(this.currentFileHandle);
          pushRecent({ name: this.currentFileName, savedAt: Date.now(), data });
          dropDraft();
          this.markClean();
          track("project_saved");
          return;
        } catch (e) {
          console.error("Save to file handle failed, prompting for a new file:", e);
        }
      }

      try {
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: this.currentFileName.endsWith(".rcam")
            ? this.currentFileName
            : `${this.currentFileName}.rcam`,
          types: [
            {
              description: "RapidCAM Project (.rcam)",
              accept: { "application/json": [".rcam"] },
            },
          ],
        });
        this.currentFileHandle = handle;
        this.currentFileName = handle.name.replace(/\.rcam$/i, "");
        const data = await this.writeToHandle(handle);
        pushRecent({ name: this.currentFileName, savedAt: Date.now(), data });
        dropDraft();
        this.markClean();
        track("project_saved");
        return;
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        // Anything else used to fall through to the Firefox/Safari branch below,
        // silently swapping a save-to-file for a browser download — the user was
        // told nothing and their handle was quietly abandoned. Say so and stop;
        // a save that did not happen must never look like one that did.
        console.error("Save failed:", e);
        showError(
          `Could not save “${this.currentFileName}”: ${(e as Error).message}. ` +
            "Try File → Save As.",
        );
        return;
      }
    }

    // Fallback for browsers without showSaveFilePicker (Firefox, Safari) — for
    // them this IS Save As, so it gets a real dialog rather than native prompt().
    const name = await promptDialog({
      title: "Save As",
      label: "File name",
      initial: this.currentFileName,
      confirmLabel: "Save",
    });
    if (name === null) return;
    this.currentFileName = name || "Untitled";
    this.currentFileHandle = null;
    saveFile(this.doc, this.currentFileName);
    dropDraft();
    this.markClean();
    track("project_saved");
  }

  /** Copy the serialized .rcam project JSON to the clipboard. */
  copyFileToClipboard(): void {
    const file = serializeDoc(this.doc, this.currentFileName);
    const text = JSON.stringify(file, null, 2);
    copyToClipboard(text);
    toast("Project file copied to clipboard");
  }

  /** Copy a self-contained link to the current design to the clipboard. */
  async copyShareLink(): Promise<void> {
    const { url, tooLong } = await buildDesignLink(this.doc, this.currentFileName);
    if (tooLong) {
      showError(
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
    // `entry.data` is the localStorage copy, stripped of embedded fonts and
    // images to fit the quota — opening THAT is what silently dropped an
    // engrave image. Prefer the faithful IndexedDB payload; fall back to the
    // stripped copy for entries written before that store existed.
    const data = (await loadRecentPayload(entry.name)) ?? entry.data;
    this.loadDocument(data, entry.name);
  }

  /**
   * Load an already-parsed file (AI Assistant paste-import). Unlike a file
   * open, this is usually an AI's *modification of the current design*, so it
   * behaves like an edit, not a load: the pre-import state is pushed onto the
   * undo history (Ctrl+Z reverts a bad import) and the document stays dirty.
   */
  async importChecked(file: RcamFile, name: string): Promise<boolean> {
    const hasWork = this.doc.entities.some((e) => e.id !== ORIGIN_ENTITY_ID);
    if (hasWork) {
      const proceed = await confirmDialog({
        title: "Replace current drawing?",
        message: `This will replace the current drawing with "${name}".\nYou can undo the import afterwards (Ctrl+Z).`,
        confirmLabel: "Replace",
      });
      if (!proceed) return false;
    }
    track("ai_import_loaded");
    this.pushHistory();
    this.isDocumentLoading = true;
    this.cb.onCloseEditors();
    applyFile(this.doc, file);
    this.currentFileName = name;
    // No file handle: a later Save prompts rather than overwriting whatever
    // file the pre-import design came from.
    this.currentFileHandle = null;
    this.cb.onSolve();
    this.cb.onFitView();
    this.isDocumentLoading = false;
    this.markDirty();
    this.updateTitle();
    this.warnMissingFonts();
    this.warnMissingImages();
    return true;
  }

  async loadExample(entry: ExampleEntry): Promise<void> {
    if (!(await this.confirmDiscard(`open example "${entry.name}"`))) return;
    track("example_opened", { name: entry.name });
    // No file handle: a later Save prompts for a new file, leaving the bundled example intact.
    this.loadDocument(entry.file, entry.name);
  }

  /** Shared load path for open-file, open-recent, and draft-restore. */
  loadDocument(
    file: RcamFile,
    name: string,
    handle: FileSystemFileHandle | null = null,
    clearDraft = true,
  ): void {
    this.isDocumentLoading = true;
    this.history = new History<DocSnapshot>();
    this.cb.onCloseEditors();
    applyFile(this.doc, file);
    this.currentFileName = name;
    this.currentFileHandle = handle;
    if (clearDraft) dropDraft();
    this.cb.onSolve();
    this.cb.onFitView();
    this.isDocumentLoading = false;
    this.markClean();
    this.warnMissingFonts();
    this.warnMissingImages();
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
    showError(
      `${missing.length} text item${missing.length > 1 ? "s" : ""} reference a font that ` +
        `isn't available:\n\n${list}\n\nThis text will show as a placeholder and will be ` +
        `omitted from G-code until the font is re-added.`,
    );
  }

  /**
   * The image equivalent of {@link warnMissingFonts}: an image entity whose
   * pixels no resolver holds draws as an empty dashed rect and engraves nothing.
   *
   * This existed as an unused helper (`isImageResolvable`) for a long time while
   * nothing called it, which is how reopening an image design from Recents lost
   * its picture in silence.
   *
   * A long toast rather than the font path's `showError()`. That used to be a
   * blocking-vs-not distinction; now that neither blocks, the reason is what it
   * always should have been: the font report NAMES each affected item, so you
   * need it on screen while you go and fix them, whereas this one is a single
   * sentence about the whole document. It still gets 10s, because the next save
   * bakes the loss into the file.
   */
  private warnMissingImages(): void {
    const missing = this.doc.entities.filter(
      (e): e is RasterImageEntity =>
        e instanceof RasterImageEntity && !isImageResolvable(e.imageId),
    );
    if (missing.length === 0) return;
    toast(
      `${missing.length} image${missing.length > 1 ? "s" : ""} could not be loaded — ` +
        `shown as a dashed outline, and ${missing.length > 1 ? "they" : "it"} will engrave ` +
        `nothing. Re-import the picture before saving, or the file will keep the placeholder.`,
      10000,
    );
  }

  /**
   * Whether we may still write through `handle`, re-prompting if we may not.
   *
   * A File System Access grant is per-handle and NOT permanent: it lapses when
   * the page reloads, and the user can revoke it from the omnibox at any time.
   * Until this existed, nothing ever re-checked — `createWritable()` simply threw
   * `NotAllowedError`, `fileSave` swallowed it and silently fell through to a
   * different save mechanism, and `performAutosave` swallowed it into
   * `console.error`. Both look, from the outside, exactly like "save stopped
   * working", which is what was reported.
   *
   * `requestPermission` needs transient user activation, so it can only succeed
   * on a user-initiated save. `interactive: false` from the autosave path asks
   * the question but never opens a prompt the user did not ask for.
   */
  private async canWriteTo(
    handle: FileSystemFileHandle,
    interactive: boolean,
  ): Promise<boolean> {
    // Not in every browser that has showSaveFilePicker; absent means unrestricted.
    const h = handle as FileSystemFileHandle & {
      queryPermission?: (d: { mode: string }) => Promise<PermissionState>;
      requestPermission?: (d: { mode: string }) => Promise<PermissionState>;
    };
    if (!h.queryPermission) return true;
    try {
      if ((await h.queryPermission({ mode: "readwrite" })) === "granted") return true;
      if (!interactive || !h.requestPermission) return false;
      return (await h.requestPermission({ mode: "readwrite" })) === "granted";
    } catch {
      // Older implementations throw on the descriptor — let the write itself decide.
      return true;
    }
  }

  /**
   * Write the document through `handle`. Throws if the grant is gone and either
   * could not be renewed or `interactive` forbade asking — callers must handle
   * that rather than treating a failed write as a no-op.
   */
  async writeToHandle(handle: FileSystemFileHandle, interactive = true): Promise<RcamFile> {
    if (!(await this.canWriteTo(handle, interactive))) {
      throw new DOMException("Write permission for this file was not granted", "NotAllowedError");
    }
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

  /**
   * Run the pending autosave NOW instead of at the end of its 2s debounce.
   *
   * Called when the page is being hidden or closed. There is deliberately no
   * synchronous variant: `performAutosave` writes to IndexedDB (and possibly a
   * file handle), both async, and neither can be awaited from `beforeunload`.
   * See {@link installLifecycleGuards} for what actually protects the work.
   */
  async flushAutosave(): Promise<void> {
    if (this.autosaveTimeout !== null) {
      clearTimeout(this.autosaveTimeout);
      this.autosaveTimeout = null;
    }
    await this.performAutosave();
  }

  /**
   * Guard unsaved work against the tab being closed. Returns a disposer.
   *
   * Two listeners, doing different jobs:
   *
   *  - **`beforeunload`** asks the browser to show its native "Leave site?"
   *    confirm, but ONLY while the document is dirty — an unconditional prompt
   *    trains people to dismiss it, and then it is not there when it matters.
   *    This is the part that actually saves the work: it hands the user back a
   *    tab they can save from. The message is not ours to write; every current
   *    browser shows its own text and ignores any string we supply.
   *
   *  - **`visibilitychange` → hidden** flushes the pending autosave. The tab is
   *    still alive at that point, so the async IndexedDB write has real time to
   *    land — which closes the up-to-2s window the debounce leaves open. It also
   *    fires on tab-switch, which is free insurance.
   *
   * NOT DONE, on purpose: a synchronous full-document dump to localStorage on
   * unload. A draft here runs to several MB with embedded images, so it would
   * have to be stripped to fit the ~5 MB origin quota — and a cache stripped to
   * fit a quota must never be the thing you restore FROM. That exact bug has bit
   * this project twice (the pre-IndexedDB draft, then recents): the design came
   * back with its image gone and looked like corruption. `draftStore.ts` moved
   * the payload to IndexedDB precisely to stop doing that, and an "emergency
   * backup" in localStorage would walk it straight back in. A prompt the user
   * can act on beats a backup that silently loses their picture.
   */
  installLifecycleGuards(): () => void {
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (!this.isDirty) return;
      e.preventDefault();
      // Legacy browsers gate the prompt on returnValue being set, not on
      // preventDefault. Harmless where it is ignored.
      e.returnValue = "";
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden" && this.isDirty) void this.flushAutosave();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }

  async performAutosave(): Promise<void> {
    if (this.isDocumentLoading) return;

    if (this.currentFileHandle) {
      try {
        // interactive: false — autosave runs off a timer, and a permission
        // prompt the user did not ask for, appearing 2s after they stopped
        // typing, is worse than falling back to the draft. The renewal happens
        // on the next real Save, which HAS the user gesture it needs.
        const data = await this.writeToHandle(this.currentFileHandle, false);
        await saveDraft(this.currentFileName, data);
        this.autosaveToFileFailed = false;
        return;
      } catch (e) {
        console.error("Autosave to file handle failed:", e);
        // Say it ONCE. This runs every 2s, so a repeated toast would be its own
        // bug — but staying completely silent is what made "save stopped
        // working" undiagnosable in the first place. The draft below still
        // captures the work, so this is a warning, not a data-loss event.
        if (!this.autosaveToFileFailed) {
          this.autosaveToFileFailed = true;
          toast(
            `Autosave can no longer write to “${this.currentFileName}” — ` +
              "your work is still being kept in the browser. Use File → Save to restore it.",
            10000,
          );
        }
      }
    }

    const data = serializeDoc(this.doc, this.currentFileName);
    await saveDraft(this.currentFileName, data);
  }

  async imageImport(): Promise<void> {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/bmp,image/gif";
    const file = await new Promise<File | null>((resolve) => {
      let settled = false;
      const settle = (v: File | null) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      input.addEventListener("cancel", () => settle(null));
      input.addEventListener("change", () => settle(input.files?.[0] ?? null));
      input.click();
    });
    if (!file) return;

    let decoded: Awaited<ReturnType<typeof decodeImageFile>>;
    try {
      decoded = await decodeImageFile(file);
    } catch {
      showError("Could not read that image file.");
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
      const widthMM =
        decoded.width >= decoded.height ? maxDim : (maxDim * decoded.width) / decoded.height;
      const heightMM =
        decoded.height >= decoded.width ? maxDim : (maxDim * decoded.height) / decoded.width;
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
      const settle = (v: File | null) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      input.addEventListener("cancel", () => settle(null));
      input.addEventListener("change", () => settle(input.files?.[0] ?? null));
      input.click();
    });
    if (!file) return;

    const text = await file.text();
    let result: ReturnType<typeof importDxf>;
    try {
      const offset = { x: this.doc.stockRect?.x ?? 0, y: this.doc.stockRect?.y ?? 0 };
      result = importDxf(text, { offset });
    } catch (e) {
      showError(`Could not import DXF: ${(e as Error).message}`);
      return;
    }

    // The file didn't say what its units are, and assuming wrong is a silent
    // 25.4× size error. Ask before anything reaches the document — the answer
    // has to be settled up front because the repair pass below welds gaps at
    // absolute mm tolerances, which only mean something at the right scale.
    if (result.units.source === "assumed" && result.entities.length > 0) {
      const bounds = selectionBounds(result.entities);
      if (bounds) {
        const choice = await chooseDxfUnits({
          fileName: file.name,
          bounds,
          recommended: recommendDxfUnit(bounds, result.units.hint),
        });
        if (!choice) return;
        const offset = { x: this.doc.stockRect?.x ?? 0, y: this.doc.stockRect?.y ?? 0 };
        result = importDxf(text, { mmPerUnit: choice === "in" ? MM_PER_INCH : 1, offset });
      }
    }

    const warnings = result.warnings;
    const raw = result.entities;
    if (raw.length === 0) {
      showError(
        "No supported geometry found in the DXF file." +
          (warnings.length ? `\n\n${warnings.join("\n")}` : ""),
      );
      return;
    }

    // Babel: diagnose problems that would stop CAM from chaining the contours.
    const diagnostics = diagnoseImportedEntities(raw);

    this.pushHistory();
    // Place the imported geometry (still untouched) and select it, ready to move.
    for (const e of this.doc.entities) e.selected = false;
    for (const e of raw) {
      e.selected = true;
      e.layerId = this.doc.activeLayerId;
      this.doc.entities.push(e);
    }
    this.doc.emitChange();
    // DXF coordinates land wherever the source CAD put them — bring them into view.
    this.cb.onFitView();

    // Highlight the problems on the canvas and let the user choose to repair
    // before anything is welded or removed.
    let survivors: typeof raw = raw;
    let repairs: string[] = [];
    if (diagnostics.length) {
      this.cb.onDiagnostics(diagnostics);
      const repair = await confirmDialog({
        title: "Repair imported drawing?",
        message:
          `Babel found ${summarizeDiagnostics(diagnostics).join(", ")} in this DXF, ` +
          `highlighted on the canvas.\n\n` +
          `Repairing welds the gaps and removes duplicate / empty entities so CAM can chain the contours.`,
        confirmLabel: "Repair",
        cancelLabel: "Keep as-is",
      });
      this.cb.onDiagnostics(null);
      if (repair) {
        const { entities: kept, report } = repairImportedEntities(raw);
        survivors = kept;
        for (const e of raw) if (!kept.includes(e)) this.doc.remove(e);
        repairs = summarizeRepairs(report);
        this.doc.emitChange();
      }
    }

    // Group the surviving imported geometry so it moves as one unit.
    if (survivors.length >= 2) {
      this.doc.groups.push({
        id: nextId("grp"),
        name: file.name.replace(/\.dxf$/i, ""),
        entityIds: survivors.map((e) => e.id),
      });
      this.doc.emitChange();
    }
    track("dxf_imported", {
      entities: survivors.length,
      issues: diagnostics.length,
      repaired: repairs.length > 0,
      unitSource: result.units.source,
    });

    // Lead with what Babel fixed, then any parser warnings. A scale the user
    // had to supply is echoed back first — it's the one thing they can't check
    // by eye until the drawing is already on the canvas.
    const chosen =
      result.units.source === "override"
        ? [`imported as ${result.units.mmPerUnit === 1 ? "millimeters" : "inches"}`]
        : [];
    const notes = [...chosen, ...repairs, ...warnings];
    if (notes.length) {
      const shown = notes.slice(0, 2).join(" · ");
      toast(`DXF: ${shown}${notes.length > 2 ? ` · +${notes.length - 2} more` : ""}`, 6000);
    }
  }

  async svgImport(): Promise<void> {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".svg,image/svg+xml";
    const file = await new Promise<File | null>((resolve) => {
      let settled = false;
      const settle = (v: File | null) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
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
      showError("No supported geometry found in the SVG file.");
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
        entityIds: entities.map((e) => e.id),
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
    toast(
      `Exported ${this.currentFileName}.dxf${warnings.length ? ` · ${warnings[0]}` : ""}`,
      5000,
    );
  }

  async restoreDraft(): Promise<void> {
    const data = await loadDraftData();
    if (!data) return;
    try {
      this.isDocumentLoading = true;
      this.history = new History<DocSnapshot>();
      this.cb.onCloseEditors();
      applyFile(this.doc, data);
      this.currentFileName = getDraftMeta()?.name ?? this.currentFileName;
      this.currentFileHandle = null;
      this.cb.onSolve();
      this.cb.onFitView();
      this.isDocumentLoading = false;
      this.markClean();
      this.warnMissingFonts();
      this.warnMissingImages();
    } catch (e) {
      console.error("Failed to restore draft:", e);
      this.isDocumentLoading = false;
    }
  }
}
