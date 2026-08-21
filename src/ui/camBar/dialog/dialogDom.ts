/**
 * Shared DOM builders, layout helpers, and unit formatting for the Add/Edit Toolpath dialog.
 */
import { builtinContext, type CADDocument, type LayerDef } from "../../../model/document";
import { StorageKeys } from "../../../core/storageKeys";
import { formatLength, formatFeed, toMM } from "../../../core/units";
import { evalExpr } from "../../../core/expr";
import { clampOpParam, varMap } from "../../../model/variables";
import { ContextMenu } from "../../contextMenu";
import { varPickerEntries } from "../../propertiesBar";
import { opLayerId } from "../../../cam/types";

export function dSection(title: string): HTMLElement {
  const sec = document.createElement("div");
  sec.className = "tp-dialog-section";
  const h = document.createElement("div");
  h.className = "tp-dialog-section-title";
  h.textContent = title;
  sec.appendChild(h);
  return sec;
}

export function dField(label: string, control: HTMLElement, help?: string): HTMLElement {
  const g = document.createElement("div");
  g.className = "tp-field";
  const l = document.createElement("label");
  l.textContent = label;
  g.appendChild(l);
  g.appendChild(control);
  if (help) g.title = help;
  return g;
}

export function lenU(mm: number, doc: CADDocument): string {
  const du = doc.displayUnit;
  return `${formatLength(mm, du)}${du}`;
}

export function lenView(mm: number, doc: CADDocument): string {
  return formatLength(mm, doc.displayUnit);
}

export function feedU(mmPerMin: number, doc: CADDocument): string {
  return `${formatFeed(mmPerMin, doc.displayUnit)} ${doc.displayUnit}/min`;
}

export function feedView(mmPerMin: number, doc: CADDocument): string {
  return formatFeed(mmPerMin, doc.displayUnit);
}

export function beamLayer(
  doc: CADDocument,
  entityIds: readonly string[] | undefined,
  overridden: boolean | undefined,
): LayerDef | null {
  if (!doc.isLaser || overridden) return null;
  const id = opLayerId(entityIds, doc.entities);
  if (id === null) return null;
  const layer = doc.layers.find((l) => l.id === id);
  return layer?.laser ? layer : null;
}

export const getBeamLayer = beamLayer;

const fxMenu = new ContextMenu();

export function isPlainNumber(s: string): boolean {
  const trimmed = s.trim();
  if (trimmed === "") return false;
  return Number.isFinite(parseFloat(trimmed)) && !Number.isNaN(Number(trimmed));
}

export function attachVarAutocomplete(
  doc: CADDocument,
  input: HTMLInputElement,
  container: HTMLElement,
): void {
  const names = [...varMap(doc.variables, builtinContext(doc)).keys()];
  if (names.length === 0) return;
  const dl = document.createElement("datalist");
  dl.id = `_camv-${Math.random().toString(36).slice(2)}`;
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    dl.appendChild(opt);
  }
  container.appendChild(dl);
  input.setAttribute("list", dl.id);
}

export interface ParamRowOptions {
  placeholder?: string;
  title?: string;
  onChange?: (v: number) => void;
  onFork?: () => void;
  /** Plain-English definition, shown as a tooltip on the field row. */
  help?: string;
}

export interface ParamRowHandle {
  el: HTMLElement;
  inp: HTMLInputElement;
  badge: HTMLSpanElement;
  setValue: (exprOrVal: string | number) => void;
  updateBadge: () => void;
  syncView: () => void;
}

/**
 * An interactive CAM dialog property row with parametric expression support,
 * variable autocomplete, and dynamic ƒx formula indicator.
 */
export function paramRow(
  doc: CADDocument,
  state: { paramExprs: Record<string, string> },
  paramKey: string,
  label: string,
  get: () => number,
  set: (v: number) => void,
  unitConv?: "len" | "feed",
  opts?: ParamRowOptions,
): ParamRowHandle {
  const inp = document.createElement("input");
  inp.type = "text";
  inp.className = "dim";
  if (opts?.placeholder) inp.placeholder = opts.placeholder;
  if (opts?.title) inp.title = opts.title;

  const toView = (v: number): string =>
    unitConv === "feed" ? feedView(v, doc) : unitConv === "len" ? lenView(v, doc) : String(v);
  const toModel = (v: number) => (unitConv ? toMM(v, doc.displayUnit) : v);

  const badge = document.createElement("span");
  badge.className = "tp-fx-badge";
  badge.style.cssText =
    "cursor:pointer;font-style:italic;padding:0 4px;user-select:none;flex:0 0 auto;";

  const updateBadge = () => {
    const expr = state.paramExprs[paramKey];
    if (expr !== undefined && expr.trim() !== "") {
      const vm = varMap(doc.variables, builtinContext(doc));
      const ev = evalExpr(expr, vm);
      const broken = ev === null || !Number.isFinite(ev);
      badge.textContent = broken ? "⚠" : "ƒx";
      badge.style.color = broken ? "var(--danger,#e05555)" : "var(--accent,#5b9)";
      badge.style.opacity = "0.95";
      badge.title = broken
        ? `Broken formula (unknown variable?): ${expr} — click to unbind`
        : `Driven by formula: ${expr} (click to unbind)`;
    } else {
      badge.textContent = "ƒx";
      badge.style.color = "var(--text-dim,#8b909c)";
      badge.style.opacity = "0.45";
      badge.title = "Click to drive this with a variable or formula (e.g. stock, width/2)";
    }
  };

  const syncView = () => {
    const expr = state.paramExprs[paramKey];
    if (expr !== undefined) {
      inp.value = expr;
    } else {
      inp.value = toView(get());
    }
    updateBadge();
  };

  /**
   * Clamp through the shared CAM param table, so a value typed here lands on the
   * exact number `applyOpParam` would produce for the same field on the next
   * solve — a row and its expression can never disagree.
   */
  const commitNumber = (raw: number) => {
    const num = clampOpParam(paramKey, raw);
    if (num === null) return;
    set(num);
    opts?.onChange?.(num);
  };

  const setValue = (exprOrVal: string | number) => {
    if (typeof exprOrVal === "string" && !isPlainNumber(exprOrVal)) {
      state.paramExprs[paramKey] = exprOrVal.trim();
      const ev = evalExpr(exprOrVal, varMap(doc.variables, builtinContext(doc)));
      // Bare numbers inside a formula are already internal mm (as in variable
      // and dimension formulas), so no display-unit conversion here.
      if (ev !== null) commitNumber(ev);
    } else {
      delete state.paramExprs[paramKey];
      const raw = typeof exprOrVal === "number" ? exprOrVal : toModel(parseFloat(exprOrVal));
      commitNumber(raw);
    }
    syncView();
  };

  badge.addEventListener("click", () => {
    const expr = state.paramExprs[paramKey];
    if (expr !== undefined) {
      delete state.paramExprs[paramKey];
      syncView();
      opts?.onChange?.(get());
    } else {
      const rect = badge.getBoundingClientRect();
      const entries = varPickerEntries(doc.variables, (name) => {
        setValue(name);
        inp.focus();
      });
      fxMenu.show(rect.left, rect.bottom + 2, entries);
    }
  });

  const commit = () => {
    opts?.onFork?.();
    const raw = inp.value.trim();
    if (raw === "") {
      syncView();
      return;
    }
    setValue(raw);
  };

  inp.addEventListener("change", commit);
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      commit();
      inp.blur();
    }
  });

  syncView();

  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;align-items:center;gap:4px;flex:1 1 auto;width:0;";
  wrap.appendChild(inp);
  wrap.appendChild(badge);

  attachVarAutocomplete(doc, inp, wrap);

  const el = dField(label, wrap, opts?.help);
  return { el, inp, badge, setValue, updateBadge, syncView };
}


/** Backdrop + draggable dialog frame (header, close, body). */
/**
 * Schema version for the remembered dialog position. Bump when a change makes
 * previously-saved positions actively wrong rather than merely stale — restoring
 * one then hides the new behaviour behind a localStorage entry the user cannot
 * see. Bumped to 1 when the dialog gained full-window height.
 */
const POS_VERSION = 1;

export function buildDialogShell(
  isNew: boolean,
  onClose: () => void,
): { backdrop: HTMLElement; dialog: HTMLElement; body: HTMLElement } {
  const backdrop = document.createElement("div");
  backdrop.id = "tp-dialog-backdrop";
  backdrop.className = "tp-backdrop";
  backdrop.style.pointerEvents = "none";
  backdrop.style.background = "none";

  const dialog = document.createElement("div");
  dialog.className = "tp-dialog";
  dialog.style.pointerEvents = "auto";
  dialog.addEventListener("click", (e) => e.stopPropagation());
  backdrop.appendChild(dialog);

  // Position: restore the last dragged position; otherwise default to the right
  // side of the screen (just left of the right-hand panel). Once the user drags
  // it, that position is remembered (localStorage) and wins on the next open.
  const DIALOG_W = 380; // matches .tp-dialog width in style.css
  /** Gap kept between the dialog and the window edges. */
  const MARGIN = 12;
  /** Below this the dialog is unusable, so it stops shrinking and overflows instead. */
  const MIN_H = 220;
  const applyPos = (left: number, top: number) => {
    const maxLeft = Math.max(0, window.innerWidth - 100);
    const maxTop = Math.max(0, window.innerHeight - 50);
    const t = Math.max(0, Math.min(top, maxTop));
    dialog.style.position = "absolute";
    dialog.style.margin = "0";
    dialog.style.left = `${Math.max(0, Math.min(left, maxLeft))}px`;
    dialog.style.top = `${t}px`;
    // Height follows the position rather than a fixed fraction of the viewport.
    // A constant `max-height: 82vh` (the CSS fallback) wasted whatever space was
    // left below the dialog, which was most of it once the default top sat under
    // the toolbars — and dragging the dialog upward gained nothing. This way the
    // dialog always fills to the bottom of the window from wherever it sits.
    dialog.style.maxHeight = `${Math.max(MIN_H, window.innerHeight - t - MARGIN)}px`;
  };

  let positioned = false;
  const storedPos = localStorage.getItem(StorageKeys.toolpathDialogPosition);
  if (storedPos) {
    try {
      const { left, top, v } = JSON.parse(storedPos);
      const lVal = parseFloat(left);
      const tVal = parseFloat(top);
      // Positions saved before POS_VERSION are ignored ONCE. They were chosen
      // against a dialog that defaulted below the toolbars and was capped at
      // 82vh, so restoring one reinstates exactly the low, short placement this
      // change exists to remove — and the user has no way to know a stale
      // localStorage entry is why the new default never appears. The next drag
      // saves at the current version and is honoured from then on.
      if (v === POS_VERSION && !Number.isNaN(lVal) && !Number.isNaN(tVal)) {
        applyPos(lVal, tVal);
        positioned = true;
      }
    } catch {
      // Ignore malformed localStorage data
    }
  }
  if (!positioned) {
    const rp = document.getElementById("right-panel")?.getBoundingClientRect();
    const rightEdge = rp ? rp.left : window.innerWidth;
    // Top of the WINDOW, not top of the right panel. Aligning with the panel put
    // the dialog below the constraint and align toolbars and cost it their
    // height for nothing: those bars are empty at this x, so the dialog sat low
    // and short while the space above it went unused. This dialog is the tallest
    // in the app and the one that actually needs the room.
    applyPos(rightEdge - DIALOG_W - 16, MARGIN);
  }

  // Re-clamp on window resize so the dialog can't strand off-screen when the
  // viewport shrinks. Self-removes on the first resize after any close path
  // (the backdrop is gone), so it needs no explicit teardown hook.
  const onResize = () => {
    if (!backdrop.isConnected) {
      window.removeEventListener("resize", onResize);
      return;
    }
    applyPos(parseFloat(dialog.style.left) || 0, parseFloat(dialog.style.top) || 0);
  };
  window.addEventListener("resize", onResize);

  const dheader = document.createElement("div");
  dheader.className = "tp-dialog-header";
  dheader.style.cursor = "move";

  let isDragging = false,
    startX = 0,
    startY = 0,
    startLeft = 0,
    startTop = 0;
  const onMouseMove = (e: MouseEvent) => {
    if (!isDragging) return;
    dialog.style.left = `${startLeft + (e.clientX - startX)}px`;
    dialog.style.top = `${startTop + (e.clientY - startY)}px`;
  };
  const onMouseUp = () => {
    isDragging = false;
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    localStorage.setItem(
      StorageKeys.toolpathDialogPosition,
      JSON.stringify({
        v: POS_VERSION,
        left: dialog.style.left,
        top: dialog.style.top,
      }),
    );
  };
  dheader.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest(".tp-dialog-close")) return;
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = dialog.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    dialog.style.position = "absolute";
    dialog.style.margin = "0";
    dialog.style.left = `${startLeft}px`;
    dialog.style.top = `${startTop}px`;
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });

  const dtitle = document.createElement("h3");
  dtitle.textContent = isNew ? "Add Toolpath" : "Edit Toolpath";
  dtitle.style.userSelect = "none";
  dheader.appendChild(dtitle);
  const closeBtn = document.createElement("button");
  closeBtn.className = "tp-dialog-close";
  closeBtn.innerHTML = "&#x2715;";
  closeBtn.addEventListener("click", () => onClose());
  dheader.appendChild(closeBtn);
  dialog.appendChild(dheader);

  const body = document.createElement("div");
  body.className = "tp-dialog-body";
  dialog.appendChild(body);

  return { backdrop, dialog, body };
}
