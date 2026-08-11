/**
 * Central registry for the app's modal dialogs.
 *
 * The dialogs each build their own `.tp-backdrop` / `.welcome-backdrop` shell,
 * but they historically shared no notion of "a modal is open". That let global
 * keyboard shortcuts (Ctrl+N, undo, Delete, single-key tool switches) fire while
 * a dialog was up, and left dialogs stranded across a New Project / file load.
 *
 * This module gives them a common spine:
 *  - {@link registerModal} — a dialog registers its backdrop + close callback so
 *    Escape and {@link closeAllModals} can dismiss it *with its own cleanup*.
 *  - {@link isModalOpen} — gate global shortcuts (also true for un-registered
 *    dialogs, via a DOM fallback, so nothing slips through).
 *  - {@link closeAllModals} — called on document swap so no dialog outlives its
 *    document.
 *  - {@link confirmDialog} — a styled, promise-based replacement for the native
 *    `confirm()` (which blocks headless automation and clashes with the chrome).
 *
 * A single capture-phase Escape listener closes the topmost modal.
 */

interface ModalEntry {
  el: HTMLElement;
  close: () => void;
  escapable?: boolean;
  keepOnDocumentSwap?: boolean;
}

const stack: ModalEntry[] = [];

/** Backdrop classes that count as "a modal" for shortcut-gating purposes. */
const BACKDROP_SELECTOR = ".tp-backdrop, .welcome-backdrop";
/** Editor dialogs Escape may dismiss (excludes the welcome/start overlay). */
const ESCAPABLE_SELECTOR = ".tp-backdrop";

/**
 * Register an open modal. Call after building the backdrop and defining its
 * close function; call the returned disposer from inside that close function so
 * the entry leaves the stack exactly once.
 */
export function registerModal(
  el: HTMLElement,
  close: () => void,
  opts: { escapable?: boolean; keepOnDocumentSwap?: boolean } = {},
): () => void {
  const entry: ModalEntry = {
    el,
    close,
    escapable: opts.escapable ?? true,
    keepOnDocumentSwap: opts.keepOnDocumentSwap ?? false,
  };
  stack.push(entry);
  return () => {
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** True while any dialog is open (registered, or a stray backdrop in the DOM). */
export function isModalOpen(): boolean {
  return stack.length > 0 || document.querySelector(BACKDROP_SELECTOR) != null;
}

/** Close the topmost modal (registered first, else the last editor backdrop). */
function closeTopModal(): void {
  if (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top.escapable !== false) {
      top.close();
    }
    return;
  }
  const backs = document.querySelectorAll<HTMLElement>(ESCAPABLE_SELECTOR);
  backs[backs.length - 1]?.remove();
}

/**
 * Dismiss every editor dialog — used when the document is replaced (New Project,
 * file open, draft restore) so a dialog can't act on a document that's gone.
 * Registered modals close via their own cleanup; any un-registered editor
 * backdrops are removed as a fallback. The welcome/start overlay is left alone.
 *
 * A modal registered with `keepOnDocumentSwap` survives. That is for the dialog
 * that *caused* the swap and still has something to say about the document that
 * arrived — the AI Assistant, whose import warnings describe the file it just
 * loaded. Closing it there was how those warnings ended up with nowhere to live
 * but a toast.
 */
export function closeAllModals(): void {
  // Copy: each close() mutates the stack via its disposer.
  for (const entry of [...stack]) {
    if (!entry.keepOnDocumentSwap) entry.close();
  }
  const keep = new Set(stack.filter((e) => e.keepOnDocumentSwap).map((e) => e.el));
  document.querySelectorAll<HTMLElement>(ESCAPABLE_SELECTOR).forEach((el) => {
    if (!keep.has(el)) el.remove();
  });
}

// Capture phase so this beats the app's window-level keydown handler.
// Guarded so importing this module in a non-DOM env (e.g. vitest/node, reached
// transitively via a tool that imports a dialog) doesn't throw at import time.
if (typeof window !== "undefined") {
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !isModalOpen()) return;
      // Don't hijack Escape while typing in a field inside the dialog unless it's
      // the only reasonable action; dialogs with their own field-level Escape
      // (e.g. cancelling an inline edit) still work because we only close the
      // topmost modal here, matching what the user expects from a dialog.
      e.preventDefault();
      e.stopPropagation();
      closeTopModal();
    },
    true,
  );
}

// ---- styled confirm ---------------------------------------------------------

export interface ConfirmOptions {
  title: string;
  /** Body message. Use `\n` for line breaks; rendered as separate lines. */
  message: string;
  /** Confirm-button label. Default "OK". */
  confirmLabel?: string;
  /** Cancel-button label. Default "Cancel". */
  cancelLabel?: string;
  /** Style the confirm button as destructive (red). Default false. */
  danger?: boolean;
  /** Use the non-dimming side-docked backdrop so the canvas stays visible
   *  behind the dialog (e.g. pre-flight findings highlighting geometry). */
  peek?: boolean;
}

/**
 * A styled, promise-based confirm. Resolves true if the user confirms, false on
 * Cancel / Escape / backdrop-click. Replaces native `confirm()`.
 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = opts.peek ? "tp-backdrop tp-backdrop--peek" : "tp-backdrop";

    const dialog = document.createElement("div");
    dialog.className = "tp-dialog";
    dialog.style.width = "360px";
    dialog.addEventListener("click", (e) => e.stopPropagation());
    backdrop.appendChild(dialog);

    const hdr = document.createElement("div");
    hdr.className = "tp-dialog-header";
    const h = document.createElement("h3");
    h.textContent = opts.title;
    hdr.appendChild(h);
    dialog.appendChild(hdr);

    const body = document.createElement("div");
    body.className = "tp-dialog-body";
    for (const line of opts.message.split("\n")) {
      const p = document.createElement("div");
      p.textContent = line;
      p.style.fontSize = "13px";
      p.style.color = "var(--text)";
      p.style.lineHeight = "1.5";
      if (line === "") p.style.height = "6px";
      body.appendChild(p);
    }
    dialog.appendChild(body);

    const ftr = document.createElement("div");
    ftr.className = "tp-dialog-footer";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn";
    cancelBtn.textContent = opts.cancelLabel ?? "Cancel";
    const okBtn = document.createElement("button");
    okBtn.className = opts.danger ? "btn tp-danger-btn" : "btn tp-apply-btn";
    okBtn.textContent = opts.confirmLabel ?? "OK";
    ftr.appendChild(cancelBtn);
    ftr.appendChild(okBtn);
    dialog.appendChild(ftr);

    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      dispose();
      backdrop.remove();
      resolve(result);
    };
    const close = () => finish(false);
    const dispose = registerModal(backdrop, close);

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) finish(false);
    });
    cancelBtn.addEventListener("click", () => finish(false));
    okBtn.addEventListener("click", () => finish(true));

    document.body.appendChild(backdrop);
    // Synchronously, NOT on a timer.
    //
    // Every dialog in this app used to defer its opening focus by 40-50ms, and
    // it was never buying anything: these dialogs have no open animation and no
    // layout to settle (no `animation`/`transition` on .tp-backdrop or
    // .tp-dialog), and the element is in the document by this line. What the
    // delay DID do was leave a window where a focusable dialog is about to move
    // focus somewhere else, so anything typed in it lands in the wrong control —
    // and where the target is select()ed, replaces its contents.
    //
    // That is a real input bug for a fast user, and it made the e2e suite fail
    // about one run in three, presenting as wrong VALUES with no hint that focus
    // was involved (see newProjectDialog.ts, where a typed stock width ended up
    // in the project name box). Focus on open, immediately, everywhere.
    okBtn.focus();
  });
}

// ---- styled prompt ----------------------------------------------------------

export interface PromptOptions {
  title: string;
  /** Label above the input. */
  label: string;
  /** Pre-filled value, selected on open so typing replaces it. */
  initial?: string;
  /** Confirm-button label. Default "OK". */
  confirmLabel?: string;
  placeholder?: string;
}

/**
 * A styled, promise-based text prompt. Resolves the entered string, or null on
 * Cancel / Escape / backdrop-click. Replaces native `prompt()`.
 *
 * Its one caller is the Save-As fallback for browsers without
 * `showSaveFilePicker` — so in Chrome you will never see it, but on Firefox and
 * Safari it IS the Save-As dialog.
 */
export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "tp-backdrop";

    const dialog = document.createElement("div");
    // `tp-prompt` is a stable handle for tests: several dialogs can be open at
    // once (this one is usually raised FROM another), so `.tp-dialog` alone is
    // ambiguous, and matching on the title text is how selectors go brittle.
    dialog.className = "tp-dialog tp-prompt";
    dialog.style.width = "360px";
    dialog.addEventListener("click", (e) => e.stopPropagation());
    backdrop.appendChild(dialog);

    const hdr = document.createElement("div");
    hdr.className = "tp-dialog-header";
    const h = document.createElement("h3");
    h.textContent = opts.title;
    hdr.appendChild(h);
    dialog.appendChild(hdr);

    const body = document.createElement("div");
    body.className = "tp-dialog-body";
    const lab = document.createElement("label");
    lab.textContent = opts.label;
    lab.style.cssText = "display:block;font-size:13px;color:var(--text);margin-bottom:6px;";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "tp-input";
    input.value = opts.initial ?? "";
    if (opts.placeholder) input.placeholder = opts.placeholder;
    input.style.cssText =
      "width:100%;box-sizing:border-box;background:var(--panel);border:1px solid var(--border);" +
      "border-radius:4px;color:var(--text);font-size:13px;padding:6px 8px;";
    lab.appendChild(input);
    body.appendChild(lab);
    dialog.appendChild(body);

    const ftr = document.createElement("div");
    ftr.className = "tp-dialog-footer";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn";
    cancelBtn.textContent = "Cancel";
    const okBtn = document.createElement("button");
    okBtn.className = "btn tp-apply-btn";
    okBtn.textContent = opts.confirmLabel ?? "OK";
    ftr.appendChild(cancelBtn);
    ftr.appendChild(okBtn);
    dialog.appendChild(ftr);

    let settled = false;
    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      dispose();
      backdrop.remove();
      resolve(result);
    };
    const close = () => finish(null);
    const dispose = registerModal(backdrop, close);

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) finish(null);
    });
    cancelBtn.addEventListener("click", () => finish(null));
    okBtn.addEventListener("click", () => finish(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(input.value);
      }
      // Escape is left to the modal registry's capture-phase handler.
      e.stopPropagation();
    });

    document.body.appendChild(backdrop);
    // Synchronously — see the note in confirmDialog above. The input is the
    // focus target here, so a deferred focus() + select() is exactly the bug
    // that note describes.
    input.focus();
    input.select();
  });
}
