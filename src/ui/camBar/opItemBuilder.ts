/**
 * Builds individual operation cards for the toolpaths list in the CAM bar.
 */

import { opFace } from "../../cam/flip";
import { opPatternTargetCount } from "../../cam/patternExpand";
import { shareReliefImage } from "../../cam/reliefOps";
import { formatDuration } from "../../cam/timeEstimate";
import { type CAMOperation, DEFAULTS, resolveOpLaser } from "../../cam/types";
import { formatFeed, formatLength } from "../../core/units";
import type { CADDocument } from "../../model/document";
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
  /** Delete several operations in one history step (a relief job's two passes). */
  onDeleteOps: (ops: CAMOperation[]) => void;
  onExportOp: (op: CAMOperation, index: number) => void;
  onReorderOps: (
    srcIndex: number,
    srcCount: number,
    destIndex: number,
    destCount: number,
    insertBefore: boolean,
  ) => void;
}

export interface OpItemContext extends OpItemCallbacks {
  doc: CADDocument;
  opsList: HTMLElement;
  selectedOpIds: Set<string>;
  highlightedOpId: string | null;
  dragState: { srcIndex: number | null; srcCount: number };
  estimateManager: OpEstimateManager;
}

/**
 * Warn when relief roughing goes deeper than the shallowest matching finish
 * engrave op.
 *
 * The *final* surface is set by the relief FINISH op (an Engrave on the same
 * image). If roughing removes material deeper than the finish op ever cuts, it
 * gouges the part — there is nothing left for the finish pass to clean up.
 * Returns a warning in that case (null when safe, or when there is no finish op
 * to compare against yet).
 */
export function reliefRoughGougeWarning(op: CAMOperation, doc: CADDocument): string | null {
  if (op.type !== "relief-rough") return null;
  const finishDepths = doc.operations
    .filter((o) => o.type === "engrave" && shareReliefImage(op, o, doc))
    .map((o) => Math.abs(o.depth));
  if (finishDepths.length === 0) return null;
  const roughFloor = Math.abs(op.depth) - Math.max(0, op.finishAllowance ?? 0);
  const finishDepth = Math.min(...finishDepths);
  if (roughFloor <= finishDepth + 1e-6) return null;
  return `Roughing clears to ${roughFloor.toFixed(2)} ${doc.displayUnit} but the finish op only reaches ${finishDepth.toFixed(2)} ${doc.displayUnit} — it will gouge below the final surface. Lower this op's depth or raise its finish allowance.`;
}

/** Human name for a tool type — one place, so the list and the group card agree. */
export function toolLabelOf(op: CAMOperation): string {
  return op.toolType === "v-bit"
    ? `V-Bit(${op.vAngle ?? 60}°)`
    : op.toolType === "drill"
      ? "Drill"
      : op.toolType === "ball-nose"
        ? "Ball Nose"
        : op.toolType === "tapered-ball-nose"
          ? "Tapered Ball Nose"
          : "End Mill";
}

export function buildOpItem(op: CAMOperation, index: number, ctx: OpItemContext): HTMLElement {
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
    dragState.srcCount = 1;
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
    onReorderOps(src, dragState.srcCount, index, 1, insertBefore);
  });

  item.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".tp-icon-btn,.tp-drag-handle")) return;
    onHighlightOp(highlightedOpId === op.id ? null : op.id);
  });

  const opColor = TP_PALETTE[index % TP_PALETTE.length];
  item.style.setProperty("--tp-color", opColor);

  // Two-row card: identity on top (checkbox · handle · swatch · badge · name),
  // tool/params summary + actions below. A single row truncated the name to
  // "Pr…" and wrapped the summary one word per line at the default width.
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
              : op.type === "inlay"
                ? "INL"
                : op.type === "relief-rough"
                  ? "RUF"
                  : op.type === "score"
                    ? "SCR"
                    : op.type === "face"
                      ? "FCE"
                      : "DRL";
  topRow.appendChild(badge);

  // Double-sided: mark bottom-face ops so they're distinguishable in the list.
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
  const toolLabel = toolLabelOf(op);

  // Laser ops have no tool/Z — summarise by power/passes/feed instead of the
  // mill's ⌀/depth (which read as a meaningless "⌀0mm … -3mm" for a laser).
  // All lengths/feeds shown in the document's unit and rounded (raw internal
  // mm otherwise leaked as "-19.0499999…mm").
  // Summarise the numbers the machine will actually run: when the op's layer
  // carries a beam recipe, those are the layer's, not the op's own fields.
  const beam = doc.isLaser ? resolveOpLaser(op, doc.layers, doc.entities) : op;
  const beamLayer =
    doc.isLaser && beam !== op ? getBeamLayer(doc, op.entityIds, op.laserOverride) : null;
  const lenU = (mm: number) => formatLength(mm, doc.displayUnit);
  const feedU = (mmPerMin: number) =>
    `${formatFeed(mmPerMin, doc.displayUnit)} ${doc.displayUnit}/min`;

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

  // A laser only cuts/scores/engraves: a milling-only op (pocket/drill/vcarve/
  // chamfer) left in a laser document won't produce a toolpath — flag it here
  // rather than letting it surface only as a "; NOTE:" buried in the G-code.
  if (doc.isLaser && op.type !== "profile" && op.type !== "engrave" && op.type !== "score") {
    params.textContent = "⚠ no laser equivalent — use Cut, Score, or Engrave";
    params.style.color = "var(--warn, #e0a85a)";
    item.title = `"${op.name}" is a ${op.type} operation: it has no laser toolpath and is skipped during G-code export.`;
  }
  info.appendChild(params);

  // Estimated run time
  const cuts = op.type === "face" || (op.regions?.length ?? 0) + (op.entityIds?.length ?? 0) > 0;
  const laserSkips =
    doc.isLaser && op.type !== "profile" && op.type !== "engrave" && op.type !== "score";
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
  // Facing binds to no geometry by design — it skims the blank or the bed — so
  // the "cuts nothing" warning would be wrong on the one op where an empty
  // entity list is correct, and it cuts more than anything else in the job.
  if (op.type !== "face" && nRegions === 0 && nEntities === 0) {
    const warn = document.createElement("div");
    warn.className = "tp-op-params";
    warn.style.color = "var(--warn, #e0a85a)";
    warn.textContent = "⚠ no geometry — cuts nothing";
    warn.title =
      "This toolpath isn't bound to any shape, so it produces no motion and is skipped on export. Select the shape(s) it should cut, then delete and re-add this toolpath (or use Edit).";
    info.appendChild(warn);
    item.classList.add("tp-op-empty");
  } else if (patternN <= 0 || op.followPattern === false) {
    // Non-pattern (or pattern opted-out): the pattern line above already states
    // the cut count for pattern ops.
    const n = nRegions || nEntities;
    const bind = document.createElement("div");
    bind.className = "tp-op-params";
    bind.style.opacity = "0.6";
    // Facing binds to no shape: say what it skims instead of "cuts 0 shape".
    bind.textContent =
      op.type === "face"
        ? `skims the ${op.faceTarget === "bed" ? "spoilboard" : "blank"}`
        : nRegions
          ? `cuts ${n} region${n > 1 ? "s" : ""}`
          : `cuts ${n} shape${n > 1 ? "s" : ""}`;
    bind.title =
      op.type === "face"
        ? "Facing takes its extent from the job, not from geometry."
        : "Click the card to highlight the shapes this toolpath cuts.";
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

  // Actions live at the right of the summary row.
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

const ICON_EDIT =
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">` +
  `<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>` +
  `<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>` +
  `</svg>`;
const ICON_DELETE =
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">` +
  `<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>` +
  `<path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>` +
  `</svg>`;

/**
 * Grouped card for a relief job: one parent "3-D Relief" entry wrapping its
 * roughing and finishing passes as child rows. The parent drags as a single
 * unit (srcCount 2); each child row edits the merged dialog and the roughing
 * row can be deleted on its own (the finish then recomputes in place).
 */
export function buildReliefGroupItem(
  rough: CAMOperation,
  finish: CAMOperation,
  index: number,
  ctx: OpItemContext,
): HTMLElement {
  const {
    doc,
    opsList,
    highlightedOpId,
    dragState,
    estimateManager,
    onHighlightOp,
    onEditOp,
    onDeleteOp,
    onDeleteOps,
    onReorderOps,
  } = ctx;

  const item = document.createElement("div");
  item.className = "tp-op-item tp-op-group";
  item.draggable = true;
  item.style.setProperty("--tp-color", TP_PALETTE[index % TP_PALETTE.length]);

  item.addEventListener("dragstart", (e) => {
    dragState.srcIndex = index;
    dragState.srcCount = 2;
    e.dataTransfer!.effectAllowed = "move";
    item.classList.add("tp-dragging");
  });
  item.addEventListener("dragend", () => {
    dragState.srcIndex = null;
    dragState.srcCount = 1;
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
    onReorderOps(src, dragState.srcCount, index, 2, insertBefore);
  });

  // Header: the whole job, with a single edit and a delete-both.
  const header = document.createElement("div");
  header.className = "tp-op-top";
  const handle = document.createElement("span");
  handle.className = "tp-drag-handle";
  handle.textContent = "⠿";
  handle.title = "Drag to reorder";
  header.appendChild(handle);
  const badge = document.createElement("span");
  badge.className = "tp-badge tp-badge-relief";
  badge.textContent = "3D";
  header.appendChild(badge);
  const nameEl = document.createElement("div");
  nameEl.className = "tp-op-name";
  nameEl.textContent = finish.name;
  nameEl.title = finish.name;
  header.appendChild(nameEl);
  const actions = document.createElement("div");
  actions.className = "tp-op-actions";
  actions.appendChild(iconButton("Edit", ICON_EDIT, () => onEditOp(finish)));
  actions.appendChild(
    iconButton("Delete both passes", ICON_DELETE, () => onDeleteOps([rough, finish])),
  );
  header.appendChild(actions);
  item.appendChild(header);

  item.appendChild(passRow("Roughing", rough, true));
  item.appendChild(passRow("Finishing", finish, false));

  return item;

  function passRow(stage: string, op: CAMOperation, canDelete: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = "tp-op-group-child";
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".tp-icon-btn")) return;
      onHighlightOp(highlightedOpId === op.id ? null : op.id);
    });
    const stageEl = document.createElement("span");
    stageEl.className = "tp-op-group-stage";
    stageEl.textContent = stage;
    row.appendChild(stageEl);
    const tool = document.createElement("span");
    tool.className = "tp-op-group-tool";
    tool.textContent = `T${op.toolNumber} ⌀${formatLength(op.diameter, doc.displayUnit)} ${toolLabelOf(op)}`;
    row.appendChild(tool);
    const est = document.createElement("span");
    est.className = "tp-op-group-est";
    const cached = estimateManager.getCached(op);
    est.textContent = cached !== undefined ? `⏱ ~${formatDuration(cached)}` : "⏱ …";
    est.title = "Estimated run time (constant-feed ballpark; excludes accel/dwell).";
    estimateManager.registerElement(op.id, est);
    row.appendChild(est);
    row.appendChild(iconButton("Edit", ICON_EDIT, () => onEditOp(op)));
    if (canDelete)
      row.appendChild(iconButton("Delete roughing pass", ICON_DELETE, () => onDeleteOp(rough)));
    return row;
  }

  function iconButton(title: string, svg: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "tp-icon-btn";
    btn.title = title;
    btn.innerHTML = svg;
    btn.addEventListener("click", onClick);
    return btn;
  }
}
