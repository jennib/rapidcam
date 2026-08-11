/**
 * A non-blocking, persistent error notice — the replacement for native `alert()`.
 *
 * **Not a toast.** Every caller is reporting a failure the user may need to read
 * carefully: one interpolates an exception message, another enumerates every
 * text item whose font is missing, a third appends the DXF importer's warning
 * list. `toast()` fades after 2.6 seconds, and that exact failure mode has
 * already been hit in this app — import warnings once lived in a 6-second toast
 * that showed only the first of them.
 *
 * **Not a modal either.** `alert()` blocked the main thread, which froze the
 * render loop and any in-flight solve, left these paths untestable under
 * Playwright, and produced at least two misdiagnosed bugs: a raster-engrave
 * "Apply hang" that was really an alert in headless Chrome, and a rageclick
 * report that was the same thing. Nothing here needs to block — every call site
 * is telling the user about an operation that has *already* stopped.
 *
 * Persistent-and-dismissible follows `.dim-error` in dimEditor.ts, which reached
 * the same conclusion for dimension errors after a 2.5s flash proved too short
 * to read.
 */

let current: HTMLElement | null = null;

/** Remove the visible error notice, if any. */
export function dismissError(): void {
  current?.remove();
  current = null;
}

/**
 * Show `message` until the user dismisses it. Newlines are preserved, so the
 * multi-line reports keep their shape.
 */
export function showError(message: string): void {
  // One at a time. A stack of these would cover the canvas, and the newest is
  // almost always the one explaining what just happened.
  dismissError();

  const box = document.createElement("div");
  box.className = "error-notice";
  // "alert" (not "status") so a screen reader interrupts — this is a failure.
  box.setAttribute("role", "alert");

  const text = document.createElement("div");
  text.className = "error-notice-text";
  text.textContent = message;
  box.appendChild(text);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "error-notice-close";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "✕";
  close.addEventListener("click", dismissError);
  box.appendChild(close);

  document.body.appendChild(box);
  current = box;
}
