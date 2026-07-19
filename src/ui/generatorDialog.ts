/**
 * Parameter dialog for a parametric generator (see generators/).
 *
 * The generator's parameters aren't known until it runs — they're declared via
 * `s.param(...)` during `build`. So the dialog does a throwaway "probe" run on a
 * bare {@link Sketch} to discover the {@link ParamSpec}s (label, default, range),
 * renders one text field per parameter, then on Apply either inserts a new
 * feature ({@link runGenerator}) or regenerates an existing one in place
 * ({@link regenerateFeature}). Follows the same `.tp-backdrop`/`.tp-dialog` idiom
 * as the array/pattern dialogs.
 *
 * Each field accepts a plain number OR an expression over document variables
 * (and `stock`) — same convention as the pattern dialogs' spacing/count fields.
 * A plain number is stored as a literal; a valid expression is stored on the
 * feature's `paramExprs` (with its resolved value cached as `params`) so the
 * feature auto-regenerates when a referenced variable changes.
 */

import type { CADDocument, FeatureInstance } from "../model/document";
import {
  centreOffset,
  type Generator,
  regenerateFeature,
  runGenerator,
} from "../generators/index";
import { sketchPreviews } from "../generators/preview";
import { type ParamSpec, Sketch, type TextFlattener } from "../generators/sketch";
import type { PreviewShape } from "../view/overlay";
import { varMap } from "../model/variables";
import { evalExpr } from "../core/expr";
import { registerModal } from "./modal";
import { toast } from "./toast";

interface BackdropEl extends HTMLElement {
  close: () => void;
}

/** Host-side advisory warnings for the current parameter values. Conventions:
 *  a generator param named "thickness" is the joint/material thickness; one
 *  named "clearance" is a per-mating-face fit gap. (Dialog-side because these
 *  need document knowledge — stock, machine kind — that the pure Sketch
 *  deliberately never sees.) */
export function dialogWarnings(
  specs: readonly ParamSpec[],
  params: Record<string, number>,
  doc: CADDocument,
): string[] {
  const warnings: string[] = [];

  if (specs.some((s) => s.name === "thickness")) {
    const t = params.thickness;
    if (Math.abs(t - doc.stockThickness) > 1e-3) {
      warnings.push(
        `Material thickness (${t}) ≠ stock thickness (${doc.stockThickness} mm) — joints sized for ${t} mm material won't assemble as cut.`,
      );
    }
  }

  if (doc.machineKind === "laser" && specs.some((s) => s.name === "clearance")) {
    const clearance = params.clearance;
    if (!clearance || clearance <= 0) {
      warnings.push(
        "On a laser, the beam removes ~kerf width from every edge, loosening joints — enable kerf compensation in the post settings for a snug fit.",
      );
    } else {
      warnings.push(
        "Laser kerf already loosens joints by roughly the kerf width; clearance adds to it. Prefer clearance 0 with kerf compensation enabled, or reduce clearance by the kerf.",
      );
    }
  }

  return warnings;
}

export interface GeneratorDialogOptions {
  doc: CADDocument;
  pushHistory: () => void;
  gen: Generator;
  /** Edit this existing feature instead of inserting a new one. */
  editFeatureId?: string;
  /** Runs after a fresh insert commits (fits the view) — not on edit. */
  onInserted?: () => void;
  /**
   * Live ghost preview sink (flipDialog precedent): called with the probe's
   * shapes on open and on every debounced edit, and with null when the dialog
   * closes. When provided, the dialog uses the non-dimming "peek" backdrop and
   * docks to the side so the canvas stays visible behind it.
   */
  onPreview?: (shapes: PreviewShape[] | null) => void;
  /** Passed through to the probe run and to the commit (runGenerator/regenerateFeature)
   *  calls; only matters for a generator that uses `Sketch.textToPath`. */
  flatten?: TextFlattener;
}

/**
 * Open the dialog for `opts.gen`. If `opts.editFeatureId` is given, the dialog
 * edits that existing feature (fields seed from its stored params/exprs, Apply
 * regenerates); otherwise it inserts a new feature.
 */
export function openGeneratorDialog(opts: GeneratorDialogOptions): void {
  const { doc, pushHistory, gen, editFeatureId, onInserted } = opts;
  const editing: FeatureInstance | null = editFeatureId
    ? (doc.features.find((f) => f.id === editFeatureId) ?? null)
    : null;
  const initial: Record<string, number> = editing ? { ...editing.params } : {};

  // Probe run: discover the parameter specs without committing anything.
  const probe = new Sketch({ params: initial, flatten: opts.flatten ?? (() => []) });
  gen.build(probe);
  const specs: ParamSpec[] = probe.params;

  // close() is the single funnel for Cancel, Apply, and Escape — the preview
  // must clear no matter how the dialog goes away, INCLUDING a debounced
  // re-probe still pending when the dialog closes (it would fire after the
  // null and resurrect the ghost).
  let reprobeTimer: number | undefined;
  const backdrop = makeBackdrop(() => {
    window.clearTimeout(reprobeTimer);
    opts.onPreview?.(null);
  });
  if (opts.onPreview) backdrop.classList.add("tp-backdrop--peek");
  const dialog = makeDialog(backdrop, editing ? `Edit ${gen.name}` : gen.name);
  const body = dialog.querySelector(".tp-dialog-body") as HTMLElement;

  const inputs = new Map<string, HTMLInputElement>();
  for (const spec of specs) {
    // Editing always seeds from the stored feature (unchanged). A fresh insert
    // seeds "thickness" from the stock actually in the machine rather than the
    // generator's arbitrary default — it's usually right, and it stops the
    // thickness-vs-stock warning from firing on the untouched default (a
    // warning users would otherwise learn to ignore).
    const seed = editing
      ? (editing.paramExprs?.[spec.name] ?? String(spec.value))
      : spec.name === "thickness"
        ? String(doc.stockThickness)
        : String(spec.value);
    inputs.set(spec.name, addField(body, spec, seed));
  }

  // Advisory generator notes (e.g. the gear's undercut warning). Notes depend
  // on the parameter VALUES, so they re-render from a fresh probe on edit.
  const notesEl = document.createElement("div");
  notesEl.style.cssText =
    "opacity:.7;font-size:11px;margin-top:6px;max-width:260px;white-space:pre-line";
  body.appendChild(notesEl);
  const renderNotes = (notes: string[]): void => {
    notesEl.textContent = notes.map((n) => `ⓘ ${n}`).join("\n");
    notesEl.style.display = notes.length ? "" : "none";
  };

  // Host-side advisory warnings (M2 thickness-vs-stock, M5 laser kerf) — a
  // separate element from notesEl because these need per-line color and
  // notesEl is a single textContent block.
  const warnEl = document.createElement("div");
  warnEl.style.cssText =
    "opacity:.7;font-size:11px;margin-top:6px;max-width:260px;white-space:pre-line;color:#e0a555";
  body.appendChild(warnEl);
  const renderWarnings = (warnings: string[]): void => {
    warnEl.textContent = warnings.map((w) => `⚠ ${w}`).join("\n");
    warnEl.style.display = warnings.length ? "" : "none";
  };

  // Insert only: offer the generator's suggested toolpaths (default on). Edit
  // never re-creates ops — after insert they belong to the user.
  let opsCheck: HTMLInputElement | null = null;
  if (!editing && probe.opSuggestions.length > 0) {
    const row = document.createElement("div");
    row.className = "tp-field";
    const label = document.createElement("label");
    label.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer";
    label.title =
      "Add the generator's suggested CAM operations (profile cuts, pockets) along with the geometry";
    opsCheck = document.createElement("input");
    opsCheck.type = "checkbox";
    opsCheck.checked = true;
    label.appendChild(opsCheck);
    label.appendChild(document.createTextNode("Create toolpaths"));
    row.appendChild(label);
    body.appendChild(row);
  }

  /** Best-effort params from the current field texts (invalid → declared default). */
  const currentParams = (): Record<string, number> => {
    const vm = varMap(doc.variables, doc.stockThickness);
    const out: Record<string, number> = {};
    for (const spec of specs) {
      const text = inputs.get(spec.name)!.value.trim();
      const v = isPlainNumber(text) ? parseFloat(text) : evalExpr(text, vm);
      out[spec.name] = v !== null && Number.isFinite(v) ? v : spec.def;
    }
    return out;
  };

  // Debounced re-probe while typing: refreshes the notes and the live canvas
  // ghost against the values as currently entered. The ghost sits where a
  // commit would place the part: the stored offset when editing, the work-area
  // centring for a fresh insert. (reprobeTimer is declared beside the close
  // funnel above, which cancels it.)
  const reprobe = (): void => {
    const params = currentParams();
    const p = new Sketch({ params, flatten: opts.flatten ?? (() => []) });
    gen.build(p);
    renderNotes(p.notes);
    renderWarnings(dialogWarnings(specs, params, doc));
    if (opts.onPreview) {
      const offset = editing ? (editing.offset ?? { x: 0, y: 0 }) : centreOffset(doc, p.entities);
      opts.onPreview(sketchPreviews(p, offset));
    }
  };
  for (const inp of inputs.values()) {
    inp.addEventListener("input", () => {
      window.clearTimeout(reprobeTimer);
      reprobeTimer = window.setTimeout(reprobe, 150);
    });
  }
  // Initial render on open: notes/warnings must reflect the SEEDED field
  // values (e.g. thickness seeded from stock above), not the probe's raw
  // defaults, so this always runs; the ghost preview itself is still gated
  // on opts.onPreview inside reprobe().
  reprobe();

  const { cancelBtn, applyBtn } = addFooter(dialog, backdrop, editing ? "Update" : "Insert", () => {
    const vm = varMap(doc.variables, doc.stockThickness);
    const params: Record<string, number> = {};
    const paramExprs: Record<string, string> = {};
    for (const spec of specs) {
      const inp = inputs.get(spec.name)!;
      const text = inp.value.trim();
      const val = evalExpr(text, vm);
      if (val === null && !isPlainNumber(text)) {
        flashInvalid(inp);
        inp.focus();
        return false; // stays open, nothing committed
      }
      if (isPlainNumber(text)) {
        params[spec.name] = parseFloat(text);
      } else {
        params[spec.name] = val!;
        paramExprs[spec.name] = text;
      }
    }

    pushHistory();
    if (editing) {
      // A shrink (e.g. gear bore → 0) can strip an op's last entity via
      // pruneReferences — say so instead of leaving a silent no-op toolpath.
      const hadGeometry = new Set(
        doc.operations
          .filter((op) => op.entityIds.length > 0 || (op.regions?.length ?? 0) > 0)
          .map((op) => op.id),
      );
      regenerateFeature(doc, editing.id, params, { flatten: opts.flatten, paramExprs });
      for (const op of doc.operations) {
        if (hadGeometry.has(op.id) && op.entityIds.length === 0 && !(op.regions?.length ?? 0)) {
          toast(`"${op.name}" lost its geometry — reassign or delete it.`);
        }
      }
    } else {
      runGenerator(doc, gen, params, {
        flatten: opts.flatten,
        paramExprs,
        createOps: opsCheck?.checked ?? false,
      });
      onInserted?.();
    }
    return true;
  });

  // Enter submits from any field except when the Cancel button holds focus
  // (Escape is handled globally by the modal manager) — precedent:
  // newProjectDialog.ts.
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && document.activeElement !== cancelBtn) applyBtn.click();
  });

  document.body.appendChild(backdrop);
  const first = inputs.values().next().value;
  if (first) setTimeout(() => first.focus(), 0);
}

// --- validation helpers ------------------------------------------------------

/** Same convention as patternDialogs.ts: a bare numeric literal, not an expression. */
function isPlainNumber(s: string): boolean {
  return Number.isFinite(parseFloat(s.trim())) && Number.isNaN(Number(s.trim())) === false;
}

/** Flash an input's outline red for ~800ms (mirrors dimEditor.ts's flash idiom). */
function flashInvalid(input: HTMLInputElement): void {
  input.style.outline = "2px solid #e05555";
  input.style.outlineOffset = "-1px";
  setTimeout(() => {
    input.style.outline = "";
    input.style.outlineOffset = "";
  }, 800);
}

// --- DOM helpers (mirroring arrayDialogs.ts) -------------------------------

function makeBackdrop(onClose?: () => void): BackdropEl {
  let unregister: () => void = () => {};
  const el = Object.assign(document.createElement("div"), {
    close: () => {
      unregister();
      el.remove();
      onClose?.();
    },
  }) as BackdropEl;
  el.className = "tp-backdrop";
  // Backdrop click-to-close is inert under the --peek variant (pointer-events:
  // none lets clicks reach the canvas instead); Escape and Cancel still close.
  el.addEventListener("click", (e) => {
    if (e.target === el) el.close();
  });
  unregister = registerModal(el, el.close);
  return el;
}

function makeDialog(backdrop: HTMLElement, title: string): HTMLElement {
  const dialog = document.createElement("div");
  dialog.className = "tp-dialog";
  dialog.style.width = "300px";
  dialog.addEventListener("click", (e) => e.stopPropagation());

  const hdr = document.createElement("div");
  hdr.className = "tp-dialog-header";
  const h3 = document.createElement("h3");
  h3.textContent = title;
  hdr.appendChild(h3);
  dialog.appendChild(hdr);

  const bodyEl = document.createElement("div");
  bodyEl.className = "tp-dialog-body";
  dialog.appendChild(bodyEl);

  backdrop.appendChild(dialog);
  return dialog;
}

/** "min 2" / "max 30" / "2–30" (both), or null when the spec has neither bound. */
function rangeHint(spec: ParamSpec): string | null {
  if (spec.min !== undefined && spec.max !== undefined) return `${spec.min}–${spec.max}`;
  if (spec.min !== undefined) return `min ${spec.min}`;
  if (spec.max !== undefined) return `max ${spec.max}`;
  return null;
}

function addField(body: HTMLElement, spec: ParamSpec, seed: string): HTMLInputElement {
  const g = document.createElement("div");
  g.className = "tp-field";
  const l = document.createElement("label");
  l.textContent = spec.label ?? spec.name;
  const inp = document.createElement("input");
  inp.type = "text";
  inp.className = "dim";
  inp.value = seed;
  inp.style.width = "90px";
  g.appendChild(l);
  g.appendChild(inp);
  const hint = rangeHint(spec);
  if (hint) {
    const span = document.createElement("span");
    span.textContent = hint;
    span.style.cssText = "opacity:.6;font-size:11px;margin-left:6px";
    g.appendChild(span);
  }
  body.appendChild(g);
  return inp;
}

function addFooter(
  dialog: HTMLElement,
  backdrop: BackdropEl,
  applyLabel: string,
  onApply: () => boolean,
): { cancelBtn: HTMLButtonElement; applyBtn: HTMLButtonElement } {
  const ftr = document.createElement("div");
  ftr.className = "tp-dialog-footer";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => backdrop.close());

  const applyBtn = document.createElement("button");
  applyBtn.className = "btn tp-apply-btn";
  applyBtn.textContent = applyLabel;
  applyBtn.addEventListener("click", () => {
    if (onApply()) backdrop.close();
  });

  ftr.appendChild(cancelBtn);
  ftr.appendChild(applyBtn);
  dialog.appendChild(ftr);

  return { cancelBtn, applyBtn };
}
