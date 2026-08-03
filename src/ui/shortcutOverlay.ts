/**
 * Keyboard-shortcut reference overlay, opened with `?`. The tool rows are
 * generated from TOOL_SHORTCUTS (the same source as the palette tooltips and
 * the keyboard handler) so the list can never drift; the editing/constraint
 * sections are hand-written because those bindings live in app.ts/selectTool.
 */

import { registerModal } from "./modal";
import { TOOL_SHORTCUTS } from "../tools/shortcuts";

const EDITING_KEYS: [string, string][] = [
  ["Ctrl+C / Ctrl+X / Ctrl+V", "Copy / cut / paste"],
  ["Ctrl+D", "Duplicate"],
  ["Ctrl+A", "Select all"],
  ["Arrows (+Shift / +Alt)", "Nudge selection (larger / finer)"],
  ["Delete", "Delete selection"],
  ["Ctrl+Z / Ctrl+Y", "Undo / redo"],
  ["Ctrl+G / Ctrl+Shift+G", "Group / ungroup"],
  ["Ctrl+J / Ctrl+Shift+J", "Join / explode"],
  ["X", "Toggle construction geometry"],
  ["Ctrl+B", "Show / hide the design tree"],
  ["Ctrl while dragging", "Disable snapping for that move"],
  ["Shift + drag", "Marquee select, even starting over objects"],
  ["Space + drag / middle drag", "Pan"],
  ["Escape", "Cancel tool · clear selection"],
];

const CONSTRAINT_KEYS_HELP: [string, string][] = [
  ["H / V", "Horizontal / vertical"],
  ["C", "Coincident"],
  ["P / K", "Parallel / perpendicular"],
  ["E", "Equal"],
];

let open = false;

/** Show the shortcut reference (no-op if it is already up). */
export function showShortcutOverlay(): void {
  if (open) return;
  open = true;

  const backdrop = document.createElement("div");
  backdrop.className = "tp-backdrop";

  const dialog = document.createElement("div");
  dialog.className = "tp-dialog";
  dialog.style.width = "560px";
  dialog.addEventListener("click", (e) => e.stopPropagation());
  backdrop.appendChild(dialog);

  const hdr = document.createElement("div");
  hdr.className = "tp-dialog-header";
  const h = document.createElement("h3");
  h.textContent = "Keyboard shortcuts";
  hdr.appendChild(h);
  dialog.appendChild(hdr);

  const body = document.createElement("div");
  body.className = "tp-dialog-body";
  body.style.cssText = "display:flex;gap:24px;max-height:70vh;overflow-y:auto;";
  dialog.appendChild(body);

  const toolRows: [string, string][] = Object.entries(TOOL_SHORTCUTS).map(([key, id]) => [
    key.toUpperCase(),
    id.charAt(0).toUpperCase() + id.slice(1),
  ]);

  body.appendChild(column("Tools", toolRows));
  const right = document.createElement("div");
  right.style.cssText = "flex:1;display:flex;flex-direction:column;gap:16px;";
  right.appendChild(section("Editing", EDITING_KEYS));
  right.appendChild(section("Constraints (with a selection)", CONSTRAINT_KEYS_HELP));
  body.appendChild(right);

  const ftr = document.createElement("div");
  ftr.className = "tp-dialog-footer";
  const okBtn = document.createElement("button");
  okBtn.className = "btn tp-apply-btn";
  okBtn.textContent = "Close";
  ftr.appendChild(okBtn);
  dialog.appendChild(ftr);

  const dispose = registerModal(backdrop, close);
  function close(): void {
    dispose();
    backdrop.remove();
    open = false;
  }
  okBtn.addEventListener("click", close);
  backdrop.addEventListener("click", close);

  document.body.appendChild(backdrop);

  function column(title: string, rows: [string, string][]): HTMLElement {
    const el = section(title, rows);
    el.style.flex = "1";
    return el;
  }

  function section(title: string, rows: [string, string][]): HTMLElement {
    const wrap = document.createElement("div");
    const t = document.createElement("div");
    t.textContent = title;
    t.style.cssText = "font-size:11px;letter-spacing:0.08em;opacity:0.6;margin-bottom:6px;";
    wrap.appendChild(t);
    for (const [key, label] of rows) {
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;justify-content:space-between;gap:12px;font-size:13px;line-height:1.7;";
      const l = document.createElement("span");
      l.textContent = label;
      const k = document.createElement("span");
      k.className = "fmenu-kbd";
      k.textContent = key;
      row.append(l, k);
      wrap.appendChild(row);
    }
    return wrap;
  }
}
