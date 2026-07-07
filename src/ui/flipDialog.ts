/**
 * Flip — the double-sided machining setup dialog.
 *
 * Configures `doc.flip`: the flip direction, registration (dowel pins), and pin
 * geometry, previewing the flip axis and pin holes live on the canvas. It does
 * NOT export — the operator assigns each toolpath a Top/Bottom face in its own
 * dialog, and "Generate G-code" then produces the side-A and side-B programs
 * (see cam/flip.ts and camBar's generate()).
 */

import type { CADDocument, FlipSettings } from "../model/document";
import { defaultPins, defaultFlipSettings } from "../cam/flip";
import type { FlipPreview } from "../view/overlay";
import type { Vec2 } from "../core/vec2";
import { registerModal } from "./modal";

export interface FlipDialogParams {
  doc: CADDocument;
  /** Capture undo state before committing the change. */
  pushHistory?: () => void;
  /** Push flip axis + pin markers to the canvas overlay (null clears). */
  onPreview: (p: FlipPreview | null) => void;
  /** Called after the setup is committed, to refresh the toolpath list (face badges). */
  onDone: () => void;
}

function row(label: string, control: HTMLElement): HTMLElement {
  const r = document.createElement("label");
  r.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;margin:8px 0;font-size:13px;color:var(--text);";
  const l = document.createElement("span");
  l.textContent = label;
  r.append(l, control);
  return r;
}

function numberInput(value: number): HTMLInputElement {
  const i = document.createElement("input");
  i.type = "number";
  i.min = "0";
  i.step = "0.5";
  i.value = String(value);
  i.style.cssText = "width:90px;padding:4px 6px;";
  return i;
}

function select<T extends string>(options: [T, string][], value: T): HTMLSelectElement {
  const s = document.createElement("select");
  s.style.cssText = "padding:4px 6px;";
  for (const [v, label] of options) {
    const o = document.createElement("option");
    o.value = v; o.textContent = label;
    if (v === value) o.selected = true;
    s.appendChild(o);
  }
  return s;
}

export function openFlipDialog(params: FlipDialogParams): void {
  const { doc, onPreview, onDone } = params;

  // Working copy — the live doc.flip is written only on Save.
  const base: FlipSettings = doc.flip
    ? { ...doc.flip, pins: doc.flip.pins.map((p) => ({ ...p })) }
    : defaultFlipSettings(doc);
  let enabled = doc.flip != null;
  // Inset of the two default centreline pins from the stock edge (mm).
  let inset = base.axis === "h"
    ? Math.min(...base.pins.map((p) => Math.min(p.y, doc.canvas.height - p.y)), 15)
    : Math.min(...base.pins.map((p) => Math.min(p.x, doc.canvas.width - p.x)), 15);
  if (!Number.isFinite(inset) || inset <= 0) inset = Math.min(15, Math.min(doc.canvas.width, doc.canvas.height) * 0.2);

  const backdrop = document.createElement("div");
  backdrop.className = "tp-backdrop";
  const dialog = document.createElement("div");
  dialog.className = "tp-dialog";
  dialog.style.width = "420px";
  dialog.addEventListener("click", (e) => e.stopPropagation());
  backdrop.appendChild(dialog);

  const hdr = document.createElement("div");
  hdr.className = "tp-dialog-header";
  const h = document.createElement("h3");
  h.textContent = "Two-sided machining (Flip)";
  hdr.appendChild(h);
  dialog.appendChild(hdr);

  const body = document.createElement("div");
  body.className = "tp-dialog-body";
  dialog.appendChild(body);

  const enableChk = document.createElement("input");
  enableChk.type = "checkbox";
  enableChk.className = "settings-checkbox";
  enableChk.checked = enabled;

  const axisSel = select<"h" | "v">(
    [["h", "Left ↔ right (mirror horizontally)"], ["v", "Near ↔ far (mirror vertically)"]],
    base.axis,
  );
  const regSel = select<"pins" | "none">(
    [["pins", "Dowel pins"], ["none", "None (fence / corner)"]],
    base.registration,
  );
  const diaIn = numberInput(base.pinDiameter);
  const depthIn = numberInput(base.pinDepth);
  const insetIn = numberInput(inset);

  const pinRows = document.createElement("div");
  const diaRow = row("Pin diameter (mm)", diaIn);
  const depthRow = row("Pin depth into spoilboard (mm)", depthIn);
  const insetRow = row("Pin inset from edge (mm)", insetIn);
  pinRows.append(diaRow, depthRow, insetRow);

  body.append(
    row("Enable two-sided", enableChk),
    row("Flip direction", axisSel),
    row("Registration", regSel),
    pinRows,
  );

  const note = document.createElement("div");
  note.style.cssText = "margin-top:10px;font-size:12px;color:var(--muted,#9aa4b2);line-height:1.5;";
  note.innerHTML =
    "Assign each toolpath a <b>Top</b> or <b>Bottom</b> face in its own dialog. " +
    "“Generate G-code” then produces a <b>side A</b> program (top ops + pin holes) and a " +
    "mirrored <b>side B</b> program. Stock thickness must be accurate.";
  body.appendChild(note);

  const warn = document.createElement("div");
  warn.style.cssText = "margin-top:8px;font-size:12px;color:#e5a13a;line-height:1.4;min-height:16px;";
  body.appendChild(warn);

  const ftr = document.createElement("div");
  ftr.className = "tp-dialog-footer";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn";
  cancelBtn.textContent = "Cancel";
  const saveBtn = document.createElement("button");
  saveBtn.className = "btn tp-apply-btn";
  saveBtn.textContent = "Save";
  ftr.append(cancelBtn, saveBtn);
  dialog.appendChild(ftr);

  const working = (): FlipSettings => {
    const axis = axisSel.value as "h" | "v";
    return {
      axis,
      registration: regSel.value as "pins" | "none",
      pinDiameter: Math.max(0.1, Number(diaIn.value) || base.pinDiameter),
      pinDepth: Math.max(0, Number(depthIn.value) || 0),
      pins: regSel.value === "pins" ? defaultPins(doc.canvas, axis, Math.max(0, Number(insetIn.value) || 0)) : [],
    };
  };

  const axisLine = (axis: "h" | "v"): { a: Vec2; b: Vec2 } =>
    axis === "h"
      ? { a: { x: doc.canvas.width / 2, y: 0 }, b: { x: doc.canvas.width / 2, y: doc.canvas.height } }
      : { a: { x: 0, y: doc.canvas.height / 2 }, b: { x: doc.canvas.width, y: doc.canvas.height / 2 } };

  const update = (): void => {
    enabled = enableChk.checked;
    const showPins = enabled && regSel.value === "pins";
    pinRows.style.display = enabled ? "" : "none";
    diaRow.style.display = showPins ? "" : "none";
    depthRow.style.display = showPins ? "" : "none";
    insetRow.style.display = showPins ? "" : "none";
    axisSel.disabled = !enabled;
    regSel.disabled = !enabled;
    if (!enabled) {
      onPreview(null);
      warn.textContent = "";
      return;
    }
    const w = working();
    onPreview({ axis: axisLine(w.axis), pins: w.pins });
    warn.textContent = w.registration === "pins" && w.pins.length === 0
      ? "No pins placed."
      : "";
  };

  for (const el of [axisSel, regSel, diaIn, depthIn, insetIn]) el.addEventListener("input", update);
  enableChk.addEventListener("change", update);

  let settled = false;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    onPreview(null);
    dispose();
    backdrop.remove();
  };
  const dispose = registerModal(backdrop, finish);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) finish(); });
  cancelBtn.addEventListener("click", finish);

  saveBtn.addEventListener("click", () => {
    params.pushHistory?.();
    doc.flip = enableChk.checked ? working() : null;
    doc.emitChange();
    onDone();
    finish();
  });

  document.body.appendChild(backdrop);
  update();
  setTimeout(() => enableChk.focus(), 40);
}
