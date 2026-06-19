import {
  getCustomGcode, setCustomGcode,
  getMachineHasCoolant, setMachineHasCoolant,
} from "../core/prefs";

/**
 * Modal for machine-wide settings stored in localStorage (see core/prefs): the
 * coolant capability and the custom program start/end G-code. These describe
 * the operator's machine/shop, not the design, so they apply to all projects.
 */
export function showMachineSettingsDialog(onSaved?: () => void): void {
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

  const note = document.createElement("p");
  note.className = "post-settings-note";
  note.textContent =
    "These describe your machine and apply to all projects on this computer.";

  // Coolant capability.
  const coolantRow = document.createElement("label");
  coolantRow.className = "post-settings-check";
  const coolantCheck = document.createElement("input");
  coolantCheck.type = "checkbox";
  coolantCheck.checked = getMachineHasCoolant();
  const coolantText = document.createElement("span");
  coolantText.textContent = "Machine has coolant (show coolant options & emit M7/M8/M9)";
  coolantRow.append(coolantCheck, coolantText);

  const note2 = document.createElement("p");
  note2.className = "post-settings-note";
  note2.textContent =
    "Custom G-code injected into every program — start: after the G21/G90/G17 " +
    "setup; end: after the spindle stop, before M30.";

  const startArea = textareaField("Program start", current.start,
    "e.g. G54 ; work offset");
  const endArea = textareaField("Program end", current.end,
    "e.g. G0 X0 Y0 ; park");

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
    setMachineHasCoolant(coolantCheck.checked);
    setCustomGcode({ start: startArea.value, end: endArea.value });
    backdrop.remove();
    onSaved?.();
  });
  buttons.appendChild(cancel);
  buttons.appendChild(save);

  container.append(
    closeBtn, title, note, coolantRow, note2,
    startArea.field, endArea.field, buttons,
  );
  backdrop.appendChild(container);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  document.body.appendChild(backdrop);
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
