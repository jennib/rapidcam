/**
 * Rectangular and circular array dialogs.
 * Both create copies of the currently selected entities and add them to the document.
 * Opened from the Edit menu; no toolbar tool needed.
 */

import { CADDocument } from "../model/document";
import { applyRotate } from "../core/transform";

// ---------------------------------------------------------------------------
// Rectangular array

export function openRectArrayDialog(
  doc: CADDocument,
  pushHistory: () => void,
): void {
  if (doc.selected.length === 0) {
    alert("Select entities to array first.");
    return;
  }

  const backdrop = makeBackdrop();
  const dialog   = makeDialog(backdrop, "Rectangular Array");
  const body     = dialog.querySelector(".tp-dialog-body") as HTMLElement;

  const rowsInp = addField(body, "Rows",             "2",  "1");
  const colsInp = addField(body, "Columns",          "3",  "1");
  const dxInp   = addField(body, "X spacing (mm)",   "20", "any");
  const dyInp   = addField(body, "Y spacing (mm)",   "20", "any");

  addFooter(dialog, backdrop, () => {
    const rows = Math.max(1, parseInt(rowsInp.value) || 1);
    const cols = Math.max(1, parseInt(colsInp.value) || 1);
    const dx   = parseFloat(dxInp.value) || 0;
    const dy   = parseFloat(dyInp.value) || 0;
    if (rows === 1 && cols === 1) return;

    const selected = doc.selected;
    pushHistory();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (r === 0 && c === 0) continue;
        for (const ent of selected) {
          const copy = ent.duplicate();
          copy.translate({ x: c * dx, y: r * dy });
          doc.add(copy);
        }
      }
    }
    doc.emitChange();
  });

  document.body.appendChild(backdrop);
}

// ---------------------------------------------------------------------------
// Circular array

export function openCircArrayDialog(
  doc: CADDocument,
  pushHistory: () => void,
): void {
  if (doc.selected.length === 0) {
    alert("Select entities to array first.");
    return;
  }

  // Default centre: average of selection bounding box centres.
  let cx = 0, cy = 0;
  const sel = doc.selected;
  for (const ent of sel) {
    const b = ent.bounds();
    cx += (b.min.x + b.max.x) / 2;
    cy += (b.min.y + b.max.y) / 2;
  }
  cx /= sel.length;
  cy /= sel.length;

  const backdrop = makeBackdrop();
  const dialog   = makeDialog(backdrop, "Circular Array");
  const body     = dialog.querySelector(".tp-dialog-body") as HTMLElement;

  const countInp = addField(body, "Count (total)",   "4",              "1");
  const cxInp    = addField(body, "Centre X (mm)",   cx.toFixed(2),    "any");
  const cyInp    = addField(body, "Centre Y (mm)",   cy.toFixed(2),    "any");

  addFooter(dialog, backdrop, () => {
    const count   = Math.max(2, parseInt(countInp.value) || 2);
    const centerX = parseFloat(cxInp.value) || 0;
    const centerY = parseFloat(cyInp.value) || 0;
    const step    = (2 * Math.PI) / count;

    const selected = doc.selected;
    pushHistory();
    for (let k = 1; k < count; k++) {
      for (const ent of selected) {
        let copy = ent.duplicate();
        // applyRotate mutates in place; capture any entity replacement (e.g. Rect→Poly).
        applyRotate([copy], centerX, centerY, k * step, (_old, newEnt) => { copy = newEnt; });
        doc.add(copy);
      }
    }
    doc.emitChange();
  });

  document.body.appendChild(backdrop);
}

// ---------------------------------------------------------------------------
// DOM helpers

function makeBackdrop(): HTMLElement {
  const el = document.createElement("div");
  el.className = "tp-backdrop";
  el.addEventListener("click", (e) => { if (e.target === el) el.remove(); });
  return el;
}

function makeDialog(backdrop: HTMLElement, title: string): HTMLElement {
  const dialog = document.createElement("div");
  dialog.className = "tp-dialog";
  dialog.style.width = "300px";
  dialog.addEventListener("click", (e) => e.stopPropagation());

  const hdr = document.createElement("div");
  hdr.className = "tp-dialog-header";
  const h3 = document.createElement("h3");
  h3.textContent = title;
  hdr.appendChild(h3);
  dialog.appendChild(hdr);

  const body = document.createElement("div");
  body.className = "tp-dialog-body";
  dialog.appendChild(body);

  backdrop.appendChild(dialog);
  return dialog;
}

function addField(body: HTMLElement, label: string, value: string, step: string): HTMLInputElement {
  const g = document.createElement("div");
  g.className = "tp-field";
  const l = document.createElement("label");
  l.textContent = label;
  const inp = document.createElement("input");
  inp.type = "number";
  inp.className = "dim";
  inp.value = value;
  inp.step = step;
  inp.style.width = "90px";
  g.appendChild(l);
  g.appendChild(inp);
  body.appendChild(g);
  return inp;
}

function addFooter(dialog: HTMLElement, backdrop: HTMLElement, onApply: () => void): void {
  const ftr = document.createElement("div");
  ftr.className = "tp-dialog-footer";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => backdrop.remove());

  const applyBtn = document.createElement("button");
  applyBtn.className = "btn tp-apply-btn";
  applyBtn.textContent = "Create";
  applyBtn.addEventListener("click", () => {
    onApply();
    backdrop.remove();
  });

  ftr.appendChild(cancelBtn);
  ftr.appendChild(applyBtn);
  dialog.appendChild(ftr);
}
