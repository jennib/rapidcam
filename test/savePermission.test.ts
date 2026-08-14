// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { ProjectManager } from "../src/io/projectManager";
import { CADDocument } from "../src/model/document";

/**
 * File System Access grants are per-handle and NOT permanent — they lapse on
 * reload and the user can revoke them from the omnibox. Nothing used to
 * re-check, so `createWritable()` threw, `fileSave` swallowed it and silently
 * fell through to a browser download, and `performAutosave` swallowed it into
 * `console.error`. From the outside that is exactly "save stopped working".
 *
 * The load-bearing behaviours: a lapsed grant is RE-REQUESTED on a user save,
 * and never prompted for from the autosave timer.
 */

function manager() {
  const doc = new CADDocument({ width: 200, height: 200 }, "mm");
  return new ProjectManager(doc, {
    onDocumentChange: () => {},
    onSolve: () => {},
    onFitView: () => {},
    onCloseEditors: () => {},
    onDiagnostics: () => {},
  });
}

/** A handle whose grant state we control, recording what was asked of it. */
function handle(state: PermissionState, granted: PermissionState = "granted") {
  const writable = { write: vi.fn(), close: vi.fn() };
  return {
    name: "x.rcam",
    queryPermission: vi.fn(async () => state),
    requestPermission: vi.fn(async () => granted),
    createWritable: vi.fn(async () => writable),
    writable,
  };
}

afterEach(() => vi.restoreAllMocks());

test("an already-granted handle is written without re-prompting", async () => {
  const pm = manager();
  const h = handle("granted");
  await pm.writeToHandle(h as never);
  expect(h.requestPermission).not.toHaveBeenCalled();
  expect(h.createWritable).toHaveBeenCalledTimes(1);
});

test("a lapsed grant is re-requested on a user save, then written", async () => {
  const pm = manager();
  const h = handle("prompt", "granted");
  await pm.writeToHandle(h as never, true);
  expect(h.requestPermission).toHaveBeenCalledTimes(1);
  expect(h.createWritable).toHaveBeenCalledTimes(1);
});

test("a refused grant throws instead of silently not saving", async () => {
  const pm = manager();
  const h = handle("prompt", "denied");
  await expect(pm.writeToHandle(h as never, true)).rejects.toThrow(/not granted/i);
  // The critical part: nothing was written, and the caller was told.
  expect(h.createWritable).not.toHaveBeenCalled();
});

test("the autosave path never opens a permission prompt", async () => {
  const pm = manager();
  const h = handle("prompt", "granted");
  await expect(pm.writeToHandle(h as never, false)).rejects.toThrow(/not granted/i);
  expect(h.requestPermission).not.toHaveBeenCalled();
  // Positive control: the same lapsed handle DOES prompt when interactive, so
  // the assertion above is about the flag and not about the handle's state.
  const h2 = handle("prompt", "granted");
  await pm.writeToHandle(h2 as never, true);
  expect(h2.requestPermission).toHaveBeenCalledTimes(1);
});

test("a browser without queryPermission is treated as unrestricted", async () => {
  const pm = manager();
  const h = { name: "x.rcam", createWritable: vi.fn(async () => ({ write: vi.fn(), close: vi.fn() })) };
  await pm.writeToHandle(h as never, false);
  expect(h.createWritable).toHaveBeenCalledTimes(1);
});
