import {
  getCustomGcode, setCustomGcode,
  getMachineHasCoolant, setMachineHasCoolant,
} from "../core/prefs";
import type { CADDocument } from "../model/document";

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

  const container = document.createElement("div");
  container.className = "about-dialog post-settings-dialog";

  const closeBtn = document.createElement("button");
  closeBtn.className = "about-close";
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", () => backdrop.remove());

  const title = document.createElement("h2");
  title.className = "post-settings-title";
  title.textContent = "Machine Settings";

  // Controller (post-processor + tool changer).
  const ppSelect = document.createElement("select");
  ppSelect.className = "unit post-settings-select";
  for (const [v, l] of [["linuxcnc", "LinuxCNC"], ["grbl", "GRBL / FluidNC"]] as const) {
    const o = document.createElement("option");
    o.value = v; o.textContent = l;
    ppSelect.appendChild(o);
  }
  ppSelect.value = doc.postProcessor;
  const ppField = labeledRow("Post-processor", ppSelect);

  const tcCheck = document.createElement("input");
  tcCheck.type = "checkbox";
  tcCheck.checked = doc.hasToolChanger;
  const tcRow = checkRow("Automatic tool changer (emit T/M6)", tcCheck);

  const coolantCheck = document.createElement("input");
  coolantCheck.type = "checkbox";
  coolantCheck.checked = getMachineHasCoolant();
  const coolantRow = checkRow("Machine has coolant (show coolant options & emit M7/M8/M9)", coolantCheck);

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
  cancel.addEventListener("click", () => backdrop.remove());
  const save = document.createElement("button");
  save.className = "btn btn-primary";
  save.textContent = "Save";
  save.addEventListener("click", () => {
    // Controller fields live on the document — push history only if they change.
    if (doc.postProcessor !== ppSelect.value || doc.hasToolChanger !== tcCheck.checked) {
      opts.pushHistory();
      doc.postProcessor = ppSelect.value;
      doc.hasToolChanger = tcCheck.checked;
    }
    // Machine-wide preferences.
    setMachineHasCoolant(coolantCheck.checked);
    setCustomGcode({ start: startArea.value, end: endArea.value });
    backdrop.remove();
    doc.emitChange();
    opts.onSaved?.();
  });
  buttons.appendChild(cancel);
  buttons.appendChild(save);

  container.append(
    closeBtn, title, ppField, tcRow, coolantRow,
    note, startArea.field, endArea.field, buttons,
  );
  backdrop.appendChild(container);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
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

function checkRow(label: string, check: HTMLInputElement): HTMLElement {
  const row = document.createElement("label");
  row.className = "post-settings-check";
  const text = document.createElement("span");
  text.textContent = label;
  row.append(check, text);
  return row;
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
