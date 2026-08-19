/**
 * G-code generation, pre-flight linting, file export, and machine sender integration.
 * Extracted from camBar.ts to decouple CAM file/communication orchestration from UI view rendering.
 */

import { track } from "../../analytics";
import { formatExportName, timeStamp } from "../../cam/exportName";
import { generateFlipPrograms, opFace } from "../../cam/flip";
import { type GCodeOptions, generateGCode, generateInlayPrograms } from "../../cam/gcode";
import { generateRotaryProgram } from "../../cam/klein";
import { buildLintContext, lintGCode } from "../../cam/lint";
import type { CAMOperation } from "../../cam/types";
import { selectedOpsInOrder } from "../../cam/types";
import { isFontResolvable } from "../../core/fontManager";
import {
  getArcTolerance,
  getBed,
  getCustomGcode,
  getGsenderUrl,
  getHasToolChanger,
  getMachineHasCoolant,
  getNcsenderUrl,
  getPostFor,
  getRotaryAxisWord,
} from "../../core/prefs";
import { formatLength } from "../../core/units";
import { openInGeditor } from "../../io/geditor";
import { sendToGsender } from "../../io/gsender";
import { sendToNcsender } from "../../io/ncsender";
import { zipStore } from "../../io/zip";
import type { CADDocument } from "../../model/document";
import { stockFootprint } from "../../model/document";
import { TextEntity } from "../../model/entities";
import { openExportPreview } from "../exportPreviewDialog";
import { confirmDialog } from "../modal";
import { type SendTarget, showSenderDialog } from "../senderDialog";
import { maybeShowSharePrompt } from "../sharePrompt";
import { toast } from "../toast";

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
      toast("Add at least one toolpath first.");
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
    if (!isRotary && this.doc.operations.some((op) => op.type === "inlay")) {
      await this.generateInlay();
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
    // The export preview is the confirm-before-you-cut screen: a backplot, the
    // run-time estimate, the job summary, and the pre-flight findings in one place,
    // with Export / Cancel. It replaces the plain pre-flight confirm on this path.
    const name = this.exportName(isRotary ? "all-rotary" : "all");
    const foot = stockFootprint(this.doc);
    // Rounded (not the raw values): a rotary job's wrapped dimension is
    // Math.PI * diameter, an irrational number that otherwise printed its full
    // float precision straight into the confirm-before-you-cut screen.
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
    // An inlay in the selection is two boards — post the pair, not one program.
    if (ops.some((op) => op.type === "inlay")) {
      await this.exportInlayPrograms(ops, `selected-${ops.length}`);
      return;
    }
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
    if (op.type === "inlay") {
      await this.exportInlayPrograms([op], `op${index + 1}-${op.name}`);
      return;
    }
    const code = generateGCode([op], this.doc, this.gcodeOpts());
    if (!(await this.preflight(code))) return;
    // Prefix with the toolpath's 1-based list position so two same-named ops
    // (e.g. several "Pocket"s) get distinct, order-matching filenames.
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
    // Side A may bore the registration pins past the stock bottom by design —
    // allow that depth rather than failing pre-flight on it.
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

  /** Export a v-carve inlay: two boards (pocket + plug) as two files in a zip. */
  public async generateInlay(): Promise<void> {
    await this.exportInlayPrograms(this.doc.operations, "inlay");
  }

  /**
   * Post `ops` (which must include an inlay) as its two boards, pre-flight each,
   * and download the pair as a zip. `scope` names the zip and its two files.
   */
  private async exportInlayPrograms(ops: CAMOperation[], scope: string): Promise<void> {
    const { female, male } = generateInlayPrograms(ops, this.doc, this.gcodeOpts());
    if (!(await this.preflight(female))) return;
    if (!(await this.preflight(male))) return;
    track("gcode_generated", { operation_count: ops.length, inlay: true });
    const project = this.projectName();
    const stamp = timeStamp();
    const zipName = formatExportName({ project, scope, stamp, ext: "zip" });
    this.downloadPair(
      formatExportName({ project, scope: `${scope}-female`, stamp }),
      female,
      formatExportName({ project, scope: `${scope}-male`, stamp }),
      male,
      zipName,
      `Exported inlay pocket + plug → ${zipName}`,
    );
  }

  /** Zip two programs and download the pair as one file. */
  private downloadPair(
    aName: string,
    aData: string,
    bName: string,
    bData: string,
    zipName: string,
    toastMessage: string,
  ): void {
    const bytes = zipStore([
      { name: aName, data: aData },
      { name: bName, data: bData },
    ]);
    const blob = new Blob([bytes as BlobPart], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = zipName;
    a.click();
    URL.revokeObjectURL(url);
    toast(toastMessage);
    maybeShowSharePrompt();
  }

  /** Hand the whole program to a running sender app. */
  public async sendToMachine(): Promise<void> {
    if (this.doc.operations.length === 0) {
      toast("Add at least one toolpath first.");
      return;
    }
    showSenderDialog((selectedApp) => {
      void this.doSendToMachine(selectedApp);
    });
  }

  /**
   * Hand one program to a destination. The two senders POST it to a server on the
   * shop network; GEditor is a browser-window handoff. Same result shape either
   * way, so every caller below stays destination-agnostic.
   */
  private sendProgram(
    app: SendTarget,
    name: string,
    gcode: string,
  ): Promise<{ ok: boolean; error?: string; hint?: string; port?: string }> {
    switch (app) {
      case "gSender":
        return sendToGsender(getGsenderUrl(), name, gcode);
      case "ncSender":
        return sendToNcsender(getNcsenderUrl(), name, gcode);
      case "GEditor":
        return openInGeditor(name, gcode);
    }
  }

  /**
   * "open" / "send" — GEditor is a tab you open, not a machine you send to, and
   * the wording either side of that follows it around the messages below.
   */
  private sendVerb(app: SendTarget): string {
    return app === "GEditor" ? "open" : "send";
  }

  private async doSendToMachine(app: SendTarget): Promise<void> {
    if (!(await this.confirmMissingFonts())) return;
    const isRotary = this.doc.isRotary;
    // A two-sided job can't run as one program — send side A now, side B after
    // the operator flips the stock. (Not for a rotary job.)
    if (!isRotary && this.doc.flip && this.doc.operations.some((op) => opFace(op) === "bottom")) {
      await this.sendFlip(app);
      return;
    }
    if (!isRotary && this.doc.operations.some((op) => op.type === "inlay")) {
      await this.sendInlay(app);
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

    toast(app === "GEditor" ? "Opening GEditor…" : `Sending to ${app}…`);
    // One name for both the send and any fallback download below.
    const jobName = this.exportName(isRotary ? "all-rotary" : "all");

    const res = await this.sendProgram(app, jobName, gcode);

    track("gcode_sent_machine", {
      app,
      ok: res.ok,
      hint: res.hint,
      ...(isRotary ? { rotary: true } : {}),
    });

    if (res.ok) {
      if (app === "GEditor") {
        // No share prompt here: focus has just moved to the editor tab, so a
        // prompt in the tab behind it would only be found by accident.
        toast("Opened in GEditor — review it there, then send it to your machine.");
        return;
      }
      toast(
        res.port
          ? `Loaded into ${app} on ${res.port} — press Play there to run.`
          : `Loaded into ${app} — connect your machine and press Play there.`,
      );
      maybeShowSharePrompt();
      return;
    }

    // Couldn't send — surface why, and offer the file so they're not stuck.
    const download = await confirmDialog({
      title: app === "GEditor" ? "Couldn't open GEditor" : `Couldn't send to ${app}`,
      message: `${res.error}\n\nDownload the G-code file instead?`,
      confirmLabel: "Download file",
      cancelLabel: "Close",
    });
    if (download) {
      const file = this.download(gcode, jobName);
      toast(`Exported → ${file}`);
    }
  }

  private async sendFlip(app: SendTarget): Promise<void> {
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
    // Side A may bore the registration pins past the stock bottom by design —
    // allow that depth rather than failing pre-flight on it.
    if (
      !(await this.preflight(sideA, hasPins ? { extraDepthBelowBottom: flip.pinDepth } : undefined))
    )
      return;

    const project = this.projectName();
    const stamp = timeStamp();
    const nameA = formatExportName({ project, scope: "sideA", stamp });
    const nameB = formatExportName({ project, scope: "sideB", stamp });

    toast(app === "GEditor" ? "Opening side A in GEditor…" : `Sending side A to ${app}…`);

    const resA = await this.sendProgram(app, nameA, sideA);

    track("gcode_sent_machine", { app, ok: resA.ok, hint: resA.hint, flip: "A" });
    if (!resA.ok) {
      const dl = await confirmDialog({
        title: `Couldn't ${this.sendVerb(app)} side A`,
        message: `${resA.error}\n\nDownload the side A + side B files instead?`,
        confirmLabel: "Download files",
        cancelLabel: "Close",
      });
      if (dl) await this.generateFlip();
      return;
    }

    // Side A is away — at a machine the operator runs it and flips the stock
    // before side B; in the editor it's simply the other program to look at.
    const goB = await confirmDialog(
      app === "GEditor"
        ? {
            title: "Side A open in GEditor",
            message:
              "Side A is open in GEditor.\n\n" +
              "Open side B too? It replaces side A in the same editor tab.",
            confirmLabel: "Open side B",
            cancelLabel: "Not now",
          }
        : {
            title: "Side A loaded",
            message:
              `Side A is loaded in ${app} — press Play there to run it.\n\n` +
              "When it finishes: flip the stock onto the registration pins and re-zero Z on the new top face. " +
              "Then send side B.",
            confirmLabel: "Send side B",
            cancelLabel: "Later",
          },
    );
    if (!goB) {
      toast(
        app === "GEditor"
          ? "Side B not opened — Send G-code again when you want it."
          : `Side B not sent — reopen and Send to ${app} when ready.`,
      );
      return;
    }
    if (!(await this.preflight(sideB))) return;
    toast(app === "GEditor" ? "Opening side B in GEditor…" : `Sending side B to ${app}…`);

    const resB = await this.sendProgram(app, nameB, sideB);

    track("gcode_sent_machine", { app, ok: resB.ok, hint: resB.hint, flip: "B" });
    if (resB.ok) {
      if (app === "GEditor") {
        toast("Side B open in GEditor.");
        return;
      }
      toast(`Side B loaded — press Play in ${app} to run it.`);
      maybeShowSharePrompt();
      return;
    }
    const dl = await confirmDialog({
      title: `Couldn't ${this.sendVerb(app)} side B`,
      message: `${resB.error}\n\nDownload the side B file instead?`,
      confirmLabel: "Download file",
      cancelLabel: "Close",
    });
    if (dl) {
      const f = this.download(sideB, nameB);
      toast(`Exported → ${f}`);
    }
  }

  private async sendInlay(app: SendTarget): Promise<void> {
    const { female, male } = generateInlayPrograms(this.doc.operations, this.doc, this.gcodeOpts());
    if (!(await this.preflight(female))) return;
    if (!(await this.preflight(male))) return;

    const project = this.projectName();
    const stamp = timeStamp();
    const nameA = formatExportName({ project, scope: "inlay-female", stamp });
    const nameB = formatExportName({ project, scope: "inlay-male", stamp });

    toast(app === "GEditor" ? "Opening the pocket in GEditor…" : `Sending the pocket to ${app}…`);
    const resA = await this.sendProgram(app, nameA, female);
    track("gcode_sent_machine", { app, ok: resA.ok, hint: resA.hint, inlay: "female" });
    if (!resA.ok) {
      const dl = await confirmDialog({
        title: `Couldn't ${this.sendVerb(app)} the pocket`,
        message: `${resA.error}\n\nDownload the pocket + plug files instead?`,
        confirmLabel: "Download files",
        cancelLabel: "Close",
      });
      if (dl) await this.generateInlay();
      return;
    }

    const goB = await confirmDialog(
      app === "GEditor"
        ? {
            title: "Pocket open in GEditor",
            message:
              "The pocket (board A) is open in GEditor.\n\n" +
              "Open the plug (board B) too? It replaces the pocket in the same editor tab.",
            confirmLabel: "Open plug",
            cancelLabel: "Not now",
          }
        : {
            title: "Pocket sent",
            message:
              `The pocket (board A) is loaded in ${app} — press Play there to run it.\n\n` +
              "When it finishes: mount board B, re-zero Z on the new top face, then send the plug.",
            confirmLabel: "Send plug",
            cancelLabel: "Later",
          },
    );
    if (!goB) {
      toast(
        app === "GEditor"
          ? "Plug not opened — Send G-code again when you want it."
          : `Plug not sent — reopen and Send to ${app} when ready.`,
      );
      return;
    }
    if (!(await this.preflight(male))) return;
    toast(app === "GEditor" ? "Opening the plug in GEditor…" : `Sending the plug to ${app}…`);
    const resB = await this.sendProgram(app, nameB, male);
    track("gcode_sent_machine", { app, ok: resB.ok, hint: resB.hint, inlay: "male" });
    if (resB.ok) {
      if (app === "GEditor") {
        toast("Plug open in GEditor.");
        return;
      }
      toast(`Plug loaded — press Play in ${app} to run it.`);
      maybeShowSharePrompt();
      return;
    }
    const dl = await confirmDialog({
      title: `Couldn't ${this.sendVerb(app)} the plug`,
      message: `${resB.error}\n\nDownload the plug file instead?`,
      confirmLabel: "Download file",
      cancelLabel: "Close",
    });
    if (dl) {
      const f = this.download(male, nameB);
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
