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
export function registerModal(el: HTMLElement, close: () => void): () => void {
  const entry: ModalEntry = { el, close };
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
    stack[stack.length - 1].close();
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
 */
export function closeAllModals(): void {
  // Copy: each close() mutates the stack via its disposer.
  for (const entry of [...stack]) entry.close();
  document.querySelectorAll<HTMLElement>(ESCAPABLE_SELECTOR).forEach((el) => {
    el.remove();
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
