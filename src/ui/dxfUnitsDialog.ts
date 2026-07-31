/**
 * "What units is this DXF in?" — shown when an imported DXF declares no units.
 *
 * $INSUNITS only arrived in R13, so pre-R13 files (AC1009) carry no units at
 * all, and many exporters still omit it. Assuming millimetres silently is a
 * coin flip that lands 25.4× too small on the (common) inch drawing, and the
 * old behaviour buried that in a 6-second toast. Rather than guess, show what
 * each reading actually measures and let the user pick — the numbers make the
 * right answer obvious at a glance.
 */

import { MM_PER_INCH } from "../core/units";
import type { Bounds } from "../model/entities";
import { registerModal } from "./modal";

export type DxfUnitChoice = "mm" | "in";

export interface DxfUnitsPromptOptions {
  /** Shown so the user knows which file is being asked about. */
  fileName: string;
  /** Bounds of the parsed geometry, measured at 1 mm per drawing unit. */
  bounds: Bounds;
  /** Preselected answer — see {@link recommendDxfUnit}. */
  recommended: DxfUnitChoice;
}

/**
 * Which reading to preselect. The file's own hint ($MEASUREMENT) wins when it
 * has one; otherwise go on size. Drawing units are conventionally sized to the
 * unit — an inch drawing runs ~1-50 units, a millimetre one ~50-1000 — so a
 * whole drawing spanning under 50 units is far more likely an inch drawing than
 * a genuinely stamp-sized metric part. Only a preselection either way: the
 * dialog shows both results, so a wrong guess costs one click, not a rescale.
 */
export function recommendDxfUnit(bounds: Bounds, hint: "mm" | "in" | null): DxfUnitChoice {
  if (hint) return hint;
  const span = Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y);
  return span > 0 && span < 50 ? "in" : "mm";
}

/**
 * Resolves to the chosen unit, or null if the user cancelled (Escape, backdrop
 * click, or Cancel) — which cancels the import, since nothing has been added to
 * the document yet and a silent wrong scale is the bug being fixed.
 */
export function chooseDxfUnits(opts: DxfUnitsPromptOptions): Promise<DxfUnitChoice | null> {
  return new Promise((resolve) => {
    const w = opts.bounds.max.x - opts.bounds.min.x;
    const h = opts.bounds.max.y - opts.bounds.min.y;

    const backdrop = document.createElement("div");
    backdrop.className = "tp-backdrop";

    const dialog = document.createElement("div");
    dialog.className = "tp-dialog";
    dialog.style.width = "400px";
    dialog.addEventListener("click", (e) => e.stopPropagation());
    backdrop.appendChild(dialog);

    const hdr = document.createElement("div");
    hdr.className = "tp-dialog-header";
    const h3 = document.createElement("h3");
    h3.textContent = "What units is this DXF in?";
    hdr.appendChild(h3);
    dialog.appendChild(hdr);

    const body = document.createElement("div");
    body.className = "tp-dialog-body";
    const intro = document.createElement("div");
    intro.style.cssText = "font-size:13px;color:var(--text);line-height:1.5";
    intro.textContent =
      `“${opts.fileName}” doesn't record its units, so RapidCAM can't tell how ` +
      `big it is. The drawing measures ${fmt(w)} × ${fmt(h)} drawing units.`;
    body.appendChild(intro);

    let settled = false;
    const finish = (result: DxfUnitChoice | null) => {
      if (settled) return;
      settled = true;
      dispose();
      backdrop.remove();
      resolve(result);
    };
    const close = () => finish(null);
    const dispose = registerModal(backdrop, close);

    // Recommended reading first, so the likely answer is also the top button.
    const order: DxfUnitChoice[] =
      opts.recommended === "in" ? ["in", "mm"] : ["mm", "in"];
    const buttons = order.map((unit) => {
      const scale = unit === "in" ? MM_PER_INCH : 1;
      const btn = document.createElement("button");
      btn.className = "btn";
      btn.dataset.unit = unit;
      btn.style.cssText =
        "display:block;width:100%;text-align:left;margin-top:10px;padding:9px 12px;line-height:1.4";

      const title = document.createElement("div");
      title.style.cssText = "font-weight:600;font-size:13px";
      title.textContent = unit === "in" ? "Inches" : "Millimetres";
      if (unit === opts.recommended) {
        const tag = document.createElement("span");
        tag.textContent = "Recommended";
        tag.style.cssText = "float:right;font-weight:400;font-size:11px;opacity:0.7";
        title.appendChild(tag);
      }

      const size = document.createElement("div");
      size.style.cssText = "font-size:12px;opacity:0.75";
      size.textContent = `Imports at ${fmt(w * scale)} × ${fmt(h * scale)} mm`;

      btn.append(title, size);
      btn.addEventListener("click", () => finish(unit));
      body.appendChild(btn);
      return btn;
    });
    dialog.appendChild(body);

    const ftr = document.createElement("div");
    ftr.className = "tp-dialog-footer";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn";
    cancelBtn.textContent = "Cancel import";
    cancelBtn.addEventListener("click", () => finish(null));
    ftr.appendChild(cancelBtn);
    dialog.appendChild(ftr);

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) finish(null);
    });

    document.body.appendChild(backdrop);
    setTimeout(() => buttons[0].focus(), 40);
  });
}

/** Sizes are for eyeballing, not measuring — one decimal, no trailing ".0". */
function fmt(v: number): string {
  return v.toFixed(1).replace(/\.0$/, "");
}
