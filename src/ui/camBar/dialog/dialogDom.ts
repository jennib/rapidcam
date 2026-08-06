/**
 * Shared DOM builders, layout helpers, and unit formatting for the Add/Edit Toolpath dialog.
 */
import type { CADDocument, LayerDef } from "../../../model/document";
import { StorageKeys } from "../../../core/storageKeys";
import { formatLength, formatFeed, toMM } from "../../../core/units";
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

export function dField(label: string, control: HTMLElement): HTMLElement {
  const g = document.createElement("div");
  g.className = "tp-field";
  const l = document.createElement("label");
  l.textContent = label;
  g.appendChild(l);
  g.appendChild(control);
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

/** Labelled number input that writes through `set` on change. */
export function numRow(
  doc: CADDocument,
  label: string,
  get: () => number,
  set: (v: number) => void,
  unitConv?: "len" | "feed",
): { el: HTMLElement; inp: HTMLInputElement } {
  const inp = document.createElement("input");
  inp.type = "number";
  inp.className = "dim";
  inp.step = "any";
  const du = doc.displayUnit;
  const toView = (v: number): string =>
    unitConv === "feed" ? feedView(v, doc) : unitConv === "len" ? lenView(v, doc) : String(v);
  const toModel = (v: number) => (unitConv ? toMM(v, du) : v);

  inp.value = toView(get());
  inp.addEventListener("change", () => {
    const v = parseFloat(inp.value);
    if (Number.isFinite(v)) set(toModel(v));
  });
  return { el: dField(label, inp), inp };
}

/** Like numRow, but `set` also receives the input so a ToolDef load can repopulate it. */
export function syncableInput(
  doc: CADDocument,
  label: string,
  get: () => number,
  set: (v: number, inp: HTMLInputElement) => void,
  unitConv?: "len" | "feed",
): { el: HTMLElement; inp: HTMLInputElement } {
  const inp = document.createElement("input");
  inp.type = "number";
  inp.className = "dim";
  inp.step = "any";
  const du = doc.displayUnit;
  const toView = (v: number): string =>
    unitConv === "feed" ? feedView(v, doc) : unitConv === "len" ? lenView(v, doc) : String(v);
  const toModel = (v: number) => (unitConv ? toMM(v, du) : v);

  inp.value = toView(get());
  inp.addEventListener("change", () => {
    const v = parseFloat(inp.value);
    if (Number.isFinite(v)) set(toModel(v), inp);
  });
  return { el: dField(label, inp), inp };
}

/** Backdrop + draggable dialog frame (header, close, body). */
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

  const DIALOG_W = 380;
  const applyPos = (left: number, top: number) => {
    const maxLeft = Math.max(0, window.innerWidth - 100);
    const maxTop = Math.max(0, window.innerHeight - 50);
    dialog.style.position = "absolute";
    dialog.style.margin = "0";
    dialog.style.left = `${Math.max(0, Math.min(left, maxLeft))}px`;
    dialog.style.top = `${Math.max(0, Math.min(top, maxTop))}px`;
  };

  let positioned = false;
  const storedPos = localStorage.getItem(StorageKeys.toolpathDialogPosition);
  if (storedPos) {
    try {
      const { left, top } = JSON.parse(storedPos);
      const lVal = parseFloat(left);
      const tVal = parseFloat(top);
      if (!Number.isNaN(lVal) && !Number.isNaN(tVal)) {
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
    applyPos(rightEdge - DIALOG_W - 16, rp ? Math.max(16, rp.top) : 80);
  }

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
