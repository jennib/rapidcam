import {
  getCustomGcode,
  setCustomGcode,
  getMachineHasCoolant,
  setMachineHasCoolant,
} from "../core/prefs";
import {
  type CADDocument,
  isLaser,
  isRotary,
  MACHINE_KINDS,
  type MachineKind,
  type RotarySettings,
} from "../model/document";
import { laserPostOptions, DEFAULT_LASER_POST } from "../cam/laserposts";
import { defaultRotarySettings, circumference, ARC_TOL_DEFAULT } from "../cam/klein";
import { registerModal } from "./modal";

const MILL_POST_OPTIONS: [string, string][] = [
  ["linuxcnc", "LinuxCNC"],
  ["grbl", "GRBL / FluidNC"],
];

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
  const close = () => {
    unregister();
    backdrop.remove();
  };

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
  for (const [v, l] of MACHINE_KINDS) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = l;
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
  const coolantRow = checkRow(
    "Machine has coolant (show coolant options & emit M7/M8/M9)",
    coolantCheck,
  );

  // Rotary — the per-job cylinder for a rotary machine (mill or laser). Shown
  // only when such a machine type is selected; the params live on doc.rotary, the
  // mode is the machine type itself (see cam/klein.ts).
  const rbase: RotarySettings = doc.rotary ?? defaultRotarySettings(doc);
  const wrapSelect = smallSelect(
    [
      ["y", "Y wraps · X = length"],
      ["x", "X wraps · Y = length"],
    ],
    rbase.wrapAxis,
  );
  const rWordSelect = smallSelect(
    [
      ["A", "A (rotates about X)"],
      ["B", "B (rotates about Y)"],
    ],
    rbase.axisWord,
  );
  const diaInput = smallNumber(rbase.diameter, "0.5");
  const zeroSelect = smallSelect(
    [
      ["surface", "Stock surface (top)"],
      ["center", "Rotary centre (axis)"],
    ],
    rbase.zero ?? "surface",
  );
  const tolInput = smallNumber(rbase.arcTolerance ?? ARC_TOL_DEFAULT, "0.01");
  const rotaryInfo = document.createElement("div");
  rotaryInfo.className = "post-settings-note";
  const rotaryNote = document.createElement("p");
  rotaryNote.className = "post-settings-note";
  // Rows a BEAM rotary has no use for: it emits no Z (so no zero reference) and
  // no rotary word, and it never flattens arcs because it never wraps them.
  const zeroRow = labeledRow("Zero reference (Z0)", zeroSelect);
  const rWordRow = labeledRow("Rotary axis word", rWordSelect);
  const tolRow = labeledRow("Arc tolerance (mm)", tolInput);
  const rotarySection = document.createElement("div");
  rotarySection.append(
    labeledRow("Wrap axis", wrapSelect),
    rWordRow,
    labeledRow("Cylinder diameter (mm)", diaInput),
    zeroRow,
    tolRow,
    rotaryInfo,
    rotaryNote,
  );

  const readRotary = (): RotarySettings => ({
    axisWord: rWordSelect.value as "A" | "B",
    diameter: Math.max(0.1, Number(diaInput.value) || rbase.diameter),
    wrapAxis: wrapSelect.value as "x" | "y",
    zero: zeroSelect.value as "surface" | "center",
    arcTolerance: Math.max(0.001, Number(tolInput.value) || ARC_TOL_DEFAULT),
  });
  const updateRotaryInfo = (): void => {
    const s = readRotary();
    const laser = isLaser(kindSelect.value as MachineKind);
    const length = s.wrapAxis === "y" ? doc.canvas.width : doc.canvas.height;
    const wrapU = s.wrapAxis.toUpperCase();
    const circ = circumference(s);
    // A beam rotary substitutes the axis instead of wrapping it, so the number
    // that matters to the operator is the machine setup: how much travel on the
    // wrapped axis makes one revolution.
    const tail = laser
      ? `<b>${wrapU} is emitted in surface mm, not degrees</b> — set the rotary so one revolution = ` +
        `${circ.toFixed(1)}mm of ${wrapU} travel (${wrapU} steps/mm = steps-per-rev ÷ ${circ.toFixed(1)}).`
      : s.zero === "center"
        ? `Z0 = rotary <b>centre</b>: surface at Z${(s.diameter / 2).toFixed(1)} (radius); gSender visualizes natively.`
        : `Z0 = stock <b>surface</b>: touch off on top. gSender needs its "Visualize non-center zeros" toggle.`;
    rotaryInfo.innerHTML =
      `⌀${s.diameter} → circumference <b>${circ.toFixed(1)}mm</b> = 360°` +
      `${laser ? "" : ` on ${s.axisWord}`} (the wrapped stock dimension). ` +
      `Cylinder length ${length.toFixed(1)}mm on ${s.wrapAxis === "y" ? "X" : "Y"}.<br>` +
      tail;
  };
  const updateRotaryNote = (): void => {
    const laser = isLaser(kindSelect.value as MachineKind);
    rotaryNote.innerHTML =
      "The canvas is the unrolled cylinder surface, so the diameter <b>is</b> the stock: the wrapped stock " +
      "dimension stays locked to the circumference (π·⌀). " +
      (laser
        ? "The wrapped axis is <b>substituted</b>, not wrapped: it posts as an ordinary linear word in surface " +
          "millimetres, so the file runs on controllers with no 4th axis (GRBL). Focus the beam on the top of " +
          "the cylinder."
        : "The rotary word (A/B, degrees) replaces the wrapped axis and arcs are flattened into the wrap. " +
          "Set <b>Z0</b> per the reference chosen above.");
  };
  // Pair the rotary word with the wrap axis the usual way.
  wrapSelect.addEventListener("change", () => {
    rWordSelect.value = wrapSelect.value === "y" ? "A" : "B";
    updateRotaryInfo();
  });
  for (const el of [wrapSelect, rWordSelect, diaInput, zeroSelect, tolInput])
    el.addEventListener("input", updateRotaryInfo);

  // Remember each machine type's post pick so toggling doesn't lose it.
  let millPost = MILL_POST_OPTIONS.some(([v]) => v === doc.postProcessor)
    ? doc.postProcessor
    : "linuxcnc";
  let laserPost = laserPostOptions().some(([v]) => v === doc.postProcessor)
    ? doc.postProcessor
    : DEFAULT_LASER_POST.id;
  const fillPosts = (opts: [string, string][], value: string) => {
    ppSelect.innerHTML = "";
    for (const [v, l] of opts) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = l;
      ppSelect.appendChild(o);
    }
    ppSelect.value = value;
  };
  ppSelect.addEventListener("change", () => {
    if (isLaser(kindSelect.value as MachineKind)) laserPost = ppSelect.value;
    else millPost = ppSelect.value;
  });

  // Spindle/Z concepts don't apply to a laser; hide the tool-changer + coolant
  // rows in laser mode and swap the post-processor list to the laser controllers.
  const applyKindVisibility = () => {
    const kind = kindSelect.value as MachineKind;
    const laser = isLaser(kind);
    fillPosts(laser ? laserPostOptions() : MILL_POST_OPTIONS, laser ? laserPost : millPost);
    tcRow.style.display = laser ? "none" : "";
    coolantRow.style.display = laser ? "none" : "";
    // The head decides posts / tool-changer / coolant; the stock decides whether
    // the cylinder params show. A BEAM rotary hides the three mill-only rotary
    // rows: it emits no Z (no zero reference) and substitutes the wrapped axis
    // rather than wrapping it, so there is no rotary word and no arc flattening.
    const rotary = isRotary(kind);
    rotarySection.style.display = rotary ? "" : "none";
    for (const row of [zeroRow, rWordRow, tolRow]) row.style.display = laser ? "none" : "";
    if (rotary) {
      updateRotaryInfo();
      updateRotaryNote();
    }
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
    const newRotary = isRotary(kind) ? readRotary() : null;
    // The canvas IS the unrolled cylinder surface, so the wrapped dimension is
    // locked to the circumference (π·⌀). Changing the diameter here resizes it.
    const wrapKey: "width" | "height" | null = newRotary
      ? newRotary.wrapAxis === "x"
        ? "width"
        : "height"
      : null;
    const lockedWrap = newRotary ? Math.PI * newRotary.diameter : null;
    const canvasChanged = wrapKey !== null && Math.abs(doc.canvas[wrapKey] - lockedWrap!) > 1e-6;
    const rotaryChanged = JSON.stringify(doc.rotary ?? null) !== JSON.stringify(newRotary);
    if (
      doc.postProcessor !== ppSelect.value ||
      doc.hasToolChanger !== tcCheck.checked ||
      doc.machineKind !== kind ||
      rotaryChanged ||
      canvasChanged
    ) {
      opts.pushHistory();
      doc.postProcessor = ppSelect.value;
      doc.hasToolChanger = tcCheck.checked;
      doc.machineKind = kind;
      doc.rotary = newRotary;
      // A rotary cylinder has no bed — it's always surface-zeroed (see cam/klein.ts).
      // Normalise an errant bed Z-origin so the saved file stays honest.
      if (isRotary(kind)) doc.origin.z = "top";
      if (wrapKey !== null) doc.canvas[wrapKey] = lockedWrap!;
    }
    // Machine-wide preferences.
    setMachineHasCoolant(coolantCheck.checked);
    setCustomGcode({ start: startArea.value, end: endArea.value });
    close();
    doc.emitChange();
    opts.onSaved?.();
  });
  buttons.appendChild(cancel);
  buttons.appendChild(save);

  container.append(
    closeBtn,
    title,
    kindField,
    ppField,
    tcRow,
    coolantRow,
    rotarySection,
    note,
    startArea.field,
    endArea.field,
    buttons,
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
    o.value = v;
    o.textContent = l;
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


function textareaField(
  label: string,
  value: string,
  placeholder: string,
): {
  field: HTMLElement;
  value: string;
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
  return {
    field,
    get value() {
      return ta.value;
    },
  };
}
