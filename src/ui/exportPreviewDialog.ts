/**
 * Export preview — the confirm-before-you-cut screen for "Generate G-code".
 *
 * Shows a top-down backplot of the posted program (rapids faint/dashed, cuts
 * solid), the estimated run time, the job summary, and any pre-flight findings,
 * with Export / Cancel. It replaces the plain pre-flight confirm dialog on the
 * main export path so the run-time total, the toolpath shape, and the lint results
 * live in one place. Promise-based like {@link ./modal}.confirmDialog.
 */

import { registerModal } from "./modal";
import { parseGcodePath } from "../cam/gcodePath";
import { estimateGCodeTime, formatDuration } from "../cam/timeEstimate";
import type { LintFinding } from "../cam/lint";

export interface ExportPreviewOptions {
  /** The full posted program. */
  gcode: string;
  /** Proposed download filename (shown, not editable). */
  filename: string;
  /** Number of toolpaths in the job. */
  opCount: number;
  /** Human stock summary, e.g. "120 × 80 × 12mm". */
  stockLabel: string;
  /** Pre-flight lint findings (may be empty). */
  findings: LintFinding[];
}

const CUT_COLOR = "#5aa0ff";
const RAPID_COLOR = "rgba(150,150,162,0.55)";

/** Draw the toolpath into `canvas`, fit to its bounds (Y-up → screen Y-down). */
function drawBackplot(canvas: HTMLCanvasElement, gcode: string, cssW: number, cssH: number): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#15161a";
  ctx.fillRect(0, 0, cssW, cssH);

  const note = (text: string): void => {
    ctx.fillStyle = "rgba(200,200,210,0.6)";
    ctx.font = "13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(text, cssW / 2, cssH / 2);
  };

  // A dithered/relief raster can post an enormous program; parsing + drawing every
  // move would jank the dialog. The run time + summary still show — just skip the plot.
  if (gcode.length > 2_500_000) {
    note("Backplot omitted for a large program");
    return;
  }

  const { segments, bounds } = parseGcodePath(gcode);
  if (!bounds) {
    note("No toolpath motion");
    return;
  }

  const pad = 14;
  const bw = Math.max(1e-6, bounds.max.x - bounds.min.x);
  const bh = Math.max(1e-6, bounds.max.y - bounds.min.y);
  const scale = Math.min((cssW - 2 * pad) / bw, (cssH - 2 * pad) / bh);
  const ox = (cssW - bw * scale) / 2;
  const oy = (cssH - bh * scale) / 2;
  const tx = (p: { x: number }): number => ox + (p.x - bounds.min.x) * scale;
  const ty = (p: { y: number }): number => cssH - (oy + (p.y - bounds.min.y) * scale);

  // Rapids underneath (dashed), cuts on top (solid) so the part reads clearly.
  for (const rapidPass of [true, false]) {
    ctx.beginPath();
    for (const seg of segments) {
      if (seg.rapid !== rapidPass || seg.pts.length < 2) continue;
      ctx.moveTo(tx(seg.pts[0]), ty(seg.pts[0]));
      for (let i = 1; i < seg.pts.length; i++) ctx.lineTo(tx(seg.pts[i]), ty(seg.pts[i]));
    }
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (rapidPass) {
      ctx.strokeStyle = RAPID_COLOR;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
    } else {
      ctx.strokeStyle = CUT_COLOR;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

/**
 * Show the export preview. Resolves true to export, false on Cancel / Escape /
 * backdrop-click. If any finding is an error, the primary button reads "Export
 * anyway" and is styled as destructive.
 */
export function openExportPreview(opts: ExportPreviewOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const errors = opts.findings.filter((f) => f.severity === "error").length;
    const warnings = opts.findings.length - errors;
    const est = estimateGCodeTime(opts.gcode);

    const backdrop = document.createElement("div");
    backdrop.className = "tp-backdrop";

    const dialog = document.createElement("div");
    dialog.className = "tp-dialog";
    dialog.style.width = "520px";
    dialog.style.maxWidth = "calc(100vw - 32px)";
    dialog.addEventListener("click", (e) => e.stopPropagation());
    backdrop.appendChild(dialog);

    const hdr = document.createElement("div");
    hdr.className = "tp-dialog-header";
    const h = document.createElement("h3");
    h.textContent = "Export preview";
    hdr.appendChild(h);
    dialog.appendChild(hdr);

    const body = document.createElement("div");
    body.className = "tp-dialog-body";
    dialog.appendChild(body);

    // Backplot.
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "display:block;width:100%;border-radius:6px;border:1px solid var(--border,#2a2c33);";
    body.appendChild(canvas);

    // Legend + run time.
    const meta = document.createElement("div");
    meta.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-top:10px;font-size:12px;gap:12px;flex-wrap:wrap;";
    const legend = document.createElement("div");
    legend.style.cssText = "display:flex;gap:14px;opacity:0.85;";
    legend.innerHTML =
      `<span style="color:${CUT_COLOR};">━ cut</span>` +
      `<span style="color:${RAPID_COLOR};">┄ rapid</span>`;
    const runTime = document.createElement("div");
    runTime.style.cssText = "font-size:14px;font-weight:600;";
    runTime.textContent = `⏱ ~${formatDuration(est.seconds)}`;
    runTime.title = `Cut ${formatDuration(est.cutSeconds)} · rapid ${formatDuration(
      est.rapidSeconds,
    )} — constant-feed ballpark (no accel/dwell).`;
    meta.append(legend, runTime);
    body.appendChild(meta);

    // Summary line.
    const summary = document.createElement("div");
    summary.style.cssText = "margin-top:8px;font-size:12px;opacity:0.8;line-height:1.6;";
    summary.textContent =
      `${opts.opCount} toolpath${opts.opCount !== 1 ? "s" : ""} · stock ${opts.stockLabel} · ` +
      `cut ${formatDuration(est.cutSeconds)}, rapid ${formatDuration(est.rapidSeconds)}`;
    body.appendChild(summary);
    const fileRow = document.createElement("div");
    fileRow.style.cssText = "margin-top:2px;font-size:12px;opacity:0.6;";
    fileRow.textContent = `→ ${opts.filename}`;
    body.appendChild(fileRow);

    // Pre-flight findings.
    if (opts.findings.length > 0) {
      const box = document.createElement("div");
      box.style.cssText =
        "margin-top:12px;padding:8px 10px;border-radius:6px;border:1px solid var(--border,#2a2c33);" +
        "background:rgba(0,0,0,0.15);display:flex;flex-direction:column;gap:5px;max-height:132px;overflow-y:auto;";
      const cap = document.createElement("div");
      cap.style.cssText = "font-size:11px;text-transform:uppercase;letter-spacing:0.04em;opacity:0.6;";
      cap.textContent = `Pre-flight — ${errors} error${errors !== 1 ? "s" : ""}, ${warnings} warning${warnings !== 1 ? "s" : ""}`;
      box.appendChild(cap);
      for (const f of opts.findings) {
        const row = document.createElement("div");
        row.style.cssText = `font-size:12px;line-height:1.4;color:${f.severity === "error" ? "#ff6b6b" : "var(--warn)"};`;
        row.textContent = `${f.severity === "error" ? "⛔" : "⚠"} ${f.message}`;
        box.appendChild(row);
      }
      body.appendChild(box);
    }

    // Footer.
    const ftr = document.createElement("div");
    ftr.className = "tp-dialog-footer";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn";
    cancelBtn.textContent = "Cancel";
    const okBtn = document.createElement("button");
    okBtn.className = errors > 0 ? "btn tp-danger-btn" : "btn tp-apply-btn";
    okBtn.textContent = errors > 0 ? "Export anyway" : "Export";
    ftr.append(cancelBtn, okBtn);
    dialog.appendChild(ftr);

    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      dispose();
      backdrop.remove();
      resolve(result);
    };
    const dispose = registerModal(backdrop, () => finish(false));

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) finish(false);
    });
    cancelBtn.addEventListener("click", () => finish(false));
    okBtn.addEventListener("click", () => finish(true));

    document.body.appendChild(backdrop);
    // Draw after layout so the canvas has its final CSS width.
    requestAnimationFrame(() => {
      const cssW = canvas.clientWidth || 490;
      drawBackplot(canvas, opts.gcode, cssW, Math.round(cssW * 0.5));
      okBtn.focus();
    });
  });
}
