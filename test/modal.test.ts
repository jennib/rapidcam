// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vitest";
import { closeAllModals, confirmDialog, isModalOpen, registerModal } from "../src/ui/modal";

/**
 * The shared modal spine. 23 files call `registerModal`, and the behaviours it
 * exists to provide are exactly the ones no other test can see: every e2e spec
 * proves "a dialog opens and closes", which keeps working even if the stack,
 * Escape handling or `closeAllModals` regress.
 *
 * All three were real bugs before this module existed (6334a63): global
 * shortcuts firing while a dialog was up, and dialogs left stranded across a
 * New Project / file load.
 *
 * NOTE for anyone extending this file: do NOT `vi.resetModules()`. modal.ts
 * registers its Escape listener at import time, so re-importing stacks a second
 * listener on the same window and every Escape then closes two modals. The
 * module is imported once and its module-level stack is drained between tests
 * instead.
 */

/** A dialog shell of the given class, registered like a real dialog would be. */
function openModal(cls = "tp-backdrop"): { el: HTMLElement; closed: () => number } {
  const el = document.createElement("div");
  el.className = cls;
  document.body.appendChild(el);
  let closes = 0;
  const dispose = registerModal(el, () => {
    closes++;
    dispose();
    el.remove();
  });
  return { el, closed: () => closes };
}

const pressEscape = () =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

afterEach(() => {
  // Drain the module-level stack so one test can't leak a modal into the next.
  closeAllModals();
  document.body.innerHTML = "";
});

describe("modal stack", () => {
  test("isModalOpen is false with nothing open, true once one registers", () => {
    expect(isModalOpen()).toBe(false);
    openModal();
    expect(isModalOpen()).toBe(true);
  });

  test("isModalOpen also sees an UNregistered backdrop", () => {
    // The DOM fallback is what stops a dialog that forgot to register from
    // letting global shortcuts (Ctrl+N, Delete, tool keys) fire behind it.
    const stray = document.createElement("div");
    stray.className = "tp-backdrop";
    document.body.appendChild(stray);
    expect(isModalOpen()).toBe(true);
  });

  test("the disposer removes the entry, so a closed modal stops counting", () => {
    const el = document.createElement("div");
    el.className = "tp-backdrop";
    const dispose = registerModal(el, () => {});
    expect(isModalOpen()).toBe(true);
    dispose();
    expect(isModalOpen()).toBe(false);
  });
});

describe("Escape", () => {
  test("closes the TOPMOST modal only, leaving the one beneath open", () => {
    // A confirm raised from inside a manager dialog is the real case: Escape
    // must dismiss the confirm and leave the manager standing.
    const under = openModal();
    const over = openModal();

    pressEscape();
    expect(over.closed()).toBe(1);
    expect(under.closed()).toBe(0);

    pressEscape();
    expect(under.closed()).toBe(1);
  });

  test("runs the modal's OWN close, not a bare DOM removal", () => {
    // Dialogs clean up through their close callback (unregistering, restoring
    // state); removing the element behind their back would skip that.
    let ranOwnCleanup = false;
    const el = document.createElement("div");
    el.className = "tp-backdrop";
    document.body.appendChild(el);
    const dispose = registerModal(el, () => {
      ranOwnCleanup = true;
      dispose();
      el.remove();
    });

    pressEscape();
    expect(ranOwnCleanup).toBe(true);
  });

  test("falls back to removing an unregistered backdrop", () => {
    const stray = document.createElement("div");
    stray.className = "tp-backdrop";
    document.body.appendChild(stray);

    pressEscape();
    expect(document.querySelector(".tp-backdrop")).toBeNull();
  });

  test("does not dismiss the welcome/start overlay", () => {
    // The start surface is not an editor dialog — Escape must not drop the user
    // onto an empty canvas with no project.
    const welcome = document.createElement("div");
    welcome.className = "welcome-backdrop";
    document.body.appendChild(welcome);

    pressEscape();
    expect(document.querySelector(".welcome-backdrop")).not.toBeNull();
  });

  test("does not dismiss a modal registered with escapable: false", () => {
    let closes = 0;
    const el = document.createElement("div");
    el.className = "tp-backdrop";
    document.body.appendChild(el);
    const dispose = registerModal(
      el,
      () => {
        closes++;
        dispose();
        el.remove();
      },
      { escapable: false },
    );

    pressEscape();
    expect(closes).toBe(0);
    expect(isModalOpen()).toBe(true);

    // closeAllModals still cleans it up
    closeAllModals();
    expect(closes).toBe(1);
  });

  test("is inert when nothing is open", () => {
    expect(() => pressEscape()).not.toThrow();
    expect(isModalOpen()).toBe(false);
  });
});

describe("closeAllModals", () => {
  test("closes every registered modal through its own cleanup", () => {
    // Called on document swap (New Project, file open, draft restore) so a
    // dialog can't act on a document that no longer exists.
    const a = openModal();
    const b = openModal();

    closeAllModals();
    expect(a.closed()).toBe(1);
    expect(b.closed()).toBe(1);
    expect(isModalOpen()).toBe(false);
  });

  test("also sweeps unregistered backdrops, but spares the welcome overlay", () => {
    const stray = document.createElement("div");
    stray.className = "tp-backdrop";
    document.body.appendChild(stray);
    const welcome = document.createElement("div");
    welcome.className = "welcome-backdrop";
    document.body.appendChild(welcome);

    closeAllModals();
    expect(document.querySelector(".tp-backdrop")).toBeNull();
    expect(document.querySelector(".welcome-backdrop")).not.toBeNull();
  });
});

describe("confirmDialog", () => {
  const footerButtons = () =>
    [...document.querySelectorAll(".tp-dialog-footer button")] as HTMLButtonElement[];

  test("resolves true on confirm and false on cancel", async () => {
    const yes = confirmDialog({ title: "T", message: "m" });
    footerButtons().find((b) => b.textContent === "OK")?.click();
    expect(await yes).toBe(true);

    const no = confirmDialog({ title: "T", message: "m" });
    footerButtons().find((b) => b.textContent === "Cancel")?.click();
    expect(await no).toBe(false);
  });

  test("Escape resolves false rather than leaving the caller hanging", async () => {
    const p = confirmDialog({ title: "T", message: "m" });
    pressEscape();
    expect(await p).toBe(false);
  });

  test("a backdrop click resolves false; a click inside the dialog does not", async () => {
    const p = confirmDialog({ title: "T", message: "m" });
    const backdrop = document.querySelector(".tp-backdrop") as HTMLElement;
    (backdrop.querySelector(".tp-dialog") as HTMLElement).click();

    // Still pending — a stray click inside must not dismiss it.
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    backdrop.click();
    expect(await p).toBe(false);
  });

  test("custom labels and the danger style are applied", async () => {
    const p = confirmDialog({
      title: "Delete",
      message: "gone",
      confirmLabel: "Delete",
      cancelLabel: "Keep",
      danger: true,
    });
    const [cancel, ok] = footerButtons();
    expect(cancel.textContent).toBe("Keep");
    expect(ok.textContent).toBe("Delete");
    expect(ok.classList.contains("tp-danger-btn")).toBe(true);
    ok.click();
    expect(await p).toBe(true);
  });

  test("a second click on the confirm button is harmless", async () => {
    // NOT a test of confirmDialog's internal `settled` flag: removing that guard
    // changes nothing observable here, because every step it protects is already
    // idempotent (the disposer no-ops on a missing entry, `remove()` on a
    // detached node no-ops, and re-resolving a settled promise is a no-op in JS).
    // Verified by mutation — dropping the guard leaves this suite green.
    // What this DOES pin is the user-visible property: a double-click resolves
    // true exactly once and leaves no modal behind. It would start earning its
    // keep the moment anyone adds non-idempotent cleanup to `finish`.
    const p = confirmDialog({ title: "T", message: "m" });
    const ok = footerButtons().find((b) => b.textContent === "OK") as HTMLButtonElement;
    ok.click();
    ok.click();
    expect(await p).toBe(true);
    expect(isModalOpen()).toBe(false);
  });

  test("it leaves the stack clean, so it can't block shortcuts afterwards", async () => {
    const p = confirmDialog({ title: "T", message: "m" });
    footerButtons().find((b) => b.textContent === "OK")?.click();
    await p;
    expect(isModalOpen()).toBe(false);
    expect(document.querySelector(".tp-backdrop")).toBeNull();
  });

  test("renders each line of a multi-line message separately", async () => {
    const p = confirmDialog({ title: "T", message: "one\ntwo" });
    const body = document.querySelector(".tp-dialog-body") as HTMLElement;
    expect([...body.children].map((c) => c.textContent)).toEqual(["one", "two"]);
    footerButtons().find((b) => b.textContent === "Cancel")?.click();
    await p;
  });
});

describe("nesting", () => {
  test("a confirm raised over a dialog closes only itself on Escape", async () => {
    // The exact shape of the preset manager's delete flow.
    const host = openModal();
    const p = confirmDialog({ title: "Delete", message: "sure?", danger: true });

    pressEscape();
    expect(await p).toBe(false);
    expect(host.closed(), "the host dialog must survive its own confirm").toBe(0);
    expect(isModalOpen()).toBe(true); // host still up
  });
});

afterEach(() => {
  vi.useRealTimers();
});
