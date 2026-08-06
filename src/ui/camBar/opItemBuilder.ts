/**
 * Builds individual operation cards for the toolpaths list in the CAM bar.
 */
import type { CADDocument } from "../../model/document";
import { opFace } from "../../cam/flip";
import { opPatternTargetCount } from "../../cam/patternExpand";
import { RasterImageEntity } from "../../model/entities";
import { type CAMOperation, resolveOpLaser, DEFAULTS } from "../../cam/types";
import { formatLength, formatFeed } from "../../core/units";
import { formatDuration } from "../../cam/timeEstimate";
import { getBeamLayer } from "./dialog/dialogDom";
import type { OpEstimateManager } from "./opEstimateManager";

export const TP_PALETTE = [
  "#4aa3ff",
  "#f59e42",
  "#4cdc9a",
  "#e05a9f",
  "#b97cf5",
  "#f5e04c",
  "#5ad8e0",
  "#f55a5a",
];

export interface OpItemCallbacks {
  onHighlightOp: (id: string | null) => void;
  onToggleSelectOp: (id: string, selected: boolean) => void;
  onEditOp: (op: CAMOperation) => void;
  onDeleteOp: (op: CAMOperation) => void;
  onExportOp: (op: CAMOperation, index: number) => void;
  onReorderOps: (srcIndex: number, destIndex: number, insertBefore: boolean) => void;
}

export interface OpItemContext extends OpItemCallbacks {
  doc: CADDocument;
  opsList: HTMLElement;
  selectedOpIds: Set<string>;
  highlightedOpId: string | null;
  dragState: { srcIndex: number | null };
  estimateManager: OpEstimateManager;
}

/**
 * Warn when relief roughing goes deeper than the shallowest matching finish engrave op.
 */
export function reliefRoughGougeWarning(op: CAMOperation, doc: CADDocument): string | null {
  if (op.type !== "relief-rough") return null;
  const shared = new Set(op.entityIds);
  const finishDepths = doc.operations
    .filter(
      (o) =>
        o.type === "engrave" &&
        o.entityIds.some((id) => shared.has(id)) &&
        doc.entities.some((e) => e.id && shared.has(e.id) && e instanceof RasterImageEntity),
    )
    .map((o) => Math.abs(o.depth));
  if (finishDepths.length === 0) return null;
  const roughFloor = Math.abs(op.depth) - Math.max(0, op.finishAllowance ?? 0);
  const finishDepth = Math.min(...finishDepths);
  if (roughFloor <= finishDepth + 1e-6) return null;
  return `Roughing clears to ${roughFloor.toFixed(2)} ${doc.displayUnit} but the finish op only reaches ${finishDepth.toFixed(2)} ${doc.displayUnit} — it will gouge below the final surface. Lower this op's depth or raise its finish allowance.`;
}

export function buildOpItem(
  op: CAMOperation,
  index: number,
  ctx: OpItemContext,
): HTMLElement {
  const {
    doc,
    opsList,
    selectedOpIds,
    highlightedOpId,
    dragState,
    estimateManager,
    onHighlightOp,
    onToggleSelectOp,
    onEditOp,
    onDeleteOp,
    onExportOp,
    onReorderOps,
  } = ctx;

  const item = document.createElement("div");
  item.className = "tp-op-item";
  item.draggable = true;

  item.addEventListener("dragstart", (e) => {
    dragState.srcIndex = index;
    e.dataTransfer!.effectAllowed = "move";
    item.classList.add("tp-dragging");
  });
  item.addEventListener("dragend", () => {
    dragState.srcIndex = null;
    item.classList.remove("tp-dragging");
    opsList.querySelectorAll(".tp-drag-over-top,.tp-drag-over-bottom").forEach((el) => {
      el.classList.remove("tp-drag-over-top", "tp-drag-over-bottom");
    });
  });
  item.addEventListener("dragover", (e) => {
    if (dragState.srcIndex === null) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    opsList.querySelectorAll(".tp-drag-over-top,.tp-drag-over-bottom").forEach((el) => {
      el.classList.remove("tp-drag-over-top", "tp-drag-over-bottom");
    });
    const rect = item.getBoundingClientRect();
    item.classList.add(
      e.clientY < rect.top + rect.height / 2 ? "tp-drag-over-top" : "tp-drag-over-bottom",
    );
  });
  item.addEventListener("dragleave", (e) => {
    if (!item.contains(e.relatedTarget as Node))
      item.classList.remove("tp-drag-over-top", "tp-drag-over-bottom");
  });
  item.addEventListener("drop", (e) => {
    e.preventDefault();
    item.classList.remove("tp-drag-over-top", "tp-drag-over-bottom");
    const src = dragState.srcIndex;
    if (src === null || src === index) return;
    const insertBefore =
      e.clientY < item.getBoundingClientRect().top + item.getBoundingClientRect().height / 2;
    onReorderOps(src, index, insertBefore);
  });

  item.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".tp-icon-btn,.tp-drag-handle")) return;
    onHighlightOp(highlightedOpId === op.id ? null : op.id);
  });

  const opColor = TP_PALETTE[index % TP_PALETTE.length];
  item.style.setProperty("--tp-color", opColor);

  const topRow = document.createElement("div");
  topRow.className = "tp-op-top";
  const botRow = document.createElement("div");
  botRow.className = "tp-op-bot";

  const sel = document.createElement("input");
  sel.type = "checkbox";
  sel.className = "tp-select";
  sel.title = "Select for combined export";
  sel.checked = selectedOpIds.has(op.id);
  sel.addEventListener("click", (e) => e.stopPropagation());
  sel.addEventListener("change", () => {
    onToggleSelectOp(op.id, sel.checked);
  });
  topRow.appendChild(sel);

  const handle = document.createElement("span");
  handle.className = "tp-drag-handle";
  handle.textContent = "⠿";
  handle.title = "Drag to reorder";
  topRow.appendChild(handle);

  const swatch = document.createElement("span");
  swatch.className = "tp-color-swatch";
  topRow.appendChild(swatch);

  const badge = document.createElement("span");
  badge.className = `tp-badge tp-badge-${op.type}`;
  badge.textContent =
    op.type === "profile"
      ? op.side === "outside"
        ? "OUT"
        : "IN"
      : op.type === "pocket"
        ? "PKT"
        : op.type === "engrave"
          ? "ENG"
          : op.type === "chamfer"
            ? "CHM"
            : op.type === "vcarve"
              ? "VCV"
              : op.type === "relief-rough"
                ? "RUF"
                : op.type === "score"
                  ? "SCR"
                  : "DRL";
  topRow.appendChild(badge);

  if (doc.flip && opFace(op) === "bottom") {
    const face = document.createElement("span");
    face.className = "tp-badge";
    face.textContent = "▽ B";
    face.title = "Bottom face — cut after the flip, mirrored";
    face.style.cssText = "background:var(--warn, #e0a85a);color:#1a1a1a;";
    topRow.appendChild(face);
  }

  const nameEl = document.createElement("div");
  nameEl.className = "tp-op-name";
  nameEl.textContent = op.name;
  nameEl.title = op.name;
  topRow.appendChild(nameEl);

  const info = document.createElement("div");
  info.className = "tp-op-info";
  const params = document.createElement("div");
  params.className = "tp-op-params";
  const toolLabel =
    op.toolType === "v-bit"
      ? `V-Bit(${op.vAngle ?? 60}°)`
      : op.toolType === "drill"
        ? "Drill"
        : op.toolType === "ball-nose"
          ? "Ball Nose"
          : "End Mill";

  const beam = doc.isLaser
    ? resolveOpLaser(op, doc.layers, doc.entities)
    : op;
  const beamLayer =
    doc.isLaser && beam !== op ? getBeamLayer(doc, op.entityIds, op.laserOverride) : null;
  const lenU = (mm: number) => formatLength(mm, doc.displayUnit);
  const feedU = (mmPerMin: number) => `${formatFeed(mmPerMin, doc.displayUnit)} ${doc.displayUnit}/min`;

  params.textContent = doc.isLaser
    ? `${beam.laserPower ?? DEFAULTS.laserPower}% · ${beam.laserPasses ?? DEFAULTS.laserPasses}× · ${feedU(beam.feedrate)}` +
      (op.laserFill
        ? " · fill"
        : op.type === "profile" && (beam.kerfWidth ?? 0) > 0
          ? ` · kerf ${lenU(beam.kerfWidth ?? 0)}`
          : "") +
      (beamLayer ? ` · ⚡${beamLayer.name}` : "")
    : `T${op.toolNumber} ⌀${lenU(op.diameter)} ${toolLabel}  ${lenU(op.depth)}`;
  if (beamLayer)
    item.title = `Power, speed and passes come from the "${beamLayer.name}" layer. Edit them there to change every toolpath on it, or open this toolpath to give it its own.`;

  if (
    doc.isLaser &&
    op.type !== "profile" &&
    op.type !== "engrave" &&
    op.type !== "score"
  ) {
    params.textContent = "⚠ no laser equivalent — use Cut, Score, or Engrave";
    params.style.color = "var(--warn, #e0a85a)";
    item.title = `"${op.name}" is a ${op.type} operation: it has no laser toolpath and is skipped during G-code export.`;
  }
  info.appendChild(params);

  // Estimated run time
  const cuts = (op.regions?.length ?? 0) + (op.entityIds?.length ?? 0) > 0;
  const laserSkips =
    doc.isLaser &&
    op.type !== "profile" &&
    op.type !== "engrave" &&
    op.type !== "score";
  if (cuts && !laserSkips) {
    const est = document.createElement("div");
    est.className = "tp-op-params tp-op-time";
    est.style.opacity = "0.7";
    const cached = estimateManager.getCached(op);
    est.textContent = cached !== undefined ? `⏱ ~${formatDuration(cached)}` : "⏱ …";
    est.title = "Estimated run time (constant-feed ballpark; excludes accel/dwell).";
    info.appendChild(est);
    estimateManager.registerElement(op.id, est);
  }

  // Gouge warning
  const gouge = reliefRoughGougeWarning(op, doc);
  if (gouge) {
    const warn = document.createElement("div");
    warn.className = "tp-op-params";
    warn.style.color = "var(--warn, #e0a85a)";
    warn.textContent = "⚠ roughing goes below the finish surface";
    warn.title = gouge;
    info.appendChild(warn);
  }

  // Pattern hint
  const patternN = opPatternTargetCount(op, doc);
  if (patternN > 0 && op.followPattern !== false) {
    const follows = document.createElement("div");
    follows.className = "tp-op-params";
    follows.style.opacity = "0.8";
    follows.textContent = `↳ follows pattern · cuts ${patternN}`;
    follows.title = "This toolpath covers the whole pattern and tracks its count as it changes.";
    info.appendChild(follows);
  }

  // Geometry binding
  const nRegions = op.regions?.length ?? 0;
  const nEntities = op.entityIds?.length ?? 0;
  if (nRegions === 0 && nEntities === 0) {
    const warn = document.createElement("div");
    warn.className = "tp-op-params";
    warn.style.color = "var(--warn, #e0a85a)";
    warn.textContent = "⚠ no geometry — cuts nothing";
    warn.title =
      "This toolpath isn't bound to any shape, so it produces no motion and is skipped on export. Select the shape(s) it should cut, then delete and re-add this toolpath (or use Edit).";
    info.appendChild(warn);
    item.classList.add("tp-op-empty");
  } else if (patternN <= 0 || op.followPattern === false) {
    const n = nRegions || nEntities;
    const bind = document.createElement("div");
    bind.className = "tp-op-params";
    bind.style.opacity = "0.6";
    bind.textContent = nRegions
      ? `cuts ${n} region${n > 1 ? "s" : ""}`
      : `cuts ${n} shape${n > 1 ? "s" : ""}`;
    bind.title = "Click the card to highlight the shapes this toolpath cuts.";
    info.appendChild(bind);
  }
  botRow.appendChild(info);

  // Actions
  const dlBtn = document.createElement("button");
  dlBtn.className = "tp-icon-btn";
  dlBtn.title = "Export this toolpath";
  dlBtn.innerHTML =
    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">` +
    `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>` +
    `<polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>` +
    `</svg>`;
  dlBtn.addEventListener("click", () => onExportOp(op, index));

  const editBtn = document.createElement("button");
  editBtn.className = "tp-icon-btn";
  editBtn.title = "Edit";
  editBtn.innerHTML =
    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">` +
    `<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>` +
    `<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>` +
    `</svg>`;
  editBtn.addEventListener("click", () => onEditOp(op));

  const delBtn = document.createElement("button");
  delBtn.className = "tp-icon-btn tp-icon-del";
  delBtn.title = "Delete";
  delBtn.innerHTML =
    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">` +
    `<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>` +
    `<path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>` +
    `</svg>`;
  delBtn.addEventListener("click", () => onDeleteOp(op));

  const actions = document.createElement("div");
  actions.className = "tp-op-actions";
  actions.appendChild(dlBtn);
  actions.appendChild(editBtn);
  actions.appendChild(delBtn);
  botRow.appendChild(actions);

  item.appendChild(topRow);
  item.appendChild(botRow);

  return item;
}
