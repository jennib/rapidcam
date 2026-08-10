// @vitest-environment happy-dom
import { beforeEach, expect, test, describe } from "vitest";
import { buildDialogShell } from "../src/ui/camBar/dialog/dialogDom";
import { StorageKeys } from "../src/core/storageKeys";

/**
 * Where the toolpath dialog opens, and how tall it is allowed to be.
 *
 * This is the tallest dialog in the app and the one whose controls have twice
 * been pushed out of reach (`e2e/unreachable-controls.e2e.ts` exists for it), so
 * its geometry is worth pinning. happy-dom has no layout engine, but these are
 * inline styles the code computes rather than anything the browser resolves —
 * which is exactly the part that has gone wrong.
 *
 * Two caps used to fight each other: the default top came from the right panel
 * (below the toolbars) and `max-height` was a constant 82vh, so the dialog
 * started low AND stopped short of the bottom, and dragging it up gained
 * nothing.
 */

const openShell = () => buildDialogShell(true, () => {});
/** The px number out of an inline style like "12px". */
const px = (v: string) => parseFloat(v);

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("default placement", () => {
  test("opens near the top of the WINDOW, not below the toolbars", () => {
    const { dialog } = openShell();
    // The old behaviour took the right panel's top, which sits under the
    // constraint and align bars — bars that are empty at this x, so the height
    // was given up for nothing.
    expect(px(dialog.style.top)).toBeLessThanOrEqual(16);
  });

  test("is tall enough to reach the bottom of the window", () => {
    const { dialog } = openShell();
    const top = px(dialog.style.top);
    const maxH = px(dialog.style.maxHeight);
    // Fills the remaining height, give or take the bottom margin.
    expect(top + maxH).toBeGreaterThan(window.innerHeight - 24);
    expect(top + maxH).toBeLessThanOrEqual(window.innerHeight);
  });
});

describe("a remembered position", () => {
  test("is honoured when it carries the current version", () => {
    localStorage.setItem(
      StorageKeys.toolpathDialogPosition,
      JSON.stringify({ v: 1, left: "300px", top: "200px" }),
    );
    const { dialog } = openShell();
    expect(px(dialog.style.left)).toBe(300);
    expect(px(dialog.style.top)).toBe(200);
  });

  test("still fills to the bottom from wherever it was dragged", () => {
    // The point of deriving height from the top rather than from a constant
    // fraction: dragging the dialog upward has to actually gain height.
    localStorage.setItem(
      StorageKeys.toolpathDialogPosition,
      JSON.stringify({ v: 1, left: "300px", top: "40px" }),
    );
    const { dialog } = openShell();
    expect(px(dialog.style.top) + px(dialog.style.maxHeight)).toBeGreaterThan(
      window.innerHeight - 24,
    );
  });

  test("an UNVERSIONED position is discarded, so the new default wins once", () => {
    // The report that prompted this: the dialog still opened under the align
    // bar, because a position saved in an earlier session restored exactly the
    // placement this change removes — and nothing on screen says a localStorage
    // entry is why.
    localStorage.setItem(
      StorageKeys.toolpathDialogPosition,
      JSON.stringify({ left: "300px", top: "170px" }),
    );
    const { dialog } = openShell();
    expect(px(dialog.style.top)).toBeLessThanOrEqual(16);
  });

  test("malformed storage is ignored rather than thrown on", () => {
    localStorage.setItem(StorageKeys.toolpathDialogPosition, "{not json");
    expect(() => openShell()).not.toThrow();
    localStorage.setItem(StorageKeys.toolpathDialogPosition, JSON.stringify({ v: 1 }));
    const { dialog } = openShell();
    expect(px(dialog.style.top)).toBeLessThanOrEqual(16);
  });
});

describe("clamping", () => {
  test("a position past the bottom edge still leaves a usable dialog", () => {
    localStorage.setItem(
      StorageKeys.toolpathDialogPosition,
      JSON.stringify({ v: 1, left: "10px", top: `${window.innerHeight + 500}px` }),
    );
    const { dialog } = openShell();
    // Clamped on screen, and never shrunk to a sliver.
    expect(px(dialog.style.top)).toBeLessThan(window.innerHeight);
    expect(px(dialog.style.maxHeight)).toBeGreaterThanOrEqual(220);
  });

  test("a position off the right edge is pulled back", () => {
    localStorage.setItem(
      StorageKeys.toolpathDialogPosition,
      JSON.stringify({ v: 1, left: `${window.innerWidth + 900}px`, top: "20px" }),
    );
    const { dialog } = openShell();
    expect(px(dialog.style.left)).toBeLessThan(window.innerWidth);
  });
});
