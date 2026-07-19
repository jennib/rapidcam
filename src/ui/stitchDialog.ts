/**
 * Stitch phase 4 — the tiled-milling dialog.
 *
 * Lets the user pick a machine-bed (tile) size, a registration style, and an
 * output format, previewing the tile grid live on the canvas, then exports one
 * G-code file per tile (as a zip or separate downloads).
 */

import type { CADDocument } from "../model/document";
import { resolveOrigin } from "../model/document";
import type { Bounds } from "../model/entities";
import type { Vec2 } from "../core/vec2";
import { planTiles } from "../cam/tiling";
import { stitchGCode } from "../cam/stitch";
import type { RegistrationMode } from "../cam/registration";
import { parseProgram, unsupportedMotions } from "../cam/gcodeMotion";
import { programCutBounds } from "../cam/tileClip";
import { zipStore } from "../io/zip";
import type { StitchPreview } from "../view/overlay";
import { registerModal } from "./modal";
import { toast } from "../ui/toast";

const STORE_KEY = "rapidcam:stitch:settings";

interface Settings {
  tileW: number;
  tileH: number;
  registration: RegistrationMode;
  output: "zip" | "files";
}

function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) ?? "");
    if (s && s.tileW > 0 && s.tileH > 0) return s;
  } catch {
    /* ignore */
  }
  return { tileW: 200, tileH: 200, registration: "none", output: "zip" };
}

export interface StitchDialogParams {
  /** Full generated G-code for the whole job (work coordinates). */
  gcode: string;
  doc: CADDocument;
  /** Base filename for the tiles (no extension). */
  baseName: string;
  /** Push tile-grid + feature markers to the canvas overlay (null clears). */
  onPreview: (p: StitchPreview | null) => void;
}

function row(label: string, control: HTMLElement): HTMLElement {
  const r = document.createElement("label");
  r.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;gap:12px;margin:8px 0;font-size:13px;color:var(--text);";
  const l = document.createElement("span");
  l.textContent = label;
  r.append(l, control);
  return r;
}

function numberInput(value: number): HTMLInputElement {
  const i = document.createElement("input");
  i.type = "number";
  i.min = "1";
  i.step = "1";
  i.value = String(value);
  i.style.cssText = "width:90px;padding:4px 6px;";
  return i;
}

function select<T extends string>(options: [T, string][], value: T): HTMLSelectElement {
  const s = document.createElement("select");
  s.style.cssText = "padding:4px 6px;";
  for (const [v, label] of options) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    if (v === value) o.selected = true;
    s.appendChild(o);
  }
  return s;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function openStitchDialog(params: StitchDialogParams): void {
  const { gcode, doc, baseName, onPreview } = params;

  const cutBounds = programCutBounds(parseProgram(gcode));
  if (!cutBounds) {
    toast("No toolpaths to tile — generate some cuts first.");
    return;
  }
  const unsupported = unsupportedMotions(gcode);

  // Work → canvas: emitted X = canvasX − origin, so canvasX = workX + origin.
  const { ox, oy } = resolveOrigin(doc);
  const toCanvas = (p: Vec2): Vec2 => ({ x: p.x + ox, y: p.y + oy });
  const rectToCanvas = (r: Bounds): Bounds => ({ min: toCanvas(r.min), max: toCanvas(r.max) });

  const s = loadSettings();

  const backdrop = document.createElement("div");
  backdrop.className = "tp-backdrop";
  const dialog = document.createElement("div");
  dialog.className = "tp-dialog";
  dialog.style.width = "380px";
  dialog.addEventListener("click", (e) => e.stopPropagation());
  backdrop.appendChild(dialog);

  const hdr = document.createElement("div");
  hdr.className = "tp-dialog-header";
  const h = document.createElement("h3");
  h.textContent = "Tile for a small machine (Stitch)";
  hdr.appendChild(h);
  dialog.appendChild(hdr);

  const body = document.createElement("div");
  body.className = "tp-dialog-body";
  dialog.appendChild(body);

  const wIn = numberInput(s.tileW);
  const hIn = numberInput(s.tileH);
  const regSel = select<RegistrationMode>(
    [
      ["none", "None (align yourself)"],
      ["holes", "Dowel holes"],
      ["crosshairs", "Crosshairs"],
      ["both", "Holes + crosshairs"],
    ],
    s.registration,
  );
  const outSel = select<"zip" | "files">(
    [
      ["zip", "One .zip"],
      ["files", "Separate files"],
    ],
    s.output,
  );

  body.append(
    row("Machine bed width (mm)", wIn),
    row("Machine bed height (mm)", hIn),
    row("Registration", regSel),
    row("Output", outSel),
  );

  const summary = document.createElement("div");
  summary.style.cssText = "margin-top:10px;font-size:13px;color:var(--text);min-height:20px;";
  body.appendChild(summary);

  if (unsupported.length) {
    const warn = document.createElement("div");
    warn.style.cssText = "margin-top:8px;font-size:12px;color:var(--warn, #e5a13a);line-height:1.4;";
    warn.textContent = `This job uses ${unsupported.join(", ")}, which Stitch can't tile. Re-post with the GRBL processor (or avoid bezier engraving) first.`;
    body.appendChild(warn);
  }

  const ftr = document.createElement("div");
  ftr.className = "tp-dialog-footer";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn";
  cancelBtn.textContent = "Cancel";
  const exportBtn = document.createElement("button");
  exportBtn.className = "btn tp-apply-btn";
  exportBtn.textContent = "Export tiles";
  ftr.append(cancelBtn, exportBtn);
  dialog.appendChild(ftr);

  const read = () => ({
    tileW: Number(wIn.value),
    tileH: Number(hIn.value),
    registration: regSel.value as RegistrationMode,
    output: outSel.value as "zip" | "files",
  });

  const update = () => {
    const v = read();
    if (!(v.tileW > 0) || !(v.tileH > 0)) {
      summary.textContent = "Enter a bed size.";
      onPreview(null);
      exportBtn.disabled = true;
      return;
    }
    const plan = planTiles(cutBounds, { tileW: v.tileW, tileH: v.tileH });
    onPreview({
      tiles: plan.tiles.map((t) => rectToCanvas(t.rect)),
      features: v.registration === "none" ? [] : plan.features.map(toCanvas),
    });
    summary.textContent =
      plan.tiles.length === 1
        ? "Fits the bed — no tiling needed."
        : `${plan.tiles.length} tiles — ${plan.cols} × ${plan.rows} grid.`;
    exportBtn.disabled = unsupported.length > 0;
  };

  for (const el of [wIn, hIn, regSel, outSel]) el.addEventListener("input", update);

  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    onPreview(null);
    dispose();
    backdrop.remove();
  };
  const dispose = registerModal(backdrop, finish);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) finish();
  });
  cancelBtn.addEventListener("click", finish);

  exportBtn.addEventListener("click", () => {
    const v = read();
    localStorage.setItem(STORE_KEY, JSON.stringify(v));
    const res = stitchGCode(gcode, {
      tileW: v.tileW,
      tileH: v.tileH,
      name: baseName,
      registration: v.registration,
    });
    if (res.tiles.length === 0) {
      toast(res.warnings[0] ?? "Nothing to tile.");
      return;
    }
    if (v.output === "zip") {
      const bytes = zipStore(res.tiles.map((t) => ({ name: `${t.name}.nc`, data: t.gcode })));
      downloadBlob(
        new Blob([bytes as BlobPart], { type: "application/zip" }),
        `${baseName}_tiles.zip`,
      );
    } else {
      for (const t of res.tiles)
        downloadBlob(new Blob([t.gcode], { type: "text/plain" }), `${t.name}.nc`);
    }
    const tileWarn = res.tiles.some((t) => t.warnings.length)
      ? " (some paths vary in Z — check seam entries)"
      : "";
    toast(`Exported ${res.tiles.length} tile${res.tiles.length > 1 ? "s" : ""}${tileWarn}.`);
    finish();
  });

  document.body.appendChild(backdrop);
  update();
  setTimeout(() => wIn.focus(), 40);
}
