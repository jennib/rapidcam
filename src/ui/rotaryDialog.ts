/**
 * Rotary (Klein) — the cylindrical-wrap setup dialog.
 *
 * Configures `doc.rotary`: which work axis wraps around the cylinder, the rotary
 * axis word (A/B), the stock diameter, and the arc-flattening tolerance. It does
 * NOT export — with a rotary setup in place, "Generate G-code" rolls the flat
 * program around the cylinder (see cam/klein.ts and camBar's generate()). A live
 * readout shows the circumference and how far the design wraps, so an overlap
 * (design taller than one turn) is caught before cutting.
 */

import type { CADDocument, RotarySettings } from "../model/document";
import { defaultRotarySettings, circumference, wrapAngleDeg, validateRotary, ARC_TOL_DEFAULT } from "../cam/klein";
import { registerModal } from "./modal";

export interface RotaryDialogParams {
  doc: CADDocument;
  /** Capture undo state before committing the change. */
  pushHistory?: () => void;
  /** Called after the setup is committed, to refresh dependent UI. */
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

function numberInput(value: number, step = "0.5"): HTMLInputElement {
  const i = document.createElement("input");
  i.type = "number";
  i.min = "0";
  i.step = step;
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

export function openRotaryDialog(params: RotaryDialogParams): void {
  const { doc, onDone } = params;

  // Working copy — the live doc.rotary is written only on Save.
  const base: RotarySettings = doc.rotary ? { ...doc.rotary } : defaultRotarySettings(doc);
  let enabled = doc.rotary != null;

  const backdrop = document.createElement("div");
  backdrop.className = "tp-backdrop";
  const dialog = document.createElement("div");
  dialog.className = "tp-dialog";
  dialog.style.width = "440px";
  dialog.addEventListener("click", (e) => e.stopPropagation());
  backdrop.appendChild(dialog);

  const hdr = document.createElement("div");
  hdr.className = "tp-dialog-header";
  const h = document.createElement("h3");
  h.textContent = "Rotary machining (cylindrical wrap)";
  hdr.appendChild(h);
  dialog.appendChild(hdr);

  const body = document.createElement("div");
  body.className = "tp-dialog-body";
  dialog.appendChild(body);

  const enableChk = document.createElement("input");
  enableChk.type = "checkbox";
  enableChk.className = "settings-checkbox";
  enableChk.checked = enabled;

  const wrapSel = select<"y" | "x">(
    [["y", "Y wraps · X = length"], ["x", "X wraps · Y = length"]],
    base.wrapAxis,
  );
  const axisSel = select<"A" | "B">(
    [["A", "A (rotates about X)"], ["B", "B (rotates about Y)"]],
    base.axisWord,
  );
  const diaIn = numberInput(base.diameter);
  const tolIn = numberInput(base.arcTolerance ?? ARC_TOL_DEFAULT, "0.01");

  const fitBtn = document.createElement("button");
  fitBtn.className = "btn";
  fitBtn.textContent = "Fit to design";
  fitBtn.title = "Pick a diameter so the design wraps exactly once around the cylinder";
  fitBtn.style.cssText = "padding:2px 8px;font-size:12px;";

  const diaWrap = document.createElement("span");
  diaWrap.style.cssText = "display:flex;align-items:center;gap:8px;";
  diaWrap.append(diaIn, fitBtn);

  const controls = document.createElement("div");
  controls.append(
    row("Wrap axis", wrapSel),
    row("Rotary axis word", axisSel),
    row("Cylinder diameter (mm)", diaWrap),
    row("Arc tolerance (mm)", tolIn),
  );

  body.append(row("Enable rotary wrap", enableChk), controls);

  const info = document.createElement("div");
  info.style.cssText = "margin-top:10px;font-size:12px;color:var(--muted,#9aa4b2);line-height:1.6;";
  body.appendChild(info);

  const note = document.createElement("div");
  note.style.cssText = "margin-top:8px;font-size:12px;color:var(--muted,#9aa4b2);line-height:1.5;";
  note.innerHTML =
    "The design is rolled around a cylinder on a 4th axis. Touch <b>Z</b> off on the <b>top</b> of the cylinder; " +
    "the rotary word (A/B, in degrees) replaces the wrapped axis, and arcs are flattened into the wrap. Mill-only.";
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

  const working = (): RotarySettings => ({
    axisWord: axisSel.value as "A" | "B",
    diameter: Math.max(0.1, Number(diaIn.value) || base.diameter),
    wrapAxis: wrapSel.value as "x" | "y",
    arcTolerance: Math.max(0.001, Number(tolIn.value) || ARC_TOL_DEFAULT),
  });

  const update = (): void => {
    enabled = enableChk.checked;
    controls.style.display = enabled ? "" : "none";
    info.style.display = enabled ? "" : "none";
    if (!enabled) { warn.textContent = ""; return; }

    const s = working();
    const span = s.wrapAxis === "y" ? doc.canvas.height : doc.canvas.width;
    const c = circumference(s);
    info.innerHTML =
      `Circumference <b>${c.toFixed(1)}mm</b> = 360° on ${s.axisWord}. ` +
      `Design ${s.wrapAxis.toUpperCase()} span ${span.toFixed(1)}mm → <b>${wrapAngleDeg(span, s).toFixed(1)}°</b> of rotation.`;

    // Reuse the export validator so the dialog and the generated program agree.
    const probe = { ...doc, rotary: s } as CADDocument;
    const warns = validateRotary(probe).filter((w) => !/flip|laser/i.test(w)); // mode clashes are shown elsewhere
    warn.textContent = warns.length ? `⚠ ${warns[0]}` : "";
  };

  // Convenience: pair the rotary word with the wrap axis the usual way, and fit
  // the diameter so the design wraps once.
  wrapSel.addEventListener("change", () => {
    axisSel.value = wrapSel.value === "y" ? "A" : "B";
    update();
  });
  fitBtn.addEventListener("click", (e) => {
    e.preventDefault();
    const span = wrapSel.value === "y" ? doc.canvas.height : doc.canvas.width;
    diaIn.value = String(Math.max(1, Math.ceil((span / Math.PI) * 10) / 10));
    update();
  });
  for (const el of [wrapSel, axisSel, diaIn, tolIn]) el.addEventListener("input", update);
  enableChk.addEventListener("change", update);

  let settled = false;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    dispose();
    backdrop.remove();
  };
  const dispose = registerModal(backdrop, finish);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) finish(); });
  cancelBtn.addEventListener("click", finish);

  saveBtn.addEventListener("click", () => {
    params.pushHistory?.();
    doc.rotary = enableChk.checked ? working() : null;
    doc.emitChange();
    onDone();
    finish();
  });

  document.body.appendChild(backdrop);
  update();
  setTimeout(() => enableChk.focus(), 40);
}
