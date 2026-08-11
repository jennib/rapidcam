// @vitest-environment happy-dom

/**
 * The alert() replacement. These pin the two properties that made it worth
 * building rather than reaching for toast(): it does NOT vanish on its own, and
 * it keeps the shape of a multi-line report.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { showError, dismissError } from "../src/ui/errorNotice";

const notice = () => document.querySelector(".error-notice");
const text = () => document.querySelector(".error-notice-text")?.textContent ?? "";

beforeEach(() => {
  document.body.innerHTML = "";
  dismissError();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("showError", () => {
  it("shows the message", () => {
    showError("Could not read the file.");
    expect(notice()).not.toBeNull();
    expect(text()).toBe("Could not read the file.");
  });

  it("does NOT auto-dismiss — the whole reason it is not a toast", () => {
    vi.useFakeTimers();
    showError("Could not import DXF: unexpected end of input");
    // Well past toast()'s 2.6s, and past any plausible read time.
    vi.advanceTimersByTime(60_000);
    expect(notice(), "the error faded on its own").not.toBeNull();
  });

  it("keeps multi-line reports intact, including their list items", () => {
    const report =
      "2 text items reference a font that isn't available:\n\n" +
      '  • "HELLO"  (font: missing-1)\n' +
      '  • "WORLD"  (font: missing-2)\n\n' +
      "This text will show as a placeholder.";
    showError(report);
    // Every line survives — a toast would have shown the first and dropped the
    // list, which is the part that identifies what to fix.
    expect(text()).toBe(report);
    expect(text().split("\n").filter((l) => l.includes("•"))).toHaveLength(2);
  });

  it("is dismissed by its close button", () => {
    showError("This RapidCAM share link is invalid or corrupted.");
    const close = document.querySelector<HTMLButtonElement>(".error-notice-close");
    expect(close).not.toBeNull();
    close?.click();
    expect(notice()).toBeNull();
  });

  it("replaces the previous notice rather than stacking", () => {
    showError("first");
    showError("second");
    expect(document.querySelectorAll(".error-notice")).toHaveLength(1);
    expect(text()).toBe("second");
  });

  it("announces itself as an alert, not a status", () => {
    showError("Could not read that image file.");
    expect(notice()?.getAttribute("role")).toBe("alert");
  });

  it("dismissError is safe with nothing showing", () => {
    expect(() => dismissError()).not.toThrow();
    dismissError();
    expect(notice()).toBeNull();
  });
});
