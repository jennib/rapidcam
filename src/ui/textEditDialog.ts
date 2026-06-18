/**
 * Shared dialog for creating / editing a TextEntity.
 * Called by TextTool (create) and SelectTool (double-click edit).
 */

import { listFonts, defaultFontId, loadFromFile, initBundledFonts } from "../core/fontManager";

export interface TextParams {
  text: string;
  fontId: string;
  sizeMM: number;
  angle: number; // radians
}

export function openTextDialog(
  initial: Partial<TextParams>,
  applyLabel: string,
  onApply: (p: TextParams) => void,
  onCancel?: () => void,
): () => void {
  const backdrop = document.createElement("div");
  backdrop.className = "tp-backdrop";

  const dialog = document.createElement("div");
  dialog.className = "tp-dialog";
  dialog.style.width = "320px";
  dialog.addEventListener("click", e => e.stopPropagation());

  // Header
  const hdr = document.createElement("div");
  hdr.className = "tp-dialog-header";
  const h3 = document.createElement("h3");
  h3.textContent = applyLabel === "Stamp (click canvas)" ? "Place Text" : "Edit Text";
  hdr.appendChild(h3);
  dialog.appendChild(hdr);

  const body = document.createElement("div");
  body.className = "tp-dialog-body";
  dialog.appendChild(body);

  // Text
  const textInp = addField(body, "Text", inp => {
    inp.type = "text";
    inp.className = "dim";
    inp.value = initial.text ?? "";
    inp.style.width = "200px";
    inp.placeholder = "Enter text…";
  });

  // Font selector
  const fontRow = document.createElement("div");
  fontRow.className = "tp-field";
  const fontLbl = document.createElement("label");
  fontLbl.textContent = "Font";
  fontRow.appendChild(fontLbl);
  const fontSel = document.createElement("select");
  fontSel.className = "dim";
  fontSel.style.width = "180px";
  fontRow.appendChild(fontSel);
  body.appendChild(fontRow);

  const refreshFonts = () => {
    const fonts = listFonts();
    fontSel.innerHTML = "";
    if (fonts.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "— Load a font below —";
      fontSel.appendChild(opt);
      return;
    }
    const wantId = initial.fontId ?? defaultFontId();
    for (const f of fonts) {
      const opt = document.createElement("option");
      opt.value = f.id;
      opt.textContent = f.name;
      opt.selected = f.id === wantId;
      fontSel.appendChild(opt);
    }
    if (!fontSel.value && fonts.length) fontSel.value = fonts[0].id;
  };
  refreshFonts();
  void initBundledFonts(() => refreshFonts());

  // Load font button
  const loadRow = document.createElement("div");
  loadRow.className = "tp-field";
  loadRow.appendChild(document.createElement("label")); // spacer
  const loadBtn = document.createElement("button");
  loadBtn.className = "btn";
  loadBtn.textContent = "Load font (.ttf / .otf / .woff)…";
  loadBtn.style.fontSize = "11px";
  loadBtn.addEventListener("click", () => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".ttf,.otf,.woff,.woff2";
    inp.onchange = async () => {
      const file = inp.files?.[0];
      if (!file) return;
      try {
        const { id, name, embeddable } = await loadFromFile(file);
        refreshFonts();
        fontSel.value = id;
        if (!embeddable) {
          alert(
            `"${name}" loaded — but its license does not permit embedding. ` +
            `Text using it will NOT be saved into the .rcam file, so it may render ` +
            `as a placeholder (and be omitted from G-code) on machines that don't ` +
            `have the font installed.`,
          );
        }
      } catch (e) {
        alert(`Could not load font: ${(e as Error).message}`);
      }
    };
    inp.click();
  });
  loadRow.appendChild(loadBtn);
  body.appendChild(loadRow);

  // Size
  const sizeInp = addField(body, "Height (mm)", inp => {
    inp.type = "number";
    inp.className = "dim";
    inp.value = (initial.sizeMM ?? 10).toString();
    inp.step = "0.5";
    inp.min = "0.5";
    inp.style.width = "90px";
  });

  // Angle
  const angleInp = addField(body, "Angle (°)", inp => {
    inp.type = "number";
    inp.className = "dim";
    inp.value = ((initial.angle ?? 0) * 180 / Math.PI).toFixed(1);
    inp.step = "5";
    inp.style.width = "90px";
  });

  // Footer
  const ftr = document.createElement("div");
  ftr.className = "tp-dialog-footer";

  const close = () => backdrop.remove();

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => { close(); onCancel?.(); });

  const applyBtn = document.createElement("button");
  applyBtn.className = "btn tp-apply-btn";
  applyBtn.textContent = applyLabel;
  applyBtn.addEventListener("click", () => {
    const text = textInp.value.trim();
    if (!text) { textInp.focus(); return; }
    if (!fontSel.value) { alert("Please select or load a font first."); return; }
    close();
    onApply({
      text,
      fontId: fontSel.value,
      sizeMM: Math.max(0.5, parseFloat(sizeInp.value) || 10),
      angle: (parseFloat(angleInp.value) || 0) * Math.PI / 180,
    });
  });

  // Allow Enter to apply
  dialog.addEventListener("keydown", e => {
    if (e.key === "Enter") applyBtn.click();
    if (e.key === "Escape") { close(); onCancel?.(); }
  });

  backdrop.addEventListener("click", e => { if (e.target === backdrop) { close(); onCancel?.(); } });

  ftr.appendChild(cancelBtn);
  ftr.appendChild(applyBtn);
  dialog.appendChild(ftr);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);
  setTimeout(() => textInp.focus(), 0);

  return close;
}

function addField(parent: HTMLElement, label: string, configure: (inp: HTMLInputElement) => void): HTMLInputElement {
  const row = document.createElement("div");
  row.className = "tp-field";
  const lbl = document.createElement("label");
  lbl.textContent = label;
  const inp = document.createElement("input");
  configure(inp);
  row.appendChild(lbl);
  row.appendChild(inp);
  parent.appendChild(row);
  return inp;
}
