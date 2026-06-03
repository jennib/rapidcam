import { type Unit, parseLength, formatLength } from "../core/units";
import { type OriginDef, type OriginX, type OriginY, type OriginZ } from "../model/document";

export interface NewProjectConfig {
  name: string;
  width: number;         // mm
  height: number;        // mm
  stockThickness: number; // mm
  displayUnit: Unit;
  origin: OriginDef;
  hasToolChanger: boolean;
}

/**
 * Open the guided new-project setup dialog.
 * `initial` pre-fills the form (pass current doc values when editing).
 * `onConfirm` is called when the user clicks "Create Project".
 * Pressing Cancel or Escape dismisses without calling anything.
 */
export function openNewProjectDialog(
  initial: Partial<NewProjectConfig>,
  onConfirm: (cfg: NewProjectConfig) => void,
): void {
  document.getElementById("npd-backdrop")?.remove();

  // Load defaults from localStorage if available
  let defaults: Partial<NewProjectConfig> = {};
  try {
    const stored = localStorage.getItem("rapidcam:defaultProjectSettings");
    if (stored) defaults = JSON.parse(stored);
  } catch (e) {
    // Ignore parse errors
  }

  // Use initial values if provided, otherwise fallback to defaults or hardcoded defaults
  // ---- working state (dimensions always kept in mm internally) ----
  let unit: Unit = initial.displayUnit ?? defaults.displayUnit ?? "mm";
  const vals = {
    name: initial.name ?? "Untitled",
    width:  initial.width  ?? defaults.width ?? 200,
    height: initial.height ?? defaults.height ?? 150,
    thick:  initial.stockThickness ?? defaults.stockThickness ?? 10,
  };

  // ---- scaffold ----
  const backdrop = document.createElement("div");
  backdrop.id = "npd-backdrop";
  backdrop.className = "tp-backdrop";
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });

  const dialog = document.createElement("div");
  dialog.className = "tp-dialog npd-dialog";
  dialog.addEventListener("click", (e) => e.stopPropagation());
  backdrop.appendChild(dialog);

  // header
  const hdr = document.createElement("div");
  hdr.className = "tp-dialog-header";
  const titleEl = document.createElement("h3");
  titleEl.textContent = "New Project";
  hdr.appendChild(titleEl);
  dialog.appendChild(hdr);

  // body
  const body = document.createElement("div");
  body.className = "tp-dialog-body";
  dialog.appendChild(body);

  // -- project name --
  const nameInput = inp("text", vals.name);
  nameInput.className = "dim tp-name-input";
  body.appendChild(row("Project name", nameInput));

  // -- units --
  const unitSel = sel([["mm", "mm"], ["in", "in"]]);
  unitSel.value = unit;
  body.appendChild(row("Units", unitSel));

  // -- stock --
  const stockSec = sec("Stock");
  const wInp = dimInp(formatLength(vals.width,  unit));
  const hInp = dimInp(formatLength(vals.height, unit));
  const tInp = dimInp(formatLength(vals.thick,  unit));
  stockSec.appendChild(row("Width",     wInp));
  stockSec.appendChild(row("Height",    hInp));
  stockSec.appendChild(row("Thickness", tInp));
  body.appendChild(stockSec);

  // -- origin --
  const originSec = sec("Origin (WCS)");
  const oxSel = sel([["left", "Left"], ["center", "Center"], ["right", "Right"]]);
  const oySel = sel([["front", "Front"], ["center", "Center"], ["back", "Back"]]);
  const ozSel = sel([["top", "Top of stock"], ["bed", "Bed"]]);
  oxSel.value = initial.origin?.x ?? defaults.origin?.x ?? "left";
  oySel.value = initial.origin?.y ?? defaults.origin?.y ?? "front";
  ozSel.value = initial.origin?.z ?? defaults.origin?.z ?? "top";
  originSec.appendChild(row("X", oxSel));
  originSec.appendChild(row("Y", oySel));
  originSec.appendChild(row("Z", ozSel));
  body.appendChild(originSec);

  // -- machine --
  const macSec = sec("Machine");
  const tcChk = document.createElement("input");
  tcChk.type = "checkbox";
  tcChk.className = "settings-checkbox";
  tcChk.checked = initial.hasToolChanger ?? defaults.hasToolChanger ?? false;
  macSec.appendChild(row("Auto tool changer", tcChk));
  body.appendChild(macSec);

  // footer
  const ftr = document.createElement("div");
  ftr.className = "tp-dialog-footer";

  const saveDefaultWrap = document.createElement("label");
  saveDefaultWrap.style.display = "flex";
  saveDefaultWrap.style.alignItems = "center";
  saveDefaultWrap.style.gap = "6px";
  saveDefaultWrap.style.fontSize = "0.9em";
  saveDefaultWrap.style.marginRight = "auto";
  const saveDefaultChk = document.createElement("input");
  saveDefaultChk.type = "checkbox";
  saveDefaultChk.className = "settings-checkbox";
  saveDefaultWrap.appendChild(saveDefaultChk);
  saveDefaultWrap.appendChild(document.createTextNode("Save as default"));

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => backdrop.remove());

  const createBtn = document.createElement("button");
  createBtn.className = "btn tp-apply-btn";
  createBtn.textContent = "Create Project";
  createBtn.addEventListener("click", () => {
    const w = parseLength(wInp.value, unit);
    const h = parseLength(hInp.value, unit);
    const t = parseLength(tInp.value, unit);
    if (!w || w <= 0) { highlight(wInp); return; }
    if (!h || h <= 0) { highlight(hInp); return; }
    if (!t || t <= 0) { highlight(tInp); return; }

    const cfg: NewProjectConfig = {
      name: nameInput.value.trim() || "Untitled",
      width: w, height: h, stockThickness: t,
      displayUnit: unit,
      origin: {
        x: oxSel.value as OriginX,
        y: oySel.value as OriginY,
        z: ozSel.value as OriginZ,
      },
      hasToolChanger: tcChk.checked,
    };

    if (saveDefaultChk.checked) {
      try {
        const defaultsToSave: Partial<NewProjectConfig> = {
          width: cfg.width,
          height: cfg.height,
          stockThickness: cfg.stockThickness,
          displayUnit: cfg.displayUnit,
          origin: cfg.origin,
          hasToolChanger: cfg.hasToolChanger,
        };
        localStorage.setItem("rapidcam:defaultProjectSettings", JSON.stringify(defaultsToSave));
      } catch (e) {
        console.error("Failed to save default project settings:", e);
      }
    }

    backdrop.remove();
    onConfirm(cfg);
  });

  ftr.appendChild(saveDefaultWrap);
  ftr.appendChild(cancelBtn);
  ftr.appendChild(createBtn);
  dialog.appendChild(ftr);

  // unit change: reformat dimension inputs in new unit
  unitSel.addEventListener("change", () => {
    const w = parseLength(wInp.value, unit) ?? vals.width;
    const h = parseLength(hInp.value, unit) ?? vals.height;
    const t = parseLength(tInp.value, unit) ?? vals.thick;
    unit = unitSel.value as Unit;
    wInp.value = formatLength(w, unit);
    hInp.value = formatLength(h, unit);
    tInp.value = formatLength(t, unit);
  });

  // keyboard
  backdrop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") backdrop.remove();
    if (e.key === "Enter" && document.activeElement !== cancelBtn) createBtn.click();
  });

  document.body.appendChild(backdrop);
  setTimeout(() => { nameInput.focus(); nameInput.select(); }, 40);
}

// ---- DOM helpers ------------------------------------------------------------

function row(label: string, control: HTMLElement): HTMLElement {
  const g = document.createElement("div");
  g.className = "tp-field";
  const l = document.createElement("label");
  l.textContent = label;
  g.appendChild(l);
  g.appendChild(control);
  return g;
}

function sec(title: string): HTMLElement {
  const s = document.createElement("div");
  s.className = "tp-dialog-section";
  const h = document.createElement("div");
  h.className = "tp-dialog-section-title";
  h.textContent = title;
  s.appendChild(h);
  return s;
}

function inp(type: string, value: string): HTMLInputElement {
  const i = document.createElement("input");
  i.type = type; i.value = value;
  return i;
}

function dimInp(value: string): HTMLInputElement {
  const i = document.createElement("input");
  i.type = "text"; i.className = "dim"; i.spellcheck = false; i.value = value;
  i.style.transition = "border-color 0.15s";
  i.addEventListener("input", () => { i.style.borderColor = ""; });
  return i;
}

function sel(opts: [string, string][]): HTMLSelectElement {
  const s = document.createElement("select");
  s.className = "unit";
  for (const [v, l] of opts) {
    const o = document.createElement("option");
    o.value = v; o.textContent = l; s.appendChild(o);
  }
  return s;
}

function highlight(el: HTMLInputElement): void {
  el.style.borderColor = "var(--danger)";
  el.focus();
}
