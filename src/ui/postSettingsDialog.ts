import {
  getCustomGcode, setCustomGcode,
  getMachineHasCoolant, setMachineHasCoolant,
  getGsenderUrl, setGsenderUrl, DEFAULT_GSENDER_URL,
} from "../core/prefs";
import type { CADDocument, MachineKind, RotarySettings } from "../model/document";
import { laserPostOptions, DEFAULT_LASER_POST } from "../cam/laserposts";
import { defaultRotarySettings, circumference, ARC_TOL_DEFAULT } from "../cam/klein";
import { testGsenderConnection } from "../io/gsender";
import { registerModal } from "./modal";

const MILL_POST_OPTIONS: [string, string][] = [["linuxcnc", "LinuxCNC"], ["grbl", "GRBL / FluidNC"]];

interface MachineSettingsOptions {
  doc: CADDocument;
  pushHistory: () => void;
  onSaved?: () => void;
}

/**
 * The single home for machine configuration. Two scopes live here, but both read
 * as "my machine" to the user: the controller fields (post-processor, tool
 * changer) are stored on the document; the coolant capability and custom program
 * G-code are machine-wide (localStorage) preferences.
 */
export function showMachineSettingsDialog(opts: MachineSettingsOptions): void {
  const { doc } = opts;
  const current = getCustomGcode();

  const backdrop = document.createElement("div");
  backdrop.className = "welcome-backdrop";
  backdrop.style.zIndex = "9999";
  let unregister: () => void = () => {};
  const close = () => { unregister(); backdrop.remove(); };

  const container = document.createElement("div");
  container.className = "about-dialog post-settings-dialog";

  const closeBtn = document.createElement("button");
  closeBtn.className = "about-close";
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", () => close());

  const title = document.createElement("h2");
  title.className = "post-settings-title";
  title.textContent = "Machine Settings";

  // Machine type — mill (spindle + Z) vs laser (fixed-Z beam). Drives which
  // G-code generator runs and which toolpath fields the CAM dialog shows.
  const kindSelect = document.createElement("select");
  kindSelect.className = "unit post-settings-select";
  for (const [v, l] of [
    ["mill", "CNC Mill / Router"],
    ["mill-rotary", "CNC Mill — Rotary / 4th axis"],
    ["laser", "Laser"],
  ] as const) {
    const o = document.createElement("option");
    o.value = v; o.textContent = l;
    kindSelect.appendChild(o);
  }
  kindSelect.value = doc.machineKind;
  const kindField = labeledRow("Machine type", kindSelect);

  // Controller (post-processor + tool changer). The post-processor dropdown
  // swaps between mill posts (LinuxCNC/GRBL) and laser controllers
  // (cam/laserposts) by machine type.
  const ppSelect = document.createElement("select");
  ppSelect.className = "unit post-settings-select";
  const ppField = labeledRow("Post-processor", ppSelect);

  const tcCheck = document.createElement("input");
  tcCheck.type = "checkbox";
  tcCheck.checked = doc.hasToolChanger;
  const tcRow = checkRow("Automatic tool changer (emit T/M6)", tcCheck);

  const coolantCheck = document.createElement("input");
  coolantCheck.type = "checkbox";
  coolantCheck.checked = getMachineHasCoolant();
  const coolantRow = checkRow("Machine has coolant (show coolant options & emit M7/M8/M9)", coolantCheck);

  // Rotary (4th axis) — the per-job cylinder for a "mill-rotary" machine. Shown
  // only when that machine type is selected; the params live on doc.rotary, the
  // mode is the machine type itself (see cam/klein.ts).
  const rbase: RotarySettings = doc.rotary ?? defaultRotarySettings(doc);
  const wrapSelect = smallSelect([["y", "Y wraps · X = length"], ["x", "X wraps · Y = length"]], rbase.wrapAxis);
  const rWordSelect = smallSelect([["A", "A (rotates about X)"], ["B", "B (rotates about Y)"]], rbase.axisWord);
  const diaInput = smallNumber(rbase.diameter, "0.5");
  const tolInput = smallNumber(rbase.arcTolerance ?? ARC_TOL_DEFAULT, "0.01");
  const rotaryInfo = document.createElement("div");
  rotaryInfo.className = "post-settings-note";
  const rotaryNote = document.createElement("p");
  rotaryNote.className = "post-settings-note";
  rotaryNote.innerHTML =
    "The canvas is the unrolled cylinder surface, so the diameter <b>is</b> the stock: the wrapped stock " +
    "dimension stays locked to the circumference (π·⌀). Touch <b>Z</b> off on the <b>top</b> of the cylinder; " +
    "the rotary word (A/B, degrees) replaces the wrapped axis and arcs are flattened into the wrap.";
  const rotarySection = document.createElement("div");
  rotarySection.append(
    labeledRow("Wrap axis", wrapSelect),
    labeledRow("Rotary axis word", rWordSelect),
    labeledRow("Cylinder diameter (mm)", diaInput),
    labeledRow("Arc tolerance (mm)", tolInput),
    rotaryInfo, rotaryNote,
  );

  const readRotary = (): RotarySettings => ({
    axisWord: rWordSelect.value as "A" | "B",
    diameter: Math.max(0.1, Number(diaInput.value) || rbase.diameter),
    wrapAxis: wrapSelect.value as "x" | "y",
    arcTolerance: Math.max(0.001, Number(tolInput.value) || ARC_TOL_DEFAULT),
  });
  const updateRotaryInfo = (): void => {
    const s = readRotary();
    const length = s.wrapAxis === "y" ? doc.canvas.width : doc.canvas.height;
    rotaryInfo.innerHTML =
      `⌀${s.diameter} → circumference <b>${circumference(s).toFixed(1)}mm</b> = 360° on ${s.axisWord} ` +
      `(the wrapped stock dimension). Cylinder length ${length.toFixed(1)}mm on ${s.wrapAxis === "y" ? "X" : "Y"}.`;
  };
  // Pair the rotary word with the wrap axis the usual way.
  wrapSelect.addEventListener("change", () => {
    rWordSelect.value = wrapSelect.value === "y" ? "A" : "B";
    updateRotaryInfo();
  });
  for (const el of [wrapSelect, rWordSelect, diaInput, tolInput]) el.addEventListener("input", updateRotaryInfo);

  // Remember each machine type's post pick so toggling doesn't lose it.
  let millPost  = MILL_POST_OPTIONS.some(([v]) => v === doc.postProcessor) ? doc.postProcessor : "linuxcnc";
  let laserPost = laserPostOptions().some(([v]) => v === doc.postProcessor) ? doc.postProcessor : DEFAULT_LASER_POST.id;
  const fillPosts = (opts: [string, string][], value: string) => {
    ppSelect.innerHTML = "";
    for (const [v, l] of opts) {
      const o = document.createElement("option");
      o.value = v; o.textContent = l; ppSelect.appendChild(o);
    }
    ppSelect.value = value;
  };
  ppSelect.addEventListener("change", () => {
    if (kindSelect.value === "laser") laserPost = ppSelect.value; else millPost = ppSelect.value;
  });

  // Spindle/Z concepts don't apply to a laser; hide the tool-changer + coolant
  // rows in laser mode and swap the post-processor list to the laser controllers.
  const applyKindVisibility = () => {
    const laser = kindSelect.value === "laser";
    fillPosts(laser ? laserPostOptions() : MILL_POST_OPTIONS, laser ? laserPost : millPost);
    tcRow.style.display = laser ? "none" : "";
    coolantRow.style.display = laser ? "none" : "";
    // Rotary is a mill (spindle + Z), so the mill posts / tool-changer / coolant
    // rows all apply; only the cylinder params are rotary-specific.
    const rotary = kindSelect.value === "mill-rotary";
    rotarySection.style.display = rotary ? "" : "none";
    if (rotary) updateRotaryInfo();
  };
  kindSelect.addEventListener("change", applyKindVisibility);
  applyKindVisibility();

  const note = document.createElement("p");
  note.className = "post-settings-note";
  note.textContent =
    "Custom G-code injected into every program — start: after the G21/G90/G17 " +
    "setup; end: after the spindle stop, before M30.";

  const startArea = textareaField("Program start", current.start, "e.g. G54 ; work offset");
  const endArea = textareaField("Program end", current.end, "e.g. G0 X0 Y0 ; park");

  // "Send to gSender" address. Machine-wide (localStorage), like coolant/custom
  // G-code. Includes a live "Test" so the operator can confirm reachability
  // before relying on it mid-job.
  const gsField = gsenderField(getGsenderUrl());

  const buttons = document.createElement("div");
  buttons.className = "post-settings-buttons";
  const cancel = document.createElement("button");
  cancel.className = "btn";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => close());
  const save = document.createElement("button");
  save.className = "btn btn-primary";
  save.textContent = "Save";
  save.addEventListener("click", () => {
    // Controller fields live on the document — push history only if they change.
    const kind = kindSelect.value as MachineKind;
    // The rotary cylinder params are the document's stock for a rotary machine;
    // clear them when the machine isn't rotary so a flat/laser file carries no
    // stale wrap settings.
    const newRotary = kind === "mill-rotary" ? readRotary() : null;
    // The canvas IS the unrolled cylinder surface, so the wrapped dimension is
    // locked to the circumference (π·⌀). Changing the diameter here resizes it.
    const wrapKey: "width" | "height" | null = newRotary ? (newRotary.wrapAxis === "x" ? "width" : "height") : null;
    const lockedWrap = newRotary ? Math.PI * newRotary.diameter : null;
    const canvasChanged = wrapKey !== null && Math.abs(doc.canvas[wrapKey] - lockedWrap!) > 1e-6;
    const rotaryChanged = JSON.stringify(doc.rotary ?? null) !== JSON.stringify(newRotary);
    if (doc.postProcessor !== ppSelect.value || doc.hasToolChanger !== tcCheck.checked || doc.machineKind !== kind || rotaryChanged || canvasChanged) {
      opts.pushHistory();
      doc.postProcessor = ppSelect.value;
      doc.hasToolChanger = tcCheck.checked;
      doc.machineKind = kind;
      doc.rotary = newRotary;
      if (wrapKey !== null) doc.canvas[wrapKey] = lockedWrap!;
    }
    // Machine-wide preferences.
    setMachineHasCoolant(coolantCheck.checked);
    setCustomGcode({ start: startArea.value, end: endArea.value });
    setGsenderUrl(gsField.value);
    close();
    doc.emitChange();
    opts.onSaved?.();
  });
  buttons.appendChild(cancel);
  buttons.appendChild(save);

  container.append(
    closeBtn, title, kindField, ppField, tcRow, coolantRow, rotarySection,
    note, startArea.field, endArea.field, gsField.field, buttons,
  );
  backdrop.appendChild(container);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  unregister = registerModal(backdrop, close);
  document.body.appendChild(backdrop);
}

function labeledRow(label: string, control: HTMLElement): HTMLElement {
  const field = document.createElement("div");
  field.className = "post-settings-field post-settings-row";
  const lab = document.createElement("label");
  lab.textContent = label;
  field.append(lab, control);
  return field;
}

/** A compact dropdown styled to match the dialog's other selects. */
function smallSelect<T extends string>(options: [T, string][], value: T): HTMLSelectElement {
  const s = document.createElement("select");
  s.className = "unit post-settings-select";
  for (const [v, l] of options) {
    const o = document.createElement("option");
    o.value = v; o.textContent = l;
    if (v === value) o.selected = true;
    s.appendChild(o);
  }
  return s;
}

/** A compact number input styled to match the dialog's selects. */
function smallNumber(value: number, step: string): HTMLInputElement {
  const i = document.createElement("input");
  i.type = "number";
  i.min = "0";
  i.step = step;
  i.value = String(value);
  i.className = "unit post-settings-select";
  i.style.width = "90px";
  return i;
}

function checkRow(label: string, check: HTMLInputElement): HTMLElement {
  const row = document.createElement("label");
  row.className = "post-settings-check";
  const text = document.createElement("span");
  text.textContent = label;
  row.append(check, text);
  return row;
}

/**
 * gSender address input + a live "Test" button. Test probes the (unsaved)
 * address and reports whether gSender answered and what's connected, so the
 * operator isn't relying on an address they've never confirmed.
 */
function gsenderField(value: string): { field: HTMLElement; value: string } {
  const field = document.createElement("div");
  field.className = "post-settings-field";

  const lab = document.createElement("label");
  lab.textContent = "Send to gSender — address";

  const row = document.createElement("div");
  row.className = "post-settings-row";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "unit post-settings-select";
  input.style.flex = "1";
  input.value = value;
  input.placeholder = DEFAULT_GSENDER_URL;

  const testBtn = document.createElement("button");
  testBtn.className = "btn";
  testBtn.type = "button";
  testBtn.textContent = "Test";

  const status = document.createElement("div");
  status.className = "post-settings-note";
  status.textContent =
    "In gSender, enable Remote/Wireless Control and use the address it shows: " +
    "localhost:8000 on the same PC, or the machine's IP (e.g. 192.168.1.42:8000) for a shop PC/Pi. " +
    "Note: from an https page the browser reaches http://localhost but blocks a plain-http LAN address " +
    "unless you allow “Insecure content” for this site.";

  testBtn.addEventListener("click", async () => {
    status.textContent = "Testing…";
    const res = await testGsenderConnection(input.value || DEFAULT_GSENDER_URL);
    if (!res.ok) {
      status.textContent = `✗ ${res.error}`;
    } else if (res.ports.length === 0) {
      status.textContent = "✓ gSender is reachable, but no CNC is connected yet.";
    } else {
      status.textContent = `✓ gSender is reachable — connected: ${res.ports.join(", ")}.`;
    }
  });

  row.append(input, testBtn);
  field.append(lab, row, status);
  return { field, get value() { return input.value; } };
}

function textareaField(label: string, value: string, placeholder: string): {
  field: HTMLElement; value: string;
} {
  const field = document.createElement("div");
  field.className = "post-settings-field";
  const lab = document.createElement("label");
  lab.textContent = label;
  const ta = document.createElement("textarea");
  ta.className = "post-settings-textarea";
  ta.spellcheck = false;
  ta.rows = 4;
  ta.value = value;
  ta.placeholder = placeholder;
  field.append(lab, ta);
  return { field, get value() { return ta.value; } };
}
