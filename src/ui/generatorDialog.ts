/**
 * Parameter dialog for a parametric generator (see generators/).
 *
 * The generator's parameters aren't known until it runs — they're declared via
 * `s.param(...)` during `build`. So the dialog does a throwaway "probe" run on a
 * bare {@link Sketch} to discover the {@link ParamSpec}s (label, default, range),
 * renders one number field per parameter, then on Apply either inserts a new
 * feature ({@link runGenerator}) or regenerates an existing one in place
 * ({@link regenerateFeature}). Follows the same `.tp-backdrop`/`.tp-dialog` idiom
 * as the array/pattern dialogs.
 */

import type { CADDocument } from "../model/document";
import {
  type Generator,
  regenerateFeature,
  runGenerator,
} from "../generators/index";
import { type ParamSpec, Sketch } from "../generators/sketch";
import { registerModal } from "./modal";

interface BackdropEl extends HTMLElement {
  close: () => void;
}

/**
 * Open the dialog for `gen`. If `editFeatureId` is given, the dialog edits that
 * existing feature (fields seed from its stored params, Apply regenerates);
 * otherwise it inserts a new feature. `onInserted` runs after a fresh insert
 * commits (used to fit the view onto the new geometry) — not on edit, so
 * tweaking a parameter doesn't re-zoom under the user.
 */
export function openGeneratorDialog(
  doc: CADDocument,
  pushHistory: () => void,
  gen: Generator,
  editFeatureId?: string,
  onInserted?: () => void,
): void {
  const editing = editFeatureId
    ? (doc.features.find((f) => f.id === editFeatureId) ?? null)
    : null;
  const initial: Record<string, number> = editing ? { ...editing.params } : {};

  // Probe run: discover the parameter specs without committing anything.
  const probe = new Sketch({ params: initial });
  gen.build(probe);
  const specs: ParamSpec[] = probe.params;

  const backdrop = makeBackdrop();
  const dialog = makeDialog(backdrop, editing ? `Edit ${gen.name}` : gen.name);
  const body = dialog.querySelector(".tp-dialog-body") as HTMLElement;

  const inputs = new Map<string, HTMLInputElement>();
  for (const spec of specs) {
    inputs.set(spec.name, addField(body, spec));
  }

  addFooter(dialog, backdrop, editing ? "Update" : "Insert", () => {
    const params: Record<string, number> = {};
    for (const spec of specs) {
      const raw = parseFloat(inputs.get(spec.name)!.value);
      params[spec.name] = Number.isFinite(raw) ? raw : spec.def;
    }
    pushHistory();
    if (editing) {
      regenerateFeature(doc, editing.id, params);
    } else {
      runGenerator(doc, gen, params);
      onInserted?.();
    }
  });

  document.body.appendChild(backdrop);
  const first = inputs.values().next().value;
  if (first) setTimeout(() => first.focus(), 0);
}

// --- DOM helpers (mirroring arrayDialogs.ts) -------------------------------

function makeBackdrop(): BackdropEl {
  let unregister: () => void = () => {};
  const el = Object.assign(document.createElement("div"), {
    close: () => {
      unregister();
      el.remove();
    },
  }) as BackdropEl;
  el.className = "tp-backdrop";
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

function addField(body: HTMLElement, spec: ParamSpec): HTMLInputElement {
  const g = document.createElement("div");
  g.className = "tp-field";
  const l = document.createElement("label");
  l.textContent = spec.label ?? spec.name;
  const inp = document.createElement("input");
  inp.type = "number";
  inp.className = "dim";
  inp.value = String(spec.value);
  inp.step = "any";
  if (spec.min !== undefined) inp.min = String(spec.min);
  if (spec.max !== undefined) inp.max = String(spec.max);
  inp.style.width = "90px";
  g.appendChild(l);
  g.appendChild(inp);
  body.appendChild(g);
  return inp;
}

function addFooter(
  dialog: HTMLElement,
  backdrop: BackdropEl,
  applyLabel: string,
  onApply: () => void,
): void {
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
    onApply();
    backdrop.close();
  });

  ftr.appendChild(cancelBtn);
  ftr.appendChild(applyBtn);
  dialog.appendChild(ftr);
}
