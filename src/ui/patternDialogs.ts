/**
 * Parametric Linear Pattern and Circular Pattern dialogs.
 *
 * Both dialogs record a PatternDef in the document so that re-opening the
 * dialog (when a pattern entity is selected) shows the original parameters and
 * lets you update them.  Re-applying deletes the previous copies and regenerates
 * them from the current state of the source geometry.
 *
 * Spacing fields accept plain numbers (mm) OR expressions referencing
 * document variables (e.g. "pitch", "pitch * 2").
 */

import { CADDocument } from "../model/document";
import { Entity } from "../model/entities";
import { PatternDef, LinearPatternParams, CircularPatternParams } from "../model/patterns";
import {
  createLinearPattern,
  regenerateLinearPattern,
  createCircularPattern,
  regenerateCircularPattern,
} from "../model/patternEngine";
import { varMap } from "../model/variables";
import { evalExpr } from "../core/expr";

// ---------------------------------------------------------------------------
// Public entry points

export function openLinearPatternDialog(doc: CADDocument, pushHistory: () => void): void {
  const existing = findPatternInSelection(doc, "linear");
  if (existing) {
    buildLinearDialog(doc, pushHistory, existing);
  } else {
    if (doc.selected.length === 0) { alert("Select entities to pattern first."); return; }
    buildLinearDialog(doc, pushHistory, null);
  }
}

export function openCircularPatternDialog(doc: CADDocument, pushHistory: () => void): void {
  const existing = findPatternInSelection(doc, "circular");
  if (existing) {
    buildCircularDialog(doc, pushHistory, existing);
  } else {
    if (doc.selected.length === 0) { alert("Select entities to pattern first."); return; }
    buildCircularDialog(doc, pushHistory, null);
  }
}

// ---------------------------------------------------------------------------
// Linear pattern dialog

function buildLinearDialog(doc: CADDocument, pushHistory: () => void, existing: PatternDef | null): void {
  const editing = existing !== null;
  const p = existing?.params as LinearPatternParams | undefined;

  const backdrop = makeBackdrop();
  const dialog   = makeDialog(backdrop, editing ? "Edit Linear Pattern" : "Linear Pattern");
  const body     = dialog.querySelector(".tp-dialog-body") as HTMLElement;

  const cxInp = addTextField(body, "Count X",   p?.countXExpr   ?? String(p?.countX   ?? 3),  "(count or variable)");
  const sxInp = addTextField(body, "Spacing X", p?.spacingXExpr ?? String(p?.spacingX ?? 20), "(mm or variable)");
  const cyInp = addTextField(body, "Count Y",   p?.countYExpr   ?? String(p?.countY   ?? 1),  "(count or variable)");
  const syInp = addTextField(body, "Spacing Y", p?.spacingYExpr ?? String(p?.spacingY ?? 20), "(mm or variable)");

  const infoEl = addInfo(body, "");
  const updateInfo = () => {
    const cx = resolveCount(cxInp.value, doc, 1);
    const cy = resolveCount(cyInp.value, doc, 1);
    infoEl.textContent =
      cx === null || cy === null
        ? "Invalid count — enter a whole number or a variable."
        : `${cx * cy} total instances (${cx} × ${cy} grid)`;
  };
  cxInp.addEventListener("input", updateInfo);
  cyInp.addEventListener("input", updateInfo);
  updateInfo();

  addFooter(dialog, backdrop, editing ? "Re-apply" : "Create", () => {
    const countX  = resolveCount(cxInp.value, doc, 1);
    const countY  = resolveCount(cyInp.value, doc, 1);
    const spacingX = resolveSpacing(sxInp.value, doc);
    const spacingY = resolveSpacing(syInp.value, doc);
    if (countX === null || countY === null) {
      alert("Invalid count — enter a whole number or a variable name."); return;
    }
    if (spacingX === null || spacingY === null) {
      alert("Invalid spacing — enter a number or a variable name."); return;
    }
    if (countX === 1 && countY === 1) return;

    const params: LinearPatternParams = {
      countX, countY, spacingX, spacingY,
      countXExpr: isPlainNumber(cxInp.value) ? undefined : cxInp.value.trim(),
      countYExpr: isPlainNumber(cyInp.value) ? undefined : cyInp.value.trim(),
      spacingXExpr: isPlainNumber(sxInp.value) ? undefined : sxInp.value.trim(),
      spacingYExpr: isPlainNumber(syInp.value) ? undefined : syInp.value.trim(),
    };

    pushHistory();

    if (editing) {
      regenerateLinearPattern(doc, existing!, params);
    } else {
      createLinearPattern(doc, doc.selected.map((e) => e.id), params);
    }
  });

  document.body.appendChild(backdrop);
}

// ---------------------------------------------------------------------------
// Circular pattern dialog

function buildCircularDialog(doc: CADDocument, pushHistory: () => void, existing: PatternDef | null): void {
  const editing = existing !== null;
  const p = existing?.params as CircularPatternParams | undefined;

  // Default centre: centroid of selected (or source) bounds.
  let defCx = 0, defCy = 0;
  const refEnts = existing
    ? existing.sourceIds.map((id) => doc.entities.find((e) => e.id === id)).filter(Boolean) as Entity[]
    : doc.selected;
  if (refEnts.length > 0) {
    for (const e of refEnts) {
      const b = e.bounds();
      defCx += (b.min.x + b.max.x) / 2;
      defCy += (b.min.y + b.max.y) / 2;
    }
    defCx /= refEnts.length;
    defCy /= refEnts.length;
  }

  const backdrop = makeBackdrop();
  const dialog   = makeDialog(backdrop, editing ? "Edit Circular Pattern" : "Circular Pattern");
  const body     = dialog.querySelector(".tp-dialog-body") as HTMLElement;

  const cntInp   = addTextField  (body, "Count",           p?.countExpr ?? String(p?.count ?? 6), "(count or variable)");
  const cxInp2   = addTextField  (body, "Centre X (mm)",   String((p?.cx   ?? defCx).toFixed(3)), "");
  const cyInp2   = addTextField  (body, "Centre Y (mm)",   String((p?.cy   ?? defCy).toFixed(3)), "");
  const angInp   = addTextField  (body, "Total angle (°)", String(Math.round(((p?.totalAngle ?? Math.PI * 2) / Math.PI) * 180)), "");

  const infoEl = addInfo(body, "");
  const updateInfo = () => {
    const n = resolveCount(cntInp.value, doc, 2);
    const deg = parseFloat(angInp.value);
    const full = Math.abs(deg - 360) < 0.1;
    infoEl.textContent =
      n === null
        ? "Invalid count — enter a whole number or a variable."
        : `${n} instances${full ? ", full circle" : `, ${deg}° arc`}`;
  };
  cntInp.addEventListener("input", updateInfo);
  angInp.addEventListener("input", updateInfo);
  updateInfo();

  addFooter(dialog, backdrop, editing ? "Re-apply" : "Create", () => {
    const count      = resolveCount(cntInp.value, doc, 2);
    const cx         = parseFloat(cxInp2.value);
    const cy         = parseFloat(cyInp2.value);
    const totalAngle = (parseFloat(angInp.value) || 360) * (Math.PI / 180);
    if (count === null) {
      alert("Invalid count — enter a whole number or a variable name."); return;
    }
    if (!isFinite(cx) || !isFinite(cy) || !isFinite(totalAngle)) {
      alert("Invalid values."); return;
    }

    const params: CircularPatternParams = {
      count, cx, cy, totalAngle,
      countExpr: isPlainNumber(cntInp.value) ? undefined : cntInp.value.trim(),
    };

    pushHistory();

    if (editing) {
      regenerateCircularPattern(doc, existing!, params);
    } else {
      createCircularPattern(doc, doc.selected.map((e) => e.id), params);
    }
  });

  document.body.appendChild(backdrop);
}

// ---------------------------------------------------------------------------
// Helpers

function findPatternInSelection(doc: CADDocument, kind: "linear" | "circular"): PatternDef | null {
  const selIds = new Set(doc.selected.map((e) => e.id));
  for (const pat of doc.patterns) {
    if (pat.kind !== kind) continue;
    const allIds = new Set([...pat.sourceIds, ...pat.instanceIds.flat()]);
    if ([...selIds].some((id) => allIds.has(id))) return pat;
  }
  return null;
}

/** Resolve a spacing field value: try variable expression first, then plain float. */
function resolveSpacing(raw: string, doc: CADDocument): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const vm = varMap(doc.variables);
  const exprVal = evalExpr(trimmed, vm);
  if (exprVal !== null && isFinite(exprVal)) return exprVal;
  const num = parseFloat(trimmed);
  return isFinite(num) ? num : null;
}

/** Resolve a count field value to a whole number ≥ min (expression or literal). */
function resolveCount(raw: string, doc: CADDocument, min: number): number | null {
  const n = resolveSpacing(raw, doc);
  return n === null ? null : Math.max(min, Math.round(n));
}

function isPlainNumber(s: string): boolean {
  return isFinite(parseFloat(s.trim())) && isNaN(Number(s.trim())) === false;
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
  dialog.style.width = "320px";
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

function addTextField(body: HTMLElement, label: string, value: string, placeholder: string): HTMLInputElement {
  const g = document.createElement("div");
  g.className = "tp-field";
  const l = document.createElement("label");
  l.textContent = label;
  const inp = document.createElement("input");
  inp.type = "text";
  inp.className = "dim";
  inp.value = value;
  inp.placeholder = placeholder;
  inp.style.width = "120px";
  g.appendChild(l);
  g.appendChild(inp);
  body.appendChild(g);
  return inp;
}

function addInfo(body: HTMLElement, text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "tp-field-info";
  el.style.cssText = "font-size:11px;color:var(--text-muted,#888);padding:2px 0 6px";
  el.textContent = text;
  body.appendChild(el);
  return el;
}

function addFooter(dialog: HTMLElement, backdrop: HTMLElement, applyLabel: string, onApply: () => void): void {
  const ftr = document.createElement("div");
  ftr.className = "tp-dialog-footer";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => backdrop.remove());

  const applyBtn = document.createElement("button");
  applyBtn.className = "btn tp-apply-btn";
  applyBtn.textContent = applyLabel;
  applyBtn.addEventListener("click", () => {
    onApply();
    backdrop.remove();
  });

  ftr.appendChild(cancelBtn);
  ftr.appendChild(applyBtn);
  dialog.appendChild(ftr);
}
