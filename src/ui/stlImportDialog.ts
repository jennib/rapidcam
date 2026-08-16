/**
 * Import a 3-D model as a carveable relief.
 *
 * The model is rasterised to a height map here and now, and the mesh is thrown
 * away — the document stores an image, which is what the relief toolpath reads
 * anyway. Every heightfield-school tool works this way (Vectric, Carveco, Easel
 * Pro, Carbide Create Pro), and it is Blender CAM's documented "non-exact" mode,
 * chosen there for exactly the reason it is chosen here: it does not care how
 * many triangles arrived.
 *
 * ## What actually needs asking
 *
 * Three things, because getting any of them wrong is silent:
 *
 * - **Units.** STL carries none. A file authored in inches read as millimetres is
 *   a part 25.4× too small, and nothing about the geometry says which it was. The
 *   heuristic only picks the more likely default; the size readout beside the
 *   control is what actually settles it, because a user knows how big their part
 *   is supposed to be.
 * - **Which way is up.** The height map is a view from the tool, so a Y-up export
 *   carves the model lying on its side.
 * - **Carve depth.** Defaults to the model's true height, which is the only
 *   answer that reproduces the object rather than a squashed relief of it.
 *
 * Everything else — resolution, the depth encoding, the tone controls that must
 * not apply — is decided by the code, because there is no version of those
 * questions a user is better placed to answer than {@link ../cam/stlHeightfield}.
 *
 * The preview is a real render of the buffer that will be registered, at the
 * resolution it will be registered at. It is the same "look at the field before
 * trusting it" check the rasteriser's own probe script does, put in front of the
 * person who knows what the model is supposed to look like.
 *
 * ## The warning, and why it is conditional
 *
 * "Models with a flat back work best" used to sit here unconditionally, which is
 * close to saying nothing: the one user who needs it never notices, and everyone
 * who doesn't reads it anyway. It is replaced by a warning that fires only when
 * the model earns it, states the measured percentage, and names the consequence —
 * see {@link PLINTH_WARN} for what is measured and how the threshold was
 * calibrated.
 *
 * It is advice, not a gate: `Place` stays enabled, because a full 3-D model does
 * carve, just not into the object the user is picturing. And because the number
 * follows the up axis, the warning clears when they pick the face they meant,
 * which is the most useful thing it does.
 */

import { PLINTH_WARN, stlHeightfield, type Heightfield, type UpAxis } from "../cam/stlHeightfield";
import { suggestUnitScale, type STLMesh } from "../io/stlImport";
import { registerModal } from "./modal";

export interface STLPlacement {
  imageId: string;
  widthMM: number;
  heightMM: number;
  /** The model's height range at the chosen scale — the carve depth at true scale. */
  zRangeMM: number;
}

/** The orientations offered, in the order a user is likely to want them. */
const UP_AXES: [UpAxis, string][] = [
  ["+Z", "Z up (standard)"],
  ["+Y", "Y up (from some exporters)"],
  ["-Z", "Z down (carve the underside)"],
  ["+X", "X up"],
  ["-Y", "Y down"],
  ["-X", "X down"],
];

export function openSTLImportDialog(
  mesh: STLMesh,
  name: string,
  onPlace: (hf: Heightfield, name: string) => void,
): void {
  document.getElementById("stl-backdrop")?.remove();

  const suggestion = suggestUnitScale(mesh);
  let scale = suggestion.scale;
  let up: UpAxis = "+Z";
  let hf = stlHeightfield(mesh, { up, scale });

  const backdrop = document.createElement("div");
  backdrop.id = "stl-backdrop";
  backdrop.className = "tp-backdrop";
  let unregister: () => void = () => {};
  const close = () => {
    unregister();
    backdrop.remove();
  };
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  const dialog = document.createElement("div");
  dialog.className = "tp-dialog npd-dialog";
  dialog.addEventListener("click", (e) => e.stopPropagation());
  backdrop.appendChild(dialog);

  const hdr = document.createElement("div");
  hdr.className = "tp-dialog-header";
  const titleEl = document.createElement("h3");
  titleEl.textContent = "Import 3D Model as Relief";
  hdr.appendChild(titleEl);
  dialog.appendChild(hdr);

  const body = document.createElement("div");
  body.className = "tp-dialog-body";
  dialog.appendChild(body);

  const note = document.createElement("p");
  note.className = "post-settings-note";
  note.textContent =
    "The model becomes a height map: white is the top surface, black the base. " +
    "Carve it with a relief toolpath — rough it out with an end mill first, then " +
    "finish with a ball-nose. Only the surface facing the tool is cut, so overhangs " +
    "and undercuts come out as vertical walls.";
  body.appendChild(note);

  // Shown only when the model earns it — see PLINTH_WARN for the measurement.
  // Placed above the preview so it is read before the picture is interpreted.
  const warning = document.createElement("p");
  warning.className = "stl-warning";
  warning.hidden = true;
  body.appendChild(warning);

  const preview = document.createElement("canvas");
  preview.style.display = "block";
  preview.style.margin = "0 auto 10px";
  preview.style.maxWidth = "260px";
  preview.style.maxHeight = "220px";
  preview.style.width = "auto";
  preview.style.height = "auto";
  preview.style.background = "#000";
  preview.style.border = "1px solid var(--border, #333)";
  body.appendChild(preview);
  const pctx = preview.getContext("2d")!;

  /** A row of label + control + live readout — the readout is the point. */
  const row = (label: string, control: HTMLElement): HTMLSpanElement => {
    const wrap = document.createElement("div");
    wrap.className = "tp-field";
    const l = document.createElement("label");
    l.textContent = label;
    const readout = document.createElement("span");
    readout.style.opacity = "0.75";
    readout.style.marginLeft = "8px";
    // The readout is the control's whole point — a user settles the units by
    // recognising the size, not by knowing what the file was authored in. Let the
    // SELECT give up width instead, or "20.0 mm deep" wraps onto three lines.
    readout.style.whiteSpace = "nowrap";
    control.style.minWidth = "0";
    control.style.flex = "1 1 auto";
    wrap.append(l, control, readout);
    body.appendChild(wrap);
    return readout;
  };

  const unitSel = document.createElement("select");
  for (const [v, t] of [
    ["1", "Millimetres"],
    ["25.4", "Inches"],
  ])
    unitSel.appendChild(new Option(t, v));
  unitSel.value = String(scale);
  const sizeOut = row("Units", unitSel);

  const upSel = document.createElement("select");
  for (const [v, t] of UP_AXES) upSel.appendChild(new Option(t, v));
  const depthOut = row("Up axis", upSel);

  const hint = document.createElement("p");
  hint.className = "post-settings-note";
  body.appendChild(hint);

  const redraw = (): void => {
    hf = stlHeightfield(mesh, { up, scale });
    preview.width = hf.width;
    preview.height = hf.height;
    const img = pctx.createImageData(hf.width, hf.height);
    for (let i = 0; i < hf.gray.length; i++) {
      const v = hf.gray[i];
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    pctx.putImageData(img, 0, 0);

    // Recomputed on every change, because the answer follows the orientation:
    // the same bust reads 57% carved from her back and 0.3% from her face.
    const plinth = hf.plinthRatio;
    warning.hidden = plinth < PLINTH_WARN;
    // Kept to three lines deliberately. At six it pushed the Up axis control —
    // the one this very text tells the user to reach for — below the fold of the
    // dialog's scrolling body on a 620px-tall window.
    warning.textContent =
      `Full 3-D shape, not a relief: ${Math.round(plinth * 100)}% of this carving ` +
      `will be solid plinth a cutter can't reach under. If the model has a flatter ` +
      `side, try another up axis.`;

    const zRange = hf.zMaxMM - hf.zMinMM;
    sizeOut.textContent = `${fmt(hf.widthMM)} × ${fmt(hf.heightMM)} mm`;
    depthOut.textContent = `${fmt(zRange)} mm deep`;
    hint.textContent =
      `Carve depth at true scale is ${fmt(zRange)} mm, over ${hf.width}×${hf.height} samples ` +
      `(${fmt(hf.widthMM / hf.width)} mm per sample). ` +
      (suggestion.confident
        ? ""
        : `Units could not be told from the model — at the other setting it would be ` +
          `${fmt(hf.widthMM * (scale === 1 ? 25.4 : 1 / 25.4))} mm wide. `) +
      (hf.zMaxMM <= hf.zMinMM
        ? "This model is flat: there is no relief to carve. "
        : "");
  };

  unitSel.addEventListener("change", () => {
    scale = Number(unitSel.value);
    redraw();
  });
  upSel.addEventListener("change", () => {
    up = upSel.value as UpAxis;
    redraw();
  });

  const ftr = document.createElement("div");
  ftr.className = "tp-dialog-footer";
  const cancel = document.createElement("button");
  cancel.className = "btn";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => close());
  const place = document.createElement("button");
  place.className = "btn tp-apply-btn";
  place.textContent = "Place";
  place.addEventListener("click", () => {
    close();
    onPlace(hf, name);
  });
  ftr.append(cancel, place);
  dialog.appendChild(ftr);

  backdrop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && document.activeElement !== cancel) place.click();
  });

  redraw();
  unregister = registerModal(backdrop, close);
  document.body.appendChild(backdrop);
}

function fmt(v: number): string {
  return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
}
