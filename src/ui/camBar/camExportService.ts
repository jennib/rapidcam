/**
 * G-code generation, pre-flight linting, file export, and machine sender integration.
 * Extracted from camBar.ts to decouple CAM file/communication orchestration from UI view rendering.
 */
import type { CADDocument } from "../../model/document";
import { stockFootprint } from "../../model/document";
import type { CAMOperation } from "../../cam/types";
import { selectedOpsInOrder } from "../../cam/types";
import { TextEntity } from "../../model/entities";
import { generateGCode, type GCodeOptions } from "../../cam/gcode";
import { generateRotaryProgram } from "../../cam/klein";
import { generateFlipPrograms, opFace } from "../../cam/flip";
import { lintGCode, buildLintContext } from "../../cam/lint";
import { formatLength } from "../../core/units";
import { timeStamp, formatExportName } from "../../cam/exportName";
import { zipStore } from "../../io/zip";
import { isFontResolvable } from "../../core/fontManager";
import { confirmDialog } from "../modal";
import { openExportPreview } from "../exportPreviewDialog";
import { showSenderDialog } from "../senderDialog";
import { toast } from "../toast";
import { maybeShowSharePrompt } from "../sharePrompt";
import { track } from "../../analytics";
import {
  getCustomGcode,
  getMachineHasCoolant,
  getHasToolChanger,
  getRotaryAxisWord,
  getArcTolerance,
  getBed,
  getGsenderUrl,
  getNcsenderUrl,
  getPostFor,
} from "../../core/prefs";
import { sendToGsender } from "../../io/gsender";
import { sendToNcsender } from "../../io/ncsender";

export interface CamExportContext {
  doc: CADDocument;
  getProjectName?: () => string;
}

export class CamExportService {
  constructor(private ctx: CamExportContext) {}

  private get doc(): CADDocument {
    return this.ctx.doc;
  }

  /**
   * The machine's contribution to a generated program. Everything here is
   * machine configuration read from the local profile, never from the document.
   */
  public gcodeOpts(): GCodeOptions {
    const g = getCustomGcode();
    return {
      customStart: g.start,
      customEnd: g.end,
      coolantSupported: getMachineHasCoolant(),
      postProcessor: getPostFor(this.doc.isLaser ? "laser" : "mill"),
      hasToolChanger: getHasToolChanger(),
      rotaryAxisWord: getRotaryAxisWord(),
      arcTolerance: getArcTolerance(),
      bed: getBed(),
    };
  }

  /**
   * Apollo pre-flight: lint the generated G-code before it reaches the machine.
   * Clean output exports silently; any findings gate behind a review dialog the
   * user can override ("Export anyway"). Errors colour the confirm red. Returns
   * true to proceed with export.
   */
  public async preflight(
    gcode: string,
    ctxOpts?: { extraDepthBelowBottom?: number },
  ): Promise<boolean> {
    const findings = lintGCode(gcode, buildLintContext(this.doc, { ...ctxOpts, bed: getBed() }));
    if (findings.length === 0) return true;
    const errors = findings.filter((f) => f.severity === "error").length;
    const warnings = findings.length - errors;
    track("gcode_lint", { errors, warnings });
    const message = [
      `${findings.length} pre-flight issue${findings.length > 1 ? "s" : ""} found:`,
      "",
      ...findings.flatMap((f) => [`${f.severity === "error" ? "⛔" : "⚠"} ${f.message}`, ""]),
      "Export anyway?",
    ].join("\n");
    // Findings that name geometry (machinability) highlight it on the canvas
    // while the dialog is up.
    const highlightIds = findings.flatMap((f) => f.entityIds ?? []);
    if (highlightIds.length) {
      this.doc.toolpathHighlightIds = new Set(highlightIds);
      this.doc.emitChange();
    }
    try {
      return await confirmDialog({
        title: "Pre-flight check",
        message,
        confirmLabel: "Export anyway",
        cancelLabel: "Review first",
        danger: errors > 0,
        peek: highlightIds.length > 0,
      });
    } finally {
      if (highlightIds.length) {
        this.doc.toolpathHighlightIds = null;
        this.doc.emitChange();
      }
    }
  }

  /** Export all toolpaths. */
  public async generate(): Promise<void> {
    if (this.doc.operations.length === 0) {
      alert("Add at least one toolpath first.");
      return;
    }
    if (!(await this.confirmMissingFonts())) return;
    const isRotary = this.doc.isRotary;
    // Double-sided jobs export two programs (top + mirrored bottom). Not for a
    // rotary job (flip and the wrap are mutually exclusive).
    if (!isRotary && this.doc.flip && this.doc.operations.some((op) => opFace(op) === "bottom")) {
      await this.generateFlip();
      return;
    }
    // Rotary jobs wrap the flat program around a cylinder (single program).
    let gcode: string;
    if (isRotary) {
      const wrapped = await this.rotaryProgram("Export anyway");
      if (wrapped === null) return;
      gcode = wrapped;
    } else {
      gcode = generateGCode(this.doc.operations, this.doc, this.gcodeOpts());
    }
    const name = this.exportName(isRotary ? "all-rotary" : "all");
    const foot = stockFootprint(this.doc);
    const fw = formatLength(foot.width, "mm");
    const fh = formatLength(foot.height, "mm");
    const stockLabel = this.doc.isLaser
      ? `${fw} × ${fh}mm`
      : `${fw} × ${fh} × ${formatLength(this.doc.stockThickness, "mm")}mm`;
    const proceed = await openExportPreview({
      gcode,
      filename: name,
      opCount: this.doc.operations.length,
      stockLabel,
      findings: lintGCode(gcode, buildLintContext(this.doc, { bed: getBed() })),
    });
    if (!proceed) return;
    track("gcode_generated", {
      operation_count: this.doc.operations.length,
      ...(isRotary ? { rotary: true } : {}),
    });
    this.download(gcode, name);
    maybeShowSharePrompt();
  }

  /** Export a chosen subset of toolpaths into a single file. */
  public async exportSelected(selectedOpIds: ReadonlySet<string>): Promise<void> {
    const ops = selectedOpsInOrder(this.doc.operations, selectedOpIds);
    if (ops.length === 0) return;
    const gcode = generateGCode(ops, this.doc, this.gcodeOpts());
    if (!(await this.preflight(gcode))) return;
    track("gcode_generated", { operation_count: ops.length, subset: true });
    const file = this.download(gcode, this.exportName(`selected-${ops.length}`));
    toast(
      `Exported ${ops.length} selected toolpath${ops.length > 1 ? "s" : ""}${this.depthSummary(ops)} → ${file}`,
    );
    maybeShowSharePrompt();
  }

  /** Export a single operation. */
  public async exportSingleOp(op: CAMOperation, index: number): Promise<void> {
    const code = generateGCode([op], this.doc, this.gcodeOpts());
    if (!(await this.preflight(code))) return;
    const file = this.download(code, this.exportName(`op${index + 1}-${op.name}`));
    toast(`Exported "${op.name}" → ${file}`);
  }

  /**
   * Build the wrapped rotary program, gating on its pre-flight advisories.
   */
  public async rotaryProgram(continueLabel: string): Promise<string | null> {
    const { program, warnings } = generateRotaryProgram(this.doc, this.gcodeOpts());
    if (warnings.length > 0) {
      const proceed = await confirmDialog({
        title: "Rotary wrap setup",
        message: `${warnings.map((w: string) => `⚠ ${w}`).join("\n\n")}\n\n${continueLabel}?`,
        confirmLabel: continueLabel,
        cancelLabel: "Review first",
      });
      if (!proceed) return null;
    }
    return program;
  }

  /**
   * Export a double-sided job: a side-A program and a mirrored side-B program.
   */
  public async generateFlip(): Promise<void> {
    const flip = this.doc.flip!;
    const { sideA, sideB, warnings, hasPins } = generateFlipPrograms(this.doc, this.gcodeOpts());
    if (warnings.length > 0) {
      const proceed = await confirmDialog({
        title: "Two-sided setup",
        message: `${warnings.map((w: string) => `⚠ ${w}`).join("\n\n")}\n\nExport anyway?`,
        confirmLabel: "Export anyway",
        cancelLabel: "Review first",
      });
      if (!proceed) return;
    }
    if (
      !(await this.preflight(sideA, hasPins ? { extraDepthBelowBottom: flip.pinDepth } : undefined))
    )
      return;
    if (!(await this.preflight(sideB))) return;
    track("gcode_generated", { operation_count: this.doc.operations.length, flip: true });
    const project = this.projectName();
    const stamp = timeStamp();
    const nameA = formatExportName({ project, scope: "sideA", stamp });
    const nameB = formatExportName({ project, scope: "sideB", stamp });
    const zipName = formatExportName({ project, scope: "two-sided", stamp, ext: "zip" });
    const bytes = zipStore([
      { name: nameA, data: sideA },
      { name: nameB, data: sideB },
    ]);
    const blob = new Blob([bytes as BlobPart], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = zipName;
    a.click();
    URL.revokeObjectURL(url);
    toast(`Exported side A + side B → ${zipName}`);
    maybeShowSharePrompt();
  }

  /** Hand the whole program to a running sender app. */
  public async sendToMachine(): Promise<void> {
    if (this.doc.operations.length === 0) {
      alert("Add at least one toolpath first.");
      return;
    }
    showSenderDialog((selectedApp) => {
      void this.doSendToMachine(selectedApp);
    });
  }

  private async doSendToMachine(app: "gSender" | "ncSender"): Promise<void> {
    if (!(await this.confirmMissingFonts())) return;
    const isRotary = this.doc.isRotary;
    if (!isRotary && this.doc.flip && this.doc.operations.some((op) => opFace(op) === "bottom")) {
      await this.sendFlip(app);
      return;
    }
    let gcode: string;
    if (isRotary) {
      const wrapped = await this.rotaryProgram("Send anyway");
      if (wrapped === null) return;
      gcode = wrapped;
    } else {
      gcode = generateGCode(this.doc.operations, this.doc, this.gcodeOpts());
    }
    if (!(await this.preflight(gcode))) return;

    toast(`Sending to ${app}…`);
    const jobName = this.exportName(isRotary ? "all-rotary" : "all");

    let res: { ok: boolean; hint?: string; error?: string; port?: string };
    if (app === "gSender") {
      res = await sendToGsender(getGsenderUrl(), jobName, gcode);
    } else {
      res = await sendToNcsender(getNcsenderUrl(), jobName, gcode);
    }

    track("gcode_sent_machine", {
      app,
      ok: res.ok,
      hint: res.hint,
      ...(isRotary ? { rotary: true } : {}),
    });

    if (res.ok) {
      toast(
        res.port
          ? `Loaded into ${app} on ${res.port} — press Play there to run.`
          : `Loaded into ${app} — connect your machine and press Play there.`,
      );
      maybeShowSharePrompt();
      return;
    }

    const download = await confirmDialog({
      title: `Couldn't send to ${app}`,
      message: `${res.error}\n\nDownload the G-code file instead?`,
      confirmLabel: "Download file",
      cancelLabel: "Close",
    });
    if (download) {
      const file = this.download(gcode, jobName);
      toast(`Exported → ${file}`);
    }
  }

  private async sendFlip(app: "gSender" | "ncSender"): Promise<void> {
    const flip = this.doc.flip!;
    const { sideA, sideB, warnings, hasPins } = generateFlipPrograms(this.doc, this.gcodeOpts());
    if (warnings.length > 0) {
      const proceed = await confirmDialog({
        title: "Two-sided setup",
        message: `${warnings.map((w: string) => `⚠ ${w}`).join("\n\n")}\n\nContinue anyway?`,
        confirmLabel: "Continue anyway",
        cancelLabel: "Review first",
      });
      if (!proceed) return;
    }
    if (
      !(await this.preflight(sideA, hasPins ? { extraDepthBelowBottom: flip.pinDepth } : undefined))
    )
      return;

    const project = this.projectName();
    const stamp = timeStamp();
    const nameA = formatExportName({ project, scope: "sideA", stamp });
    const nameB = formatExportName({ project, scope: "sideB", stamp });

    toast(`Sending side A to ${app}…`);

    let resA: { ok: boolean; hint?: string; error?: string };
    if (app === "gSender") {
      resA = await sendToGsender(getGsenderUrl(), nameA, sideA);
    } else {
      resA = await sendToNcsender(getNcsenderUrl(), nameA, sideA);
    }

    track("gcode_sent_machine", { app, ok: resA.ok, hint: resA.hint, flip: "A" });
    if (!resA.ok) {
      const dl = await confirmDialog({
        title: "Couldn't send side A",
        message: `${resA.error}\n\nDownload the side A + side B files instead?`,
        confirmLabel: "Download files",
        cancelLabel: "Close",
      });
      if (dl) await this.generateFlip();
      return;
    }

    const goB = await confirmDialog({
      title: "Side A loaded",
      message:
        `Side A is loaded in ${app} — press Play there to run it.\n\n` +
        "When it finishes: flip the stock onto the registration pins and re-zero Z on the new top face. " +
        "Then send side B.",
      confirmLabel: "Send side B",
      cancelLabel: "Later",
    });
    if (!goB) {
      toast(`Side B not sent — reopen and Send to ${app} when ready.`);
      return;
    }
    if (!(await this.preflight(sideB))) return;
    toast(`Sending side B to ${app}…`);

    let resB: { ok: boolean; hint?: string; error?: string };
    if (app === "gSender") {
      resB = await sendToGsender(getGsenderUrl(), nameB, sideB);
    } else {
      resB = await sendToNcsender(getNcsenderUrl(), nameB, sideB);
    }

    track("gcode_sent_machine", { app, ok: resB.ok, hint: resB.hint, flip: "B" });
    if (resB.ok) {
      toast(`Side B loaded — press Play in ${app} to run it.`);
      maybeShowSharePrompt();
      return;
    }
    const dl = await confirmDialog({
      title: "Couldn't send side B",
      message: `${resB.error}\n\nDownload the side B file instead?`,
      confirmLabel: "Download file",
      cancelLabel: "Close",
    });
    if (dl) {
      const f = this.download(sideB, nameB);
      toast(`Exported → ${f}`);
    }
  }

  public missingFontText(): TextEntity[] {
    const targeted = new Set(this.doc.operations.flatMap((o) => o.entityIds));
    return this.doc.entities.filter(
      (e): e is TextEntity =>
        e instanceof TextEntity && targeted.has(e.id) && !isFontResolvable(e.fontId),
    );
  }

  public async confirmMissingFonts(): Promise<boolean> {
    const missing = this.missingFontText();
    if (missing.length === 0) return true;
    const list = missing.map((t) => `  • "${t.text}"`).join("\n");
    return confirmDialog({
      title: "Missing fonts",
      message:
        `${missing.length} text item${missing.length > 1 ? "s" : ""} use a font that isn't ` +
        `available and will be OMITTED from the G-code:\n\n${list}\n\nContinue anyway?`,
      confirmLabel: "Continue anyway",
    });
  }

  public projectName(): string {
    const n = this.ctx.getProjectName?.()?.trim();
    return n && n !== "Untitled" ? n : "untitled";
  }

  public exportName(scope: string, ext = "nc"): string {
    return formatExportName({ project: this.projectName(), scope, ext });
  }

  public download(code: string, filename: string): string {
    const blob = new Blob([code], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    return filename;
  }

  private depthSummary(ops: CAMOperation[]): string {
    if (this.doc.isLaser) return "";
    const depths = ops.map((o) => Math.abs(o.depth)).filter((d) => d > 0);
    if (depths.length === 0) return "";
    const du = this.doc.displayUnit;
    const min = Math.min(...depths);
    const max = Math.max(...depths);
    const depth =
      min === max
        ? `${formatLength(max, du)}${du}`
        : `${formatLength(min, du)}–${formatLength(max, du)}${du}`;
    return ` · depth ${depth} into ${formatLength(this.doc.stockThickness, du)}${du} stock`;
  }
}
