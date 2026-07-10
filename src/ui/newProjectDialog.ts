import { type Unit, parseLength, formatLength } from "../core/units";
import type {
  MachineKind,
  OriginDef,
  OriginX,
  OriginY,
  OriginZ,
  RotarySettings,
} from "../model/document";
import { getMachineHasCoolant, setMachineHasCoolant } from "../core/prefs";
import { laserPostOptions, DEFAULT_LASER_POST } from "../cam/laserposts";
import { StorageKeys } from "../core/storageKeys";
import { registerModal } from "./modal";

const MILL_POST_OPTIONS: [string, string][] = [
  ["grbl", "GRBL / FluidNC"],
  ["linuxcnc", "LinuxCNC"],
];

export interface NewProjectConfig {
  name: string;
  width: number; // mm — along the cylinder axis for a rotary job
  height: number; // mm — the wrapped/circumference span for a rotary job (π·diameter)
  stockThickness: number; // mm — radial wall / max cut depth for a rotary job
  displayUnit: Unit;
  origin: OriginDef;
  hasToolChanger: boolean;
  postProcessor: string;
  machineKind: MachineKind;
  /**
   * Per-job cylinder params, present only for a `mill-rotary` machine. `width`
   * is the cylinder length and `height` is its circumference (π·diameter), so the
   * unrolled surface matches the drawing canvas. See {@link RotarySettings}.
   */
  rotary?: RotarySettings;
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
  opts: { hasWork?: boolean } = {},
): void {
  document.getElementById("npd-backdrop")?.remove();

  // Load defaults from localStorage if available
  let defaults: Partial<NewProjectConfig> = {};
  try {
    const stored = localStorage.getItem(StorageKeys.defaultProjectSettings);
    if (stored) {
      defaults = JSON.parse(stored);
      // Explicitly delete name to ensure we never load or reuse a saved project name as a default
      delete defaults.name;
    }
  } catch (_e) {
    // Ignore parse errors
  }

  // The machine type picked for the most recent project is remembered on its own
  // (independent of "Save as default"), so a laser shop doesn't re-pick Laser
  // every time. Falls back to the saved default, then "mill".
  let lastMachineKind: MachineKind | undefined;
  try {
    const lk = localStorage.getItem(StorageKeys.lastMachineKind);
    if (lk === "mill" || lk === "laser" || lk === "mill-rotary") lastMachineKind = lk;
  } catch (_e) {
    // Ignore
  }

  // Use initial values if provided, otherwise fallback to defaults or hardcoded defaults
  // ---- working state (dimensions always kept in mm internally) ----
  let unit: Unit = initial.displayUnit ?? defaults.displayUnit ?? "mm";
  const vals = {
    name: initial.name ?? "Untitled",
    width: initial.width ?? defaults.width ?? 200,
    height: initial.height ?? defaults.height ?? 150,
    thick: initial.stockThickness ?? defaults.stockThickness ?? 10,
    // Rotary cylinder diameter (mm) — from a saved rotary default, else a sensible rod.
    diameter: initial.rotary?.diameter ?? defaults.rotary?.diameter ?? 50,
  };

  // ---- scaffold ----
  const backdrop = document.createElement("div");
  backdrop.id = "npd-backdrop";
  backdrop.className = "tp-backdrop";
  let unregister: () => void = () => {};
  const close = () => {
    unregister();
    backdrop.remove();
  };
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

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

  // Warn (in-dialog, not a pre-emptive native confirm) that creating a project
  // discards the current drawing — so Cancel genuinely loses nothing and the
  // discard happens only on Create Project.
  if (opts.hasWork) {
    const warn = document.createElement("div");
    warn.className = "npd-discard-warning";
    warn.textContent =
      "⚠ Creating a new project discards the current drawing. Save first if you want to keep it.";
    body.appendChild(warn);
  }

  // -- project name --
  const nameInput = inp("text", vals.name);
  nameInput.className = "dim tp-name-input";
  body.appendChild(row("Project name", nameInput));

  // -- units --
  const unitSel = sel([
    ["mm", "mm"],
    ["in", "in"],
  ]);
  unitSel.value = unit;
  body.appendChild(row("Units", unitSel));

  // -- stock -- (a rotary job's stock is a cylinder: Length × Diameter, with the
  // wall/depth as the radial cut allowance; see applyMachineKind for the relabel)
  const stockSec = sec("Stock");
  const wInp = dimInp(formatLength(vals.width, unit));
  const hInp = dimInp(formatLength(vals.height, unit));
  const dInp = dimInp(formatLength(vals.diameter, unit));
  const tInp = dimInp(formatLength(vals.thick, unit));
  const wRow = row("Width", wInp);
  const hRow = row("Height", hInp);
  const dRow = row("Diameter", dInp);
  const tRow = row("Thickness", tInp);
  stockSec.append(wRow, hRow, dRow, tRow);
  body.appendChild(stockSec);
  const setRowLabel = (rowEl: HTMLElement, text: string): void => {
    const l = rowEl.querySelector("label");
    if (l) l.textContent = text;
  };

  // -- origin --
  const originSec = sec("Origin (WCS)");
  const oxSel = sel([
    ["left", "Left"],
    ["center", "Center"],
    ["right", "Right"],
  ]);
  const oySel = sel([
    ["front", "Front"],
    ["center", "Center"],
    ["back", "Back"],
  ]);
  const ozSel = sel([
    ["top", "Top of stock"],
    ["bed", "Bed"],
  ]);
  oxSel.value = initial.origin?.x ?? defaults.origin?.x ?? "left";
  oySel.value = initial.origin?.y ?? defaults.origin?.y ?? "front";
  ozSel.value = initial.origin?.z ?? defaults.origin?.z ?? "top";
  originSec.appendChild(row("X", oxSel));
  originSec.appendChild(row("Y", oySel));
  const ozRow = row("Z", ozSel);
  originSec.appendChild(ozRow);
  body.appendChild(originSec);

  // -- machine --
  const macSec = sec("Machine");
  const mkSel = sel([
    ["mill", "CNC Mill / Router"],
    ["mill-rotary", "CNC Mill — Rotary / 4th axis"],
    ["laser", "Laser"],
  ]);
  mkSel.value = initial.machineKind ?? lastMachineKind ?? defaults.machineKind ?? "mill";
  macSec.appendChild(row("Machine type", mkSel));
  const ppSel = sel(MILL_POST_OPTIONS);
  const ppRow = row("Post-processor", ppSel);
  macSec.appendChild(ppRow);
  const tcChk = document.createElement("input");
  tcChk.type = "checkbox";
  tcChk.className = "settings-checkbox";
  tcChk.checked = initial.hasToolChanger ?? defaults.hasToolChanger ?? false;
  const tcRow = row("Auto tool changer", tcChk);
  macSec.appendChild(tcRow);
  // Coolant is a machine capability (global preference), not a per-project
  // setting, so it's read/written directly to prefs rather than NewProjectConfig.
  const coolantChk = document.createElement("input");
  coolantChk.type = "checkbox";
  coolantChk.className = "settings-checkbox";
  coolantChk.checked = getMachineHasCoolant();
  const coolantRow = row("Machine has coolant", coolantChk);
  macSec.appendChild(coolantRow);
  body.appendChild(macSec);

  // The post-processor dropdown swaps option sets by machine type: mill posts
  // (LinuxCNC/GRBL) vs laser controllers (cam/laserposts). Remember each side's
  // pick so toggling back and forth doesn't lose it. A laser has no spindle/Z, so
  // the tool-changer and coolant toggles are grayed out.
  const initialPP = initial.postProcessor ?? defaults.postProcessor;
  let millPost =
    initialPP && MILL_POST_OPTIONS.some(([v]) => v === initialPP) ? initialPP : "linuxcnc";
  let laserPost =
    initialPP && laserPostOptions().some(([v]) => v === initialPP)
      ? initialPP
      : DEFAULT_LASER_POST.id;
  const fillOptions = (opts: [string, string][], value: string) => {
    ppSel.innerHTML = "";
    for (const [v, l] of opts) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = l;
      ppSel.appendChild(o);
    }
    ppSel.value = value;
  };
  ppSel.addEventListener("change", () => {
    if (mkSel.value === "laser") laserPost = ppSel.value;
    else millPost = ppSel.value;
  });
  const applyMachineKind = () => {
    const laser = mkSel.value === "laser";
    const rotary = mkSel.value === "mill-rotary";
    fillOptions(laser ? laserPostOptions() : MILL_POST_OPTIONS, laser ? laserPost : millPost);
    tcChk.disabled = laser;
    coolantChk.disabled = laser;
    // A laser has no Z, so the Z-origin choice is meaningless — gray it out.
    ozSel.disabled = laser;
    for (const r of [tcRow, coolantRow, ozRow]) r.style.opacity = laser ? "0.45" : "";
    // A rotary job's stock is a cylinder: Length (along the axis) × Diameter, with
    // the wall/depth as the radial cut allowance. The circumference (π·diameter)
    // becomes the wrapped canvas dimension at creation.
    setRowLabel(wRow, rotary ? "Length (mm)" : "Width");
    setRowLabel(tRow, rotary ? "Wall / cut depth" : "Thickness");
    hRow.style.display = rotary ? "none" : "";
    dRow.style.display = rotary ? "" : "none";
  };
  mkSel.addEventListener("change", applyMachineKind);
  applyMachineKind();

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
  cancelBtn.addEventListener("click", () => close());

  const createBtn = document.createElement("button");
  createBtn.className = "btn tp-apply-btn";
  createBtn.textContent = "Create Project";
  createBtn.addEventListener("click", () => {
    const rotary = mkSel.value === "mill-rotary";
    const t = parseLength(tInp.value, unit);
    if (!t || t <= 0) {
      highlight(tInp);
      return;
    }

    // A rotary job defines a cylinder (length × diameter); its circumference
    // becomes the wrapped canvas dimension so the unrolled surface = the drawing.
    let width: number, height: number, rotarySettings: RotarySettings | undefined;
    if (rotary) {
      const len = parseLength(wInp.value, unit);
      const dia = parseLength(dInp.value, unit);
      if (!len || len <= 0) {
        highlight(wInp);
        return;
      }
      if (!dia || dia <= 0) {
        highlight(dInp);
        return;
      }
      width = len;
      height = Math.PI * dia;
      rotarySettings = { axisWord: "A", diameter: dia, wrapAxis: "y" };
    } else {
      const w = parseLength(wInp.value, unit);
      const h = parseLength(hInp.value, unit);
      if (!w || w <= 0) {
        highlight(wInp);
        return;
      }
      if (!h || h <= 0) {
        highlight(hInp);
        return;
      }
      width = w;
      height = h;
    }

    const cfg: NewProjectConfig = {
      name: nameInput.value.trim() || "Untitled",
      width,
      height,
      stockThickness: t,
      displayUnit: unit,
      origin: {
        x: oxSel.value as OriginX,
        y: oySel.value as OriginY,
        z: ozSel.value as OriginZ,
      },
      hasToolChanger: tcChk.checked,
      postProcessor: ppSel.value,
      machineKind: mkSel.value as MachineKind,
      ...(rotarySettings ? { rotary: rotarySettings } : {}),
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
          postProcessor: cfg.postProcessor,
          machineKind: cfg.machineKind,
          ...(cfg.rotary ? { rotary: cfg.rotary } : {}),
        };
        // Explicitly ensure the project name is never saved with the default settings
        delete defaultsToSave.name;
        localStorage.setItem(StorageKeys.defaultProjectSettings, JSON.stringify(defaultsToSave));
      } catch (e) {
        console.error("Failed to save default project settings:", e);
      }
    }

    // Remember the machine type for next time, regardless of "Save as default".
    try {
      localStorage.setItem(StorageKeys.lastMachineKind, cfg.machineKind);
    } catch (_e) {
      /* ignore */
    }

    // Persist the machine coolant capability (global, applies to all projects).
    setMachineHasCoolant(coolantChk.checked);

    close();
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
    const d = parseLength(dInp.value, unit) ?? vals.diameter;
    const t = parseLength(tInp.value, unit) ?? vals.thick;
    unit = unitSel.value as Unit;
    wInp.value = formatLength(w, unit);
    hInp.value = formatLength(h, unit);
    dInp.value = formatLength(d, unit);
    tInp.value = formatLength(t, unit);
  });

  // keyboard (Escape is also handled globally by the modal manager; Enter here
  // submits from any field except when the Cancel button holds focus)
  backdrop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && document.activeElement !== cancelBtn) createBtn.click();
  });

  unregister = registerModal(backdrop, close);
  document.body.appendChild(backdrop);
  setTimeout(() => {
    nameInput.focus();
    nameInput.select();
  }, 40);
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
  i.type = type;
  i.value = value;
  return i;
}

function dimInp(value: string): HTMLInputElement {
  const i = document.createElement("input");
  i.type = "text";
  i.className = "dim";
  i.spellcheck = false;
  i.value = value;
  i.style.transition = "border-color 0.15s";
  i.addEventListener("input", () => {
    i.style.borderColor = "";
  });
  return i;
}

function sel(opts: [string, string][]): HTMLSelectElement {
  const s = document.createElement("select");
  s.className = "unit";
  for (const [v, l] of opts) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = l;
    s.appendChild(o);
  }
  return s;
}

function highlight(el: HTMLInputElement): void {
  el.style.borderColor = "var(--danger)";
  el.focus();
}
