// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { ProjectManager } from "../src/io/projectManager";
import { CADDocument } from "../src/model/document";

/**
 * Closing the tab with unsaved work.
 *
 * The prompt is the protection — it hands back a tab the user can save from —
 * so the load-bearing behaviour is that it appears when dirty and, just as
 * importantly, does NOT appear when clean. An unconditional prompt trains people
 * to dismiss it, and then it is not there when it matters.
 */

const disposers: (() => void)[] = [];

function manager(): ProjectManager {
  const doc = new CADDocument({ width: 200, height: 200 }, "mm");
  const pm = new ProjectManager(doc, {
    onDocumentChange: () => {},
    onSolve: () => {},
    onFitView: () => {},
    onCloseEditors: () => {},
    onDiagnostics: () => {},
  });
  disposers.push(pm.installLifecycleGuards());
  return pm;
}

/** Dispatch a cancelable beforeunload and report whether anything blocked it. */
function fireBeforeUnload(): boolean {
  const e = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}

afterEach(() => {
  for (const d of disposers.splice(0)) d();
  vi.restoreAllMocks();
});

test("a dirty document blocks the unload", () => {
  const pm = manager();
  pm.markDirty();
  expect(fireBeforeUnload()).toBe(true);
});

test("a clean document does not", () => {
  const pm = manager();
  pm.markClean();
  expect(fireBeforeUnload()).toBe(false);
  // Positive control: the same manager DOES block once dirtied, so the
  // assertion above is passing because the guard consulted isDirty and not
  // because the listener never ran.
  pm.markDirty();
  expect(fireBeforeUnload()).toBe(true);
});

test("the disposer removes the guard", () => {
  const pm = manager();
  pm.markDirty();
  expect(fireBeforeUnload()).toBe(true);
  for (const d of disposers.splice(0)) d();
  expect(fireBeforeUnload()).toBe(false);
});

test("hiding the tab flushes the pending autosave, but only when dirty", async () => {
  const pm = manager();
  const flush = vi.spyOn(pm, "performAutosave").mockResolvedValue();

  Object.defineProperty(document, "visibilityState", {
    value: "hidden",
    configurable: true,
  });

  pm.markClean();
  document.dispatchEvent(new Event("visibilitychange"));
  expect(flush).not.toHaveBeenCalled();

  pm.markDirty();
  document.dispatchEvent(new Event("visibilitychange"));
  expect(flush).toHaveBeenCalledTimes(1);
});

test("flushAutosave cancels the debounce so the write happens once", async () => {
  vi.useFakeTimers();
  const pm = manager();
  const write = vi.spyOn(pm, "performAutosave").mockResolvedValue();

  pm.scheduleAutosave();
  await pm.flushAutosave();
  expect(write).toHaveBeenCalledTimes(1);

  // The pending 2s timer must be gone, not merely beaten to the punch —
  // otherwise every flush is followed by a second, redundant write.
  vi.advanceTimersByTime(5000);
  expect(write).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});
