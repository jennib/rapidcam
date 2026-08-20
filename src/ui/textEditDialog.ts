/**
 * Shared dialog for creating / editing a TextEntity.
 * Called by TextTool (create) and SelectTool (double-click edit).
 */

import { listFonts, defaultFontId, loadFromFile, initBundledFonts } from "../core/fontManager";
import { formatLength, parseLength, type Unit } from "../core/units";
import { showError } from "./errorNotice";
import { registerModal } from "./modal";
import { openWebFontDialog } from "./webFontDialog";

export interface TextParams {
  text: string;
  fontId: string;
  sizeMM: number;
  angle: number; // radians
}

export interface TextDialogOptions {
  initial: Partial<TextParams>;
  /** Footer button text. */
  applyLabel: string;
  /**
   * Dialog heading. Explicit, because it used to be inferred by comparing
   * `applyLabel` against one exact string — so retitling the dialog was a side
   * effect of editing a button, and rewording the button silently retitled it.
   */
  title: string;
  /**
   * The document's display unit. The height field is a length, so it must read
   * and write in whatever the document is set to — not the mm this dialog
   * happens to store internally.
   */
  displayUnit: Unit;
  /**
   * Dock the dialog to the right with no dimming, so the canvas stays visible
   * and clicks pass through to it (the `tp-backdrop--peek` variant). The create
   * flow uses this so the glyphs preview live at the anchor and a canvas click
   * can move that anchor; the edit flow stays a normal modal.
   */
  peek?: boolean;
  /**
   * Fired (debounced) as the user edits the fields, so a live canvas preview
   * can follow what is typed. Only the create flow needs it.
   */
  onChange?: (p: TextParams) => void;
  onApply: (p: TextParams) => void;
  onCancel?: () => void;
}

export function openTextDialog(opts: TextDialogOptions): () => void {
  const {
    initial,
    applyLabel,
    title,
    displayUnit,
    peek = false,
    onChange,
    onApply,
    onCancel,
  } = opts;
  const backdrop = document.createElement("div");
  backdrop.className = peek ? "tp-backdrop tp-backdrop--peek" : "tp-backdrop";
  let changeTimer: number | undefined;

  const dialog = document.createElement("div");
  dialog.className = "tp-dialog";
  dialog.style.width = "320px";
  dialog.addEventListener("click", (e) => e.stopPropagation());

  // Header
  const hdr = document.createElement("div");
  hdr.className = "tp-dialog-header";
  const h3 = document.createElement("h3");
  h3.textContent = title;
  hdr.appendChild(h3);
  dialog.appendChild(hdr);

  const body = document.createElement("div");
  body.className = "tp-dialog-body";
  dialog.appendChild(body);

  // Text
  const textInp = addField(body, "Text", (inp) => {
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
  void initBundledFonts(() => {
    refreshFonts();
    // Opened before the bundled fonts finished loading: the select just gained
    // a value, so let the live preview pick it up.
    emitChange();
  });

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
        emitChange();
        if (!embeddable) {
          showError(
            `"${name}" loaded — but its license does not permit embedding. ` +
              `Text using it will NOT be saved into the .rcam file, so it may render ` +
              `as a placeholder (and be omitted from G-code) on machines that don't ` +
              `have the font installed.`,
          );
        }
      } catch (e) {
        showError(`Could not load font: ${(e as Error).message}`);
      }
    };
    inp.click();
  });
  loadRow.appendChild(loadBtn);
  body.appendChild(loadRow);

  // Same idea as the file picker, sourced from the web instead: Google's
  // families by name, or a URL to any font file.
  const webRow = document.createElement("div");
  webRow.className = "tp-field";
  webRow.appendChild(document.createElement("label")); // spacer
  const webBtn = document.createElement("button");
  webBtn.className = "btn";
  webBtn.textContent = "Add a font from the web…";
  webBtn.style.fontSize = "11px";
  webBtn.addEventListener("click", () => {
    openWebFontDialog((fontId) => {
      refreshFonts();
      fontSel.value = fontId;
      emitChange();
    });
  });
  webRow.appendChild(webBtn);
  body.appendChild(webRow);

  // Size. A LENGTH field, so it follows the document's unit and goes through the
  // same parseLength round trip as the generator dialog and dimEditor — which
  // buys the suffix and fraction forms free, so "10mm" and '1/2"' work in either
  // document. It was a hardcoded "Height (mm)" showing raw mm, so an inch project
  // read 25.4 where its Properties panel said 1.000 in.
  //
  // Deliberately a TEXT input, not a number one: `type="number"` rejects '1/2"'
  // and every other form parseLength understands. The stepper arrows are the
  // price, and they are worth less than the units being right.
  const sizeInp = addField(body, `Height (${displayUnit})`, (inp) => {
    inp.type = "text";
    inp.className = "dim";
    inp.value = formatLength(initial.sizeMM ?? 10, displayUnit);
    inp.style.width = "90px";
  });

  // Angle
  const angleInp = addField(body, "Angle (°)", (inp) => {
    inp.type = "number";
    inp.className = "dim";
    inp.value = (((initial.angle ?? 0) * 180) / Math.PI).toFixed(1);
    inp.step = "5";
    inp.style.width = "90px";
  });

  // Live preview: report the current fields (debounced) so the caller can
  // redraw the glyphs as they are typed. Reads the same fields apply() commits,
  // through the same length parse.
  const snapshot = (): TextParams => ({
    text: textInp.value.trim(),
    fontId: fontSel.value,
    sizeMM: Math.max(0.5, parseLength(sizeInp.value, displayUnit) ?? initial.sizeMM ?? 10),
    angle: ((parseFloat(angleInp.value) || 0) * Math.PI) / 180,
  });
  const emitChange = (): void => {
    if (!onChange) return;
    window.clearTimeout(changeTimer);
    changeTimer = window.setTimeout(() => onChange(snapshot()), 150);
  };
  textInp.addEventListener("input", emitChange);
  fontSel.addEventListener("change", emitChange);
  sizeInp.addEventListener("input", emitChange);
  angleInp.addEventListener("input", emitChange);

  // Footer
  const ftr = document.createElement("div");
  ftr.className = "tp-dialog-footer";

  let unregister: () => void = () => {};
  const close = () => {
    window.clearTimeout(changeTimer);
    unregister();
    backdrop.remove();
  };
  // User-driven dismissal (Escape, backdrop click, Cancel) also aborts via
  // onCancel; the returned `close` is the programmatic path that doesn't.
  const cancel = () => {
    close();
    onCancel?.();
  };

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => cancel());

  const apply = (): void => {
    const text = textInp.value.trim();
    if (!text) {
      textInp.focus();
      return;
    }
    if (!fontSel.value) {
      showError("Please select or load a font first.");
      return;
    }
    // parseLength returns mm whatever the field was typed in. A value it can't
    // read keeps the size the dialog opened with rather than silently resetting
    // to a 10mm default the user never chose.
    const parsed = parseLength(sizeInp.value, displayUnit);
    close();
    onApply({
      text,
      fontId: fontSel.value,
      sizeMM: Math.max(0.5, parsed ?? initial.sizeMM ?? 10),
      angle: ((parseFloat(angleInp.value) || 0) * Math.PI) / 180,
    });
  };

  const applyBtn = document.createElement("button");
  applyBtn.className = "btn tp-apply-btn";
  applyBtn.textContent = applyLabel;
  applyBtn.addEventListener("click", () => apply());

  // Allow Enter to apply (Escape is handled globally by the modal manager,
  // which invokes the registered `cancel`).
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Enter") applyBtn.click();
  });

  backdrop.addEventListener("click", (e) => {
    if (e.target !== backdrop) return;
    // Under the peek variant the backdrop is pointer-events: none, so this
    // handler never sees a click (it passes through to the canvas). Under the
    // normal modal it is the conventional click-away-to-cancel.
    cancel();
  });

  ftr.appendChild(cancelBtn);
  ftr.appendChild(applyBtn);
  dialog.appendChild(ftr);
  backdrop.appendChild(dialog);
  unregister = registerModal(backdrop, cancel);
  document.body.appendChild(backdrop);
  // The create flow opens this dialog from a canvas pointerdown, whose default
  // action moves focus to the body AFTER this handler returns — so a focus()
  // here would be undone before the user can type. Re-assert it on the next
  // tick. (Deferring is safe here, unlike the button-opened dialogs: the user
  // just clicked the canvas and has typed nothing, so there is nothing for a
  // delayed focus to steal from — see ui/modal.ts for the case where it is not.)
  textInp.focus();
  setTimeout(() => textInp.focus(), 0);

  return close;
}

function addField(
  parent: HTMLElement,
  label: string,
  configure: (inp: HTMLInputElement) => void,
): HTMLInputElement {
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
