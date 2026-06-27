/**
 * A brief, non-blocking confirmation message that fades in at the bottom of the
 * screen and auto-dismisses. For lightweight "done" feedback (link copied, etc.)
 * where an alert() would be too heavy.
 */
export function toast(message: string, ms = 2600): void {
  const t = document.createElement("div");
  t.setAttribute("role", "status");
  t.textContent = message;
  t.style.cssText = [
    "position:fixed", "bottom:16px", "left:50%", "transform:translateX(-50%)",
    "z-index:10000", "background:var(--panel, #26282f)", "color:var(--text, #d7dae0)",
    "border:1px solid var(--border, #3a3d47)", "border-radius:8px", "padding:8px 16px",
    "box-shadow:0 4px 16px rgba(0,0,0,0.4)", "font:13px/1.5 system-ui,sans-serif",
    "max-width:min(480px, calc(100vw - 32px))", "transition:opacity 0.2s ease",
  ].join(";");

  document.body.appendChild(t);
  const close = () => {
    t.style.opacity = "0";
    setTimeout(() => t.remove(), 200);
  };
  setTimeout(close, ms);
}
