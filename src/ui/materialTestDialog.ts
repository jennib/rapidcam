import { type MaterialTestParams, MATERIAL_TEST_DEFAULTS } from "../cam/materialTest";

type TestConfig = Omit<MaterialTestParams, "origin">;

/**
 * Collect parameters for the laser material-test grid. `onConfirm` receives the
 * swept ranges (the caller places the grid by supplying an `origin`).
 */
export function openMaterialTestDialog(onConfirm: (cfg: TestConfig) => void): void {
  document.getElementById("mtd-backdrop")?.remove();
  const d = { ...MATERIAL_TEST_DEFAULTS };

  const backdrop = document.createElement("div");
  backdrop.id = "mtd-backdrop";
  backdrop.className = "tp-backdrop";
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });

  const dialog = document.createElement("div");
  dialog.className = "tp-dialog npd-dialog";
  dialog.addEventListener("click", (e) => e.stopPropagation());
  backdrop.appendChild(dialog);

  const hdr = document.createElement("div");
  hdr.className = "tp-dialog-header";
  const titleEl = document.createElement("h3");
  titleEl.textContent = "Laser Material Test";
  hdr.appendChild(titleEl);
  dialog.appendChild(hdr);

  const body = document.createElement("div");
  body.className = "tp-dialog-body";
  dialog.appendChild(body);

  const note = document.createElement("p");
  note.className = "post-settings-note";
  note.textContent =
    "Engraves a grid of squares sweeping power (rows) against speed (columns). " +
    "Run it on your material, then read the best cell's row/column.";
  body.appendChild(note);

  const num = (label: string, get: () => number, set: (v: number) => void): HTMLInputElement => {
    const inp = document.createElement("input");
    inp.type = "number"; inp.className = "dim"; inp.step = "any"; inp.value = String(get());
    inp.addEventListener("change", () => { const v = parseFloat(inp.value); if (isFinite(v)) set(v); });
    body.appendChild(row(label, inp));
    return inp;
  };

  body.appendChild(sec("Power sweep (%) — rows"));
  num("Min power", () => d.powerMin, (v) => { d.powerMin = clamp(v, 0, 100); });
  num("Max power", () => d.powerMax, (v) => { d.powerMax = clamp(v, 0, 100); });
  num("Steps", () => d.powerSteps, (v) => { d.powerSteps = Math.max(1, Math.round(v)); });

  body.appendChild(sec("Speed sweep (mm/min) — columns"));
  num("Min speed", () => d.speedMin, (v) => { d.speedMin = Math.max(1, v); });
  num("Max speed", () => d.speedMax, (v) => { d.speedMax = Math.max(1, v); });
  num("Steps", () => d.speedSteps, (v) => { d.speedSteps = Math.max(1, Math.round(v)); });

  body.appendChild(sec("Grid"));
  num("Cell size (mm)", () => d.cellSize, (v) => { d.cellSize = Math.max(1, v); });
  num("Gap (mm)", () => d.gap, (v) => { d.gap = Math.max(0, v); });
  num("Fill spacing (mm)", () => d.fillSpacing, (v) => { d.fillSpacing = Math.max(0.01, v); });

  const labelsChk = document.createElement("input");
  labelsChk.type = "checkbox"; labelsChk.className = "settings-checkbox"; labelsChk.checked = d.labels;
  labelsChk.addEventListener("change", () => { d.labels = labelsChk.checked; });
  body.appendChild(row("Engrave axis labels", labelsChk));

  const ftr = document.createElement("div");
  ftr.className = "tp-dialog-footer";
  const cancel = document.createElement("button");
  cancel.className = "btn"; cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => backdrop.remove());
  const create = document.createElement("button");
  create.className = "btn tp-apply-btn"; create.textContent = "Generate";
  create.addEventListener("click", () => {
    if (d.powerMax < d.powerMin) [d.powerMin, d.powerMax] = [d.powerMax, d.powerMin];
    if (d.speedMax < d.speedMin) [d.speedMin, d.speedMax] = [d.speedMax, d.speedMin];
    backdrop.remove();
    onConfirm(d);
  });
  ftr.appendChild(cancel);
  ftr.appendChild(create);
  dialog.appendChild(ftr);

  backdrop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") backdrop.remove();
    if (e.key === "Enter" && document.activeElement !== cancel) create.click();
  });

  document.body.appendChild(backdrop);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function row(label: string, control: HTMLElement): HTMLElement {
  const g = document.createElement("div");
  g.className = "tp-field";
  const l = document.createElement("label");
  l.textContent = label;
  g.append(l, control);
  return g;
}

function sec(title: string): HTMLElement {
  const s = document.createElement("div");
  s.className = "tp-dialog-section-title";
  s.textContent = title;
  s.style.marginTop = "8px";
  return s;
}
