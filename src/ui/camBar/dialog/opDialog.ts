/**
 * Toolpath Add/Edit Dialog Orchestrator.
 * Assembles header, name/type controls, tool, cut, laser, tabs, lead, and geometry sections.
 */
import type { CADDocument } from "../../../model/document";
import { RasterImageEntity } from "../../../model/entities";
import {
  type CAMOperation,
  type CAMOpType,
  type ToolType,
  type ChamferSide,
  type CoolantMode,
  type LeadType,
  DEFAULTS,
} from "../../../cam/types";
import { StorageKeys } from "../../../core/storageKeys";
import { registerModal } from "../../modal";
import {
  type OpCombo,
  AUTO_NAME_RE,
  comboOf,
  defaultCombo,
  autoName,
  checkOpSelection,
  legacyPocketSeeds,
  refsFromSeeds,
  seedsFromRegions,
} from "../../camBarHelpers";
import { collectClosedLoops } from "../../../cam/loops";
import { regionAtPoint } from "../../../cam/regions";
import { nextId } from "../../../model/ids";
import type { Vec2 } from "../../../core/vec2";
import { type OpState, OpDialogEvents } from "./opDialogState";
import { dField } from "./dialogDom";
import { buildToolSection } from "./sections/toolSection";
import { buildCutSection } from "./sections/cutSection";
import { buildLaserSection } from "./sections/laserSection";
import { buildTabsSection } from "./sections/tabsSection";
import { buildLeadSection } from "./sections/leadSection";
import { buildGeometrySection } from "./sections/geometrySection";

export interface OpDialogOptions {
  doc: CADDocument;
  existing: CAMOperation | null;
  pushHistory?: () => void;
  renderOps?: () => void;
  highlightOp?: (op: CAMOperation | null) => void;
}

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

export function openOpDialog(options: OpDialogOptions): void {
  const { doc, existing, pushHistory, renderOps, highlightOp } = options;
  document.getElementById("tp-dialog-backdrop")?.remove();
  highlightOp?.(null);

  const isNew = existing === null;
  const isLaser = doc.isLaser;
  const preSelectedEnts = doc.entities.filter((e) => e.selected && !e.isConstruction);
  const preSelected = new Set(preSelectedEnts.map((e) => e.id));

  const initialCombo: OpCombo = defaultCombo(existing, preSelectedEnts, isLaser);
  const state: OpState = {
    name: existing?.name ?? autoName(initialCombo, doc),
    combo: initialCombo,
    toolId: existing?.toolId,
    toolType: (existing?.toolType ??
      (!isLaser &&
      initialCombo === "engrave" &&
      preSelectedEnts.some((e) => e instanceof RasterImageEntity)
        ? "ball-nose"
        : DEFAULTS.toolType)) as ToolType,
    toolNumber: existing?.toolNumber ?? DEFAULTS.toolNumber,
    diameter: existing?.diameter ?? DEFAULTS.diameter,
    vAngle: existing?.vAngle ?? DEFAULTS.vAngle,
    tipAngle: existing?.tipAngle ?? DEFAULTS.tipAngle,
    feedrate: existing?.feedrate ?? DEFAULTS.feedrate,
    plungeRate: existing?.plungeRate ?? DEFAULTS.plungeRate,
    spindleSpeed: existing?.spindleSpeed ?? DEFAULTS.spindleSpeed,
    safeZ: existing?.safeZ ?? DEFAULTS.safeZ,
    depth: existing?.depth ?? DEFAULTS.depth,
    stepdown: existing?.stepdown ?? DEFAULTS.stepdown,
    peckDepth: existing?.peckDepth ?? DEFAULTS.peckDepth,
    pocketBoundaryMode: (existing?.regions?.length ? "regions" : "entities") as
      | "regions"
      | "entities",
    finishPass: existing?.finishPass ?? false,
    finishAllowance: existing?.finishAllowance ?? DEFAULTS.finishAllowance,
    chamferWidth: existing?.chamferWidth ?? DEFAULTS.chamferWidth,
    chamferSide: (existing?.chamferSide ?? DEFAULTS.chamferSide) as ChamferSide,
    sharpenCorners: existing?.sharpenCorners ?? false,
    vStep: existing?.vStep ?? DEFAULTS.vStep,
    vHopClearance: existing?.vHopClearance ?? 0,
    coolant: (existing?.coolant ?? DEFAULTS.coolant) as CoolantMode,
    entityIds: new Set<string>(existing?.entityIds ?? [...preSelected]),
    islandIds: new Set<string>(existing?.islandIds ?? []),
    followPattern: existing?.followPattern ?? true,
    face: (existing?.face === "bottom" ? "bottom" : "top") as "top" | "bottom",
    regionSeeds: existing?.regions?.length
      ? seedsFromRegions(doc, existing.regions)
      : existing && comboOf(existing) === "pocket"
        ? legacyPocketSeeds(existing, doc)
        : ([] as Vec2[]),
    tabsEnabled: existing?.tabs?.enabled ?? false,
    tabStrategy: (existing?.tabs?.strategy ?? "count") as "count" | "spacing",
    tabCount: existing?.tabs?.count ?? 4,
    tabSpacing: existing?.tabs?.spacing ?? 40,
    tabWidth: existing?.tabs?.width ?? 4,
    tabHeight: existing?.tabs?.height ?? 2,
    stepover: existing?.stepover ?? DEFAULTS.stepover,
    cornerStyle: existing?.cornerStyle ?? "none",
    cutDirection:
      existing?.cutDirection ?? (existing?.side === "outside" ? "conventional" : "climb"),
    rampAngle: existing?.rampAngle,
    pocketStrategy: (existing?.pocketStrategy ?? "offset") as "offset" | "raster",
    leadInType: (existing?.leadIn?.type ?? "none") as LeadType,
    leadInLen: existing?.leadIn?.length ?? 2,
    leadOutType: (existing?.leadOut?.type ?? "none") as LeadType,
    leadOutLen: existing?.leadOut?.length ?? 2,
    laserPower: existing?.laserPower ?? (initialCombo === "score" ? 15 : DEFAULTS.laserPower),
    laserPasses: existing?.laserPasses ?? DEFAULTS.laserPasses,
    kerfWidth: existing?.kerfWidth ?? DEFAULTS.kerfWidth,
    laserFill: existing?.laserFill ?? false,
    laserFillSpacing: existing?.laserFillSpacing ?? DEFAULTS.laserFillSpacing,
    laserOverscan: existing?.laserOverscan ?? DEFAULTS.laserOverscan,
    airAssist: existing?.airAssist ?? false,
    laserOverride: existing?.laserOverride ?? false,
    rasterLineInterval:
      existing?.rasterLineInterval ??
      (isLaser
        ? DEFAULTS.rasterLineInterval
        : Math.max(0.05, (existing?.diameter ?? DEFAULTS.diameter) * 0.1)),
    rasterDotPitch: existing?.rasterDotPitch ?? 0,
    rasterMinPower: existing?.rasterMinPower ?? DEFAULTS.rasterMinPower,
    rasterInvert: existing?.rasterInvert ?? false,
    rasterDither: existing?.rasterDither ?? "none",
    reliefGamma: existing?.reliefGamma ?? 1,
  };

  const events = new OpDialogEvents();
  let geomCleanup: () => void = () => {};
  let unregisterModal: () => void = () => {};

  const closeDialog = () => {
    geomCleanup();
    doc.regionPickHandler = null;
    doc.regionHoverHandler = null;
    doc.regionPickFills = null;
    doc.regionPickHoverFill = null;
    doc.toolpathHighlightIds = null;
    doc.emitChange();
    unregisterModal();
    document.getElementById("tp-dialog-backdrop")?.remove();
  };

  const { backdrop, dialog, body } = buildDialogShell(isNew, closeDialog);
  unregisterModal = registerModal(backdrop, closeDialog);

  // Name
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "dim tp-name-input";
  nameInput.value = state.name;
  nameInput.addEventListener("input", () => {
    state.name = nameInput.value;
  });
  body.appendChild(dField("Name", nameInput));

  // Type
  const typeSelect = document.createElement("select");
  typeSelect.className = "unit";
  typeSelect.dataset.testid = "op-type-select";
  const combos: [OpCombo, string][] = isLaser
    ? [
        ["profile-outside", "Cut (outside)"],
        ["profile-inside", "Cut (inside)"],
        ["score", "Score / Fold (low power)"],
        ["engrave", "Engrave (centreline)"],
      ]
    : [
        ["profile-outside", "Profile (outside)"],
        ["profile-inside", "Profile (inside)"],
        ["pocket", "Pocket (interior clear)"],
        ["chamfer", "Chamfer (V-bevel edge)"],
        ["vcarve", "V-Carve (text/shape)"],
        ["engrave", "Engrave"],
        ["relief-rough", "Relief Roughing (image)"],
        ["drill", "Drill"],
      ];
  for (const [v, l] of combos) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = l;
    typeSelect.appendChild(o);
  }
  typeSelect.value = state.combo;
  body.appendChild(dField("Type", typeSelect));

  // Tool Section
  const toolSec = buildToolSection(doc, state, events, isNew);
  if (isLaser) toolSec.style.display = "none";
  body.appendChild(toolSec);

  // Cut Section
  const cut = buildCutSection(doc, state, events);
  body.appendChild(cut.root);

  // Laser Section
  const laser = buildLaserSection(doc, state, events);
  if (!isLaser) laser.root.style.display = "none";
  body.appendChild(laser.root);

  // Tabs Section
  const tabs = buildTabsSection(doc, state);
  if (isLaser) tabs.root.style.display = "none";
  body.appendChild(tabs.root);

  // Lead Section
  const lead = buildLeadSection(doc, state);
  if (isLaser) lead.root.style.display = "none";
  body.appendChild(lead.root);

  // Geometry Section
  const geom = buildGeometrySection(doc, state, events);
  body.appendChild(geom.root);
  const { renderEntities, startPickMode, stopPickMode, getPickActive } = geom;
  geomCleanup = geom.cleanup;

  // Follow pattern
  const touchesPattern = [...state.entityIds].some((id) =>
    doc.patterns.some((p) => p.sourceIds.includes(id) || p.instanceIds.flat().includes(id)),
  );
  if (touchesPattern) {
    const followChk = document.createElement("input");
    followChk.type = "checkbox";
    followChk.className = "settings-checkbox";
    followChk.checked = state.followPattern;
    followChk.addEventListener("change", () => {
      state.followPattern = followChk.checked;
    });
    body.appendChild(dField("Follow pattern (cut all copies)", followChk));
  }

  // Face (Two-sided)
  if (doc.flip && !isLaser) {
    const faceSel = document.createElement("select");
    for (const [v, label] of [
      ["top", "Top (side A — as drawn)"],
      ["bottom", "Bottom (side B — mirrored)"],
    ] as const) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = label;
      if (v === state.face) o.selected = true;
      faceSel.appendChild(o);
    }
    faceSel.addEventListener("change", () => {
      state.face = faceSel.value as "top" | "bottom";
    });
    body.appendChild(dField("Face (two-sided)", faceSel));
  }

  const updateAllSections = () => {
    cut.update();
    if (isLaser) laser.update();
    if (!isLaser) {
      tabs.update();
      lead.update();
    }
    geom.updateModeVisibility();
  };

  typeSelect.addEventListener("change", () => {
    state.combo = typeSelect.value as OpCombo;
    if (AUTO_NAME_RE.test(state.name.trim())) {
      state.name = autoName(state.combo, doc);
      nameInput.value = state.name;
    }
    if (getPickActive()) stopPickMode();
    updateAllSections();
    if (state.combo === "pocket") {
      startPickMode();
    }
    renderEntities();
  });

  updateAllSections();
  if (state.combo === "pocket") {
    startPickMode();
  }
  renderEntities();

  const opTargetsImage = (ids: Set<string>): boolean => {
    for (const id of ids) {
      if (doc.entities.find((e) => e.id === id) instanceof RasterImageEntity) return true;
    }
    return false;
  };

  // Footer
  const footer = document.createElement("div");
  footer.className = "tp-dialog-footer";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => closeDialog());

  const applyBtn = document.createElement("button");
  applyBtn.className = "btn tp-apply-btn";
  applyBtn.textContent = "Apply";
  applyBtn.addEventListener("click", () => {
    let ids = [...state.entityIds];

    const regionBased =
      (state.combo === "pocket" || state.combo === "vcarve") &&
      state.pocketBoundaryMode === "regions";
    if (regionBased) {
      const loops = collectClosedLoops(doc.entities);
      const hl = new Set<string>();
      for (const seed of state.regionSeeds) {
        const region = regionAtPoint(seed, loops);
        if (region) for (const id of region.loopIds) hl.add(id);
      }
      ids = [...hl];
    } else {
      const check = checkOpSelection(doc.entities, state.entityIds, state.combo);
      if (check.error) {
        alert(check.error);
        return;
      }
      ids = check.validIds;
    }

    pushHistory?.();

    let type: CAMOpType, side: "outside" | "inside";
    if (state.combo === "profile-outside") {
      type = "profile";
      side = "outside";
    } else if (state.combo === "profile-inside") {
      type = "profile";
      side = "inside";
    } else if (state.combo === "pocket") {
      type = "pocket";
      side = "outside";
    } else if (state.combo === "chamfer") {
      type = "chamfer";
      side = "outside";
    } else if (state.combo === "vcarve") {
      type = "vcarve";
      side = "outside";
    } else if (state.combo === "engrave") {
      type = "engrave";
      side = "outside";
    } else if (state.combo === "score") {
      type = "score";
      side = "outside";
    } else if (state.combo === "relief-rough") {
      type = "relief-rough";
      side = "outside";
    } else {
      type = "drill";
      side = "outside";
    }

    const isProfile = type === "profile";
    const reliefRough = type === "relief-rough";
    const imageEngrave = type === "engrave" && opTargetsImage(state.entityIds);
    const raster = isLaser && imageEngrave;
    const rasterFields = imageEngrave;
    const reliefImageFields = imageEngrave || reliefRough;

    const op: CAMOperation = {
      id: existing?.id ?? nextId("cam"),
      name: state.name || autoName(state.combo, doc),
      type,
      side,
      entityIds: ids,
      followPattern: state.followPattern ? undefined : false,
      face: doc.flip && state.face === "bottom" ? "bottom" : undefined,
      toolId: state.toolId,
      toolType: state.toolType,
      toolNumber: state.toolNumber,
      diameter: state.diameter,
      vAngle: state.toolType === "v-bit" ? state.vAngle : undefined,
      tipAngle: state.toolType === "drill" ? state.tipAngle : undefined,
      feedrate: state.feedrate,
      plungeRate: state.plungeRate,
      spindleSpeed: state.spindleSpeed,
      safeZ: state.safeZ,
      depth: state.depth,
      stepdown: state.stepdown,
      stepover: state.stepover,
      peckDepth: type === "drill" && state.peckDepth > 0 ? state.peckDepth : undefined,
      finishPass:
        (type === "profile" || type === "pocket") && state.finishPass ? true : undefined,
      cornerStyle:
        (state.combo.startsWith("profile") || state.combo === "pocket") &&
        (state.cornerStyle === "dogbone" || state.cornerStyle === "tbone")
          ? state.cornerStyle
          : undefined,
      rampAngle:
        (state.combo === "pocket" || state.combo === "relief-rough") &&
        state.rampAngle !== undefined
          ? state.rampAngle
          : undefined,
      cutDirection: type === "profile" && !isLaser ? state.cutDirection : undefined,
      finishAllowance:
        ((type === "profile" || type === "pocket") && state.finishPass) || reliefRough
          ? state.finishAllowance
          : undefined,
      chamferWidth: type === "chamfer" ? state.chamferWidth : undefined,
      chamferSide: type === "chamfer" ? state.chamferSide : undefined,
      sharpenCorners: type === "chamfer" && state.sharpenCorners ? true : undefined,
      vStep: type === "vcarve" ? state.vStep : undefined,
      vHopClearance:
        type === "vcarve" && state.vHopClearance > 0 ? state.vHopClearance : undefined,
      coolant: state.coolant !== "off" ? state.coolant : undefined,
      pocketStrategy: type === "pocket" ? state.pocketStrategy : undefined,
      regions: regionBased ? refsFromSeeds(doc, state.regionSeeds) : undefined,
      tabs: isProfile
        ? {
            enabled: state.tabsEnabled,
            strategy: state.tabStrategy !== "count" ? state.tabStrategy : undefined,
            count: state.tabCount,
            spacing: state.tabStrategy === "spacing" ? state.tabSpacing : undefined,
            width: state.tabWidth,
            height: state.tabHeight,
          }
        : undefined,
      leadIn:
        isProfile && state.leadInType !== "none"
          ? { type: state.leadInType, length: state.leadInLen }
          : undefined,
      leadOut:
        isProfile && state.leadOutType !== "none"
          ? { type: state.leadOutType, length: state.leadOutLen }
          : undefined,
      laserPower: isLaser ? state.laserPower : undefined,
      laserPasses: isLaser ? state.laserPasses : undefined,
      laserOverride: isLaser && state.laserOverride ? true : undefined,
      kerfWidth: isLaser && isProfile ? state.kerfWidth : undefined,
      laserFill: isLaser && type === "engrave" && !raster && state.laserFill ? true : undefined,
      laserFillSpacing:
        isLaser && type === "engrave" && !raster && state.laserFill
          ? state.laserFillSpacing
          : undefined,
      laserOverscan:
        isLaser && type === "engrave" && (raster || state.laserFill) && state.laserOverscan > 0
          ? state.laserOverscan
          : undefined,
      airAssist: isLaser && state.airAssist ? true : undefined,
      rasterLineInterval: rasterFields ? Math.max(0.001, state.rasterLineInterval) : undefined,
      rasterDotPitch: rasterFields && state.rasterDotPitch > 0 ? state.rasterDotPitch : undefined,
      rasterMinPower:
        raster && state.rasterDither === "none" && state.rasterMinPower > 0
          ? state.rasterMinPower
          : undefined,
      rasterDither: raster && state.rasterDither !== "none" ? state.rasterDither : undefined,
      rasterInvert: reliefImageFields && state.rasterInvert ? true : undefined,
      reliefGamma:
        !isLaser && reliefImageFields && state.reliefGamma > 0 && state.reliefGamma !== 1
          ? state.reliefGamma
          : undefined,
    };

    if (existing) {
      const idx = doc.operations.findIndex((o) => o.id === existing.id);
      if (idx >= 0) doc.operations[idx] = op;
    } else {
      doc.operations.push(op);
    }
    doc.emitChange();
    renderOps?.();
    closeDialog();
  });

  footer.appendChild(cancelBtn);
  footer.appendChild(applyBtn);
  dialog.appendChild(footer);

  document.body.appendChild(backdrop);
  nameInput.select();
}
