import { type Unit, parseLength, formatLength } from "../core/units";
import {
  isLaser,
  isRotary,
  MACHINE_KINDS,
  type MachineKind,
  type OriginDef,
  type OriginX,
  type OriginY,
  type OriginZ,
  type RotarySettings,
} from "../model/document";
import { StorageKeys } from "../core/storageKeys";
import { registerModal } from "./modal";

export interface NewProjectConfig {
  name: string;
  width: number; // mm — along the cylinder axis for a rotary job
  height: number; // mm — the wrapped/circumference span for a rotary job (π·diameter)
  stockThickness: number; // mm — radial wall / max cut depth for a rotary job
  displayUnit: Unit;
  origin: OriginDef;
  machineKind: MachineKind;
  /**
   * Per-job cylinder params, present only for a `mill-rotary` machine. `width`
   * is the cylinder length and `height` is its circumference (π·diameter), so the
   * unrolled surface matches the drawing canvas. See {@link RotarySettings}.
   */
  rotary?: RotarySettings;
}

function renderOriginSvg(xSel: string, ySel: string, zSel: string): string {
  const W = 100, D = 80, H = 30; // Logical dimensions for the diagram
  const cx = 60, cy = 70; // Center offset

  // Isometric projection
  const ISO = Math.PI / 6;
  const cosI = Math.cos(ISO);
  const sinI = Math.sin(ISO);
  const toIso = (x: number, y: number, z: number) => {
    return [cx + (x + y) * cosI, cy + (x - y) * sinI - z];
  };

  const ox = xSel === "left" ? 0 : xSel === "center" ? W / 2 : W;
  const oy = ySel === "front" ? 0 : ySel === "center" ? D / 2 : D;
  const oz = zSel === "top" ? H : 0;

  const b = [toIso(0, 0, 0), toIso(W, 0, 0), toIso(W, D, 0), toIso(0, D, 0)];
  const t = [toIso(0, 0, H), toIso(W, 0, H), toIso(W, D, H), toIso(0, D, H)];

  const poly = (pts: number[][]) => pts.map((p) => `${p[0]},${p[1]}`).join(" ");

  let html = "";

  // Bottom face
  html += `<polygon points="${poly([b[0], b[1], b[2], b[3]])}" fill="#2a2a4a" stroke="#444470" stroke-width="1" stroke-dasharray="3,2" />`;
  // Top face
  html += `<polygon points="${poly(t)}" fill="#333366" stroke="#5555aa" stroke-width="1"/>`;
  // Front face (y=0)
  html += `<polygon points="${poly([b[0], b[1], t[1], t[0]])}" fill="#2d2d55" stroke="#5555aa" stroke-width="1"/>`;
  // Right face (x=W)
  html += `<polygon points="${poly([b[1], b[2], t[2], t[1]])}" fill="#25254d" stroke="#5555aa" stroke-width="1"/>`;

  // Origin marker
  const oIso = toIso(ox, oy, oz);
  const r = 5;
  html += `<circle cx="${oIso[0]}" cy="${oIso[1]}" r="${r}" fill="none" stroke="#ff4466" stroke-width="2"/>`;
  html += `<circle cx="${oIso[0]}" cy="${oIso[1]}" r="2" fill="#ff4466"/>`;

  // Crosshair
  html += `<line x1="${oIso[0] - r - 3}" y1="${oIso[1]}" x2="${oIso[0] + r + 3}" y2="${oIso[1]}" stroke="#ff4466" stroke-width="1"/>`;
  html += `<line x1="${oIso[0]}" y1="${oIso[1] - r - 3}" x2="${oIso[0]}" y2="${oIso[1] + r + 3}" stroke="#ff4466" stroke-width="1"/>`;

  // Axis arrows from origin
  const axisLen = 20;
  const axEnd = toIso(ox + axisLen, oy, oz);
  const ayEnd = toIso(ox, oy + axisLen, oz);
  const azEnd = toIso(ox, oy, oz + axisLen * 0.8);
  html += `<line x1="${oIso[0]}" y1="${oIso[1]}" x2="${axEnd[0]}" y2="${axEnd[1]}" stroke="#ff6644" stroke-width="1.5" marker-end="url(#arrowX)"/>`;
  html += `<line x1="${oIso[0]}" y1="${oIso[1]}" x2="${ayEnd[0]}" y2="${ayEnd[1]}" stroke="#44cc66" stroke-width="1.5" marker-end="url(#arrowY)"/>`;
  html += `<line x1="${oIso[0]}" y1="${oIso[1]}" x2="${azEnd[0]}" y2="${azEnd[1]}" stroke="#4488ff" stroke-width="1.5" marker-end="url(#arrowZ)"/>`;

  return `<svg width="120" height="100" viewBox="50 -20 180 150">
    <defs>
      <marker id="arrowX" markerWidth="4" markerHeight="4" refX="3" refY="2" orient="auto"><polygon points="0,0 4,2 0,4" fill="#ff6644"/></marker>
      <marker id="arrowY" markerWidth="4" markerHeight="4" refX="3" refY="2" orient="auto"><polygon points="0,0 4,2 0,4" fill="#44cc66"/></marker>
      <marker id="arrowZ" markerWidth="4" markerHeight="4" refX="3" refY="2" orient="auto"><polygon points="0,0 4,2 0,4" fill="#4488ff"/></marker>
    </defs>
    ${html}
  </svg>`;
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
    if (MACHINE_KINDS.some(([k]) => k === lk)) lastMachineKind = lk as MachineKind;
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
  const originSec = sec("Origin (WCS - Work Coordinate System)");
  const originTitleEl = originSec.firstElementChild as HTMLElement;
  if (originTitleEl) {
    originTitleEl.title = "The Work Coordinate System (WCS) origin is the physical 0,0,0 starting point on your CNC machine.";
    originTitleEl.style.cursor = "help";
  }
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

  const originFlex = document.createElement("div");
  originFlex.style.display = "flex";
  originFlex.style.gap = "16px";
  originFlex.style.alignItems = "flex-start";

  const originLeft = document.createElement("div");
  originLeft.style.flex = "1 1 auto";

  originLeft.appendChild(row("X", oxSel));
  originLeft.appendChild(row("Y", oySel));
  const ozRow = row("Z", ozSel);
  originLeft.appendChild(ozRow);

  // Rotary-only: where Z0 sits on the cylinder. "surface" = stock top (needs
  // gSender's "Visualize non-center zeros" toggle); "center" = rotary axis (native,
  // no toggle — every Z lifted by the radius). See RotarySettings.zero / cam/klein.ts.
  const zeroSel = sel([
    ["surface", "Stock surface (top)"],
    ["center", "Rotary centre (axis)"],
  ]);
  zeroSel.value = initial.rotary?.zero ?? defaults.rotary?.zero ?? "surface";
  const zeroRow = row("Rotary Z0", zeroSel);
  originLeft.appendChild(zeroRow);

  const originRight = document.createElement("div");
  originRight.style.flex = "0 0 120px";
  originRight.style.display = "flex";
  originRight.style.justifyContent = "center";
  originRight.style.alignItems = "center";
  originRight.style.background = "#1a1a2e"; // Matching the user's diagram background
  originRight.style.border = "1px solid #333366";
  originRight.style.borderRadius = "6px";
  originRight.style.padding = "4px 0";
  originRight.style.marginTop = "4px";

  const updateOriginDiagram = () => {
    originRight.innerHTML = renderOriginSvg(oxSel.value, oySel.value, ozSel.value);
  };
  oxSel.addEventListener("change", updateOriginDiagram);
  oySel.addEventListener("change", updateOriginDiagram);
  ozSel.addEventListener("change", updateOriginDiagram);
  updateOriginDiagram();

  originFlex.append(originLeft, originRight);
  originSec.appendChild(originFlex);
  body.appendChild(originSec);

  // -- machine --
  const macSec = sec("Machine");
  const mkSel = sel(MACHINE_KINDS);
  mkSel.value = initial.machineKind ?? lastMachineKind ?? defaults.machineKind ?? "mill";
  macSec.appendChild(row("Machine type", mkSel));
  // Machine TYPE stays: head x stock is a property of the design (laser ops do
  // not map onto mill ops, and a rotary canvas is an unrolled cylinder). The
  // controller, tool changer and coolant are the router's and live in the
  // machine profile — asking for them here is what made two dialogs disagree.
  // See SETTINGS_MODEL.md.
  const macNote = document.createElement("p");
  macNote.className = "npd-note";
  macNote.textContent =
    "Controller, tool changer and coolant are set once in Machine Settings — they belong to your machine, not to this drawing.";
  macSec.appendChild(macNote);
  body.appendChild(macSec);

  const applyMachineKind = () => {
    const laser = isLaser(mkSel.value as MachineKind);
    const rotary = isRotary(mkSel.value as MachineKind);
    // A laser has no Z; a rotary cylinder is always surface-zeroed on its top
    // (no bed) — in both cases the Z-origin choice is fixed, so lock the select.
    const noZChoice = laser || rotary;
    ozSel.disabled = noZChoice;
    if (rotary) ozSel.value = "top";
    ozRow.style.opacity = noZChoice ? "0.45" : "";
    // The surface-vs-axis Z0 choice only applies to a rotary cylinder being
    // MILLED — a beam emits no Z at all, so it has no zero to reference.
    zeroRow.style.display = rotary && !laser ? "" : "none";
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
    const rotary = isRotary(mkSel.value as MachineKind);
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
      rotarySettings = {
        axisWord: "A",
        diameter: dia,
        wrapAxis: "y",
        zero: zeroSel.value as "surface" | "center",
      };
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
        // A rotary cylinder is always surface-zeroed on its top (no bed).
        z: rotary ? "top" : (ozSel.value as OriginZ),
      },
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

    // Machine profile (localStorage, global) — the controller and tool changer
    // are capabilities of the router, not properties of the new drawing, so they
    // are persisted here rather than onto the document. See SETTINGS_MODEL.md.


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

  // keyboard (Enter submits from any field except when the Cancel button holds focus)
  backdrop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && document.activeElement !== cancelBtn) createBtn.click();
  });

  // Strict modal: only explicit Create / Cancel dismisses the dialog (no backdrop click, no Escape)
  unregister = registerModal(backdrop, close, { escapable: false });
  document.body.appendChild(backdrop);
  // Synchronously, NOT on a timer. This used to run 40ms after the dialog was
  // appended, which opened a window where the user is looking at a focusable
  // dialog that is about to yank focus somewhere else: type a stock width in
  // those first 40ms and the keystrokes land in the name box instead — and,
  // because the name is select()ed, replace it.
  //
  // It reads as a rare glitch by hand and as a flaky test suite in CI, where
  // "type immediately" is the normal speed. It cost about one run in three of
  // the New Project specs, presenting as a wrong stock size with no clue that
  // focus was the cause. The element is in the document by this line, so there
  // is nothing to wait for.
  nameInput.focus();
  nameInput.select();
}

// ---- DOM helpers ------------------------------------------------------------

let fieldSeq = 0;

function row(label: string, control: HTMLElement): HTMLElement {
  const g = document.createElement("div");
  g.className = "tp-field";
  const l = document.createElement("label");
  l.textContent = label;
  // Bind the label to its control. This is an accessibility fix first — the
  // label was decorative text next to an input, so clicking it focused nothing
  // and a screen reader had no name to announce.
  //
  // It also removes a real trap. With no association, the only way to find a
  // field was to guess from text proximity ("the input inside the .tp-field
  // that contains the text 'Width'"), and that resolved to the WRONG input
  // often enough — roughly one run in three — to look like a flaky test suite.
  // It put a typed stock width into the Project name box. `getByLabel` is
  // unambiguous; prefer it over any proximity search.
  if (
    control instanceof HTMLInputElement ||
    control instanceof HTMLSelectElement ||
    control instanceof HTMLTextAreaElement
  ) {
    if (!control.id) control.id = `npd-field-${++fieldSeq}`;
    l.htmlFor = control.id;
  }
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

function sel(opts: readonly (readonly [string, string])[]): HTMLSelectElement {
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
