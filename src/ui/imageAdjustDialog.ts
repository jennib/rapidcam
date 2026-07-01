import { type DecodedImage, type ToneAdjust, adjustGrey } from "../core/imageManager";

/**
 * Import-time tone adjustment for an engrave image. Shows a live greyscale
 * preview with brightness/contrast sliders; `onConfirm` receives the chosen
 * adjustment (which the caller bakes into the stored buffer). Cancelling aborts
 * the import. The preview is the very thing the machine will burn/carve, so what
 * you see is what you cut.
 */
export function openImageAdjustDialog(
  img: DecodedImage,
  onConfirm: (adj: ToneAdjust) => void,
): void {
  document.getElementById("iad-backdrop")?.remove();
  const adj: ToneAdjust = { brightness: 0, contrast: 0 };

  const backdrop = document.createElement("div");
  backdrop.id = "iad-backdrop";
  backdrop.className = "tp-backdrop";
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });

  const dialog = document.createElement("div");
  dialog.className = "tp-dialog npd-dialog";
  dialog.addEventListener("click", (e) => e.stopPropagation());
  backdrop.appendChild(dialog);

  const hdr = document.createElement("div");
  hdr.className = "tp-dialog-header";
  const titleEl = document.createElement("h3");
  titleEl.textContent = "Adjust Image for Engraving";
  hdr.appendChild(titleEl);
  dialog.appendChild(hdr);

  const body = document.createElement("div");
  body.className = "tp-dialog-body";
  dialog.appendChild(body);

  const note = document.createElement("p");
  note.className = "post-settings-note";
  note.textContent =
    "Dark = deeper/stronger burn, white = untouched. Tune brightness and contrast " +
    "so the subject reads clearly — the preview is what the machine reproduces.";
  body.appendChild(note);

  // Preview canvas (drawn at image resolution, sized down by CSS).
  const preview = document.createElement("canvas");
  preview.width = img.width; preview.height = img.height;
  preview.style.display = "block";
  preview.style.margin = "0 auto 10px";
  preview.style.maxWidth = "260px";
  preview.style.maxHeight = "220px";
  preview.style.width = "auto";
  preview.style.height = "auto";
  preview.style.imageRendering = "auto";
  preview.style.background = "#000";
  preview.style.border = "1px solid var(--border, #333)";
  body.appendChild(preview);
  const pctx = preview.getContext("2d")!;
  const imageData = pctx.createImageData(img.width, img.height);

  const redraw = (): void => {
    const g = adjustGrey(img.gray, adj);
    const d = imageData.data;
    for (let i = 0; i < g.length; i++) {
      const v = g[i];
      d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
    }
    pctx.putImageData(imageData, 0, 0);
  };

  const slider = (label: string, get: () => number, set: (v: number) => void): HTMLElement => {
    const wrap = document.createElement("div");
    wrap.className = "tp-field";
    const l = document.createElement("label");
    l.textContent = label;
    const input = document.createElement("input");
    input.type = "range"; input.min = "-100"; input.max = "100"; input.step = "1";
    input.value = String(get());
    input.style.flex = "1";
    const val = document.createElement("span");
    val.textContent = String(get());
    val.style.minWidth = "2.5em";
    val.style.textAlign = "right";
    input.addEventListener("input", () => {
      const v = parseInt(input.value, 10);
      set(v); val.textContent = String(v); redraw();
    });
    wrap.append(l, input, val);
    body.appendChild(wrap);
    return input;
  };

  const bSlider = slider("Brightness", () => adj.brightness, (v) => { adj.brightness = v; });
  const cSlider = slider("Contrast", () => adj.contrast, (v) => { adj.contrast = v; });

  const ftr = document.createElement("div");
  ftr.className = "tp-dialog-footer";
  const reset = document.createElement("button");
  reset.className = "btn"; reset.textContent = "Reset";
  reset.style.marginRight = "auto";
  reset.addEventListener("click", () => {
    adj.brightness = 0; adj.contrast = 0;
    (bSlider as HTMLInputElement).value = "0"; (cSlider as HTMLInputElement).value = "0";
    bSlider.nextElementSibling!.textContent = "0";
    cSlider.nextElementSibling!.textContent = "0";
    redraw();
  });
  const cancel = document.createElement("button");
  cancel.className = "btn"; cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => backdrop.remove());
  const place = document.createElement("button");
  place.className = "btn tp-apply-btn"; place.textContent = "Place";
  place.addEventListener("click", () => { backdrop.remove(); onConfirm(adj); });
  ftr.append(reset, cancel, place);
  dialog.appendChild(ftr);

  backdrop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") backdrop.remove();
    if (e.key === "Enter" && document.activeElement !== cancel) place.click();
  });

  redraw();
  document.body.appendChild(backdrop);
}
