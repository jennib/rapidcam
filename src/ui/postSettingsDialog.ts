import { getCustomGcode, setCustomGcode } from "../core/prefs";

/**
 * Modal for editing the machine-wide custom program start/end G-code. These are
 * stored in localStorage (see core/prefs) and injected into every generated
 * program, so the dialog is explicit that it applies to all projects.
 */
export function showPostSettingsDialog(onSaved?: () => void): void {
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
  title.textContent = "Custom Program G-code";

  const note = document.createElement("p");
  note.className = "post-settings-note";
  note.textContent =
    "Injected into every generated program on this computer (start: after the " +
    "G21/G90/G17 setup; end: after the spindle stop, before M30). Applies to all projects.";

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
    setCustomGcode({ start: startArea.value, end: endArea.value });
    backdrop.remove();
    onSaved?.();
  });
  buttons.appendChild(cancel);
  buttons.appendChild(save);

  container.append(closeBtn, title, note, startArea.field, endArea.field, buttons);
  backdrop.appendChild(container);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  document.body.appendChild(backdrop);
  startArea.focus();
}

function textareaField(label: string, value: string, placeholder: string): {
  field: HTMLElement; value: string; focus: () => void;
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
  return { field, get value() { return ta.value; }, focus: () => ta.focus() };
}
