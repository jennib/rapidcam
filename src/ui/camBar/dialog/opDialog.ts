/**
 * Toolpath Add/Edit Dialog Orchestrator.
 * Assembles header, name/type controls, tool, cut, laser, tabs, lead, and geometry sections.
 */
import type { CADDocument } from "../../../model/document";
import { RasterImageEntity } from "../../../model/entities";
import type { CAMOperation, CAMOpType } from "../../../cam/types";
import { registerModal } from "../../modal";
import { toast } from "../../toast";
import {
  type OpCombo,
  AUTO_NAME_RE,
  autoName,
  checkOpSelection,
  refsFromSeeds,
} from "../../camBarHelpers";
import { collectClosedLoops } from "../../../cam/loops";
import { OP_TYPE_BY_COMBO, labelFor, opTypesFor } from "../opTypeInfo";
import { opTypeDiagram } from "../opTypeDiagram";
import { regionAtPoint } from "../../../cam/regions";
import { nextId } from "../../../model/ids";
import { type OpState, OpDialogEvents, createInitialOpState } from "./opDialogState";
import { dField, buildDialogShell } from "./dialogDom";
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


export function openOpDialog(options: OpDialogOptions): void {
  const { doc, existing, pushHistory, renderOps, highlightOp } = options;
  document.getElementById("tp-dialog-backdrop")?.remove();
  highlightOp?.(null);

  const isNew = existing === null;
  // A laser document has no spindle/Z: the dialog hides the tool + cut/Z
  // sections and shows a laser section (power/passes/feed) instead, and the
  // op-type list narrows to the two that map to a beam (cut + engrave).
  const isLaser = doc.isLaser;
  const preSelectedEnts = doc.entities.filter((e) => e.selected && !e.isConstruction);

  const state: OpState = createInitialOpState(existing, doc, preSelectedEnts);

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

  // --- backdrop + draggable dialog shell ---
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
  // Nine selects in this dialog share `.unit`, so positional selectors are the
  // only handle e2e had on this one. Named so it survives layout changes.
  typeSelect.dataset.testid = "op-type-select";
  const combos = opTypesFor(isLaser ? "laser" : "mill");
  for (const info of combos) {
    const o = document.createElement("option");
    o.value = info.combo;
    o.textContent = labelFor(info, isLaser ? "laser" : "mill");
    // The blurb the picker shows as a card; here it is the option's tooltip, so
    // the explanation is reachable from the dropdown too rather than only from
    // the route that happens to open the picker.
    o.title = info.pairsWith ? `${info.blurb}\n\nPairs with ${info.pairsWith}` : info.blurb;
    typeSelect.appendChild(o);
  }
  typeSelect.value = state.combo;
  body.appendChild(dField("Type", typeSelect));

  // A caption for the type, because the type is the one field in this dialog you
  // cannot sanity-check by reading it back: every other row is a number you can
  // compare against the part, while this one is a concept you either know or
  // don't. The pairing line is the reason this exists — Relief Roughing leaves a
  // staircase and needs an Engrave pass to become a surface, which used to be
  // written only in a doc comment.
  const typeHint = document.createElement("div");
  typeHint.className = "tp-type-hint";
  // Diagram left, words right. The drawing carries "what does this remove"
  // faster than the sentence does — a pocket next to a profile is one glance.
  const typeArt = document.createElement("div");
  typeArt.className = "tp-type-art";
  const typeText = document.createElement("div");
  const typeBlurb = document.createElement("div");
  const typePairs = document.createElement("div");
  typePairs.className = "tp-type-pairs";
  typeText.append(typeBlurb, typePairs);
  typeHint.append(typeArt, typeText);
  body.appendChild(typeHint);

  const updateTypeHint = (): void => {
    const info = OP_TYPE_BY_COMBO[state.combo];
    typeArt.replaceChildren(opTypeDiagram(state.combo));
    typeBlurb.textContent = info.blurb;
    typePairs.textContent = info.pairsWith ? `Pairs with ${info.pairsWith}` : "";
    typePairs.style.display = info.pairsWith ? "" : "none";
  };
  updateTypeHint();

  // Tool section (collapsible — starts collapsed when editing an existing op).
  // Hidden for a laser (no spindle/Z/tool-library concept); the laser section
  // below carries the feed instead.
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
    // If the name is still an untouched auto-generated default, rename it
    // to match the newly chosen type.
    if (AUTO_NAME_RE.test(state.name.trim())) {
      state.name = autoName(state.combo, doc);
      nameInput.value = state.name;
    }
    updateTypeHint();
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
      // Keep only the selection valid for this op type; a specific message when
      // none are (e.g. an image selected for a Cut → "can only be engraved").
      const check = checkOpSelection(doc.entities, state.entityIds, state.combo);
      if (check.error) {
        // Toast, not alert(): the dialog stays open and keyboard-usable so the
        // refusal can be acted on directly. A native alert() blocks the page —
        // clicks landing during it are swallowed, which reads as a dead button
        // and is what the "Apply hang" turned out to be (see raster engrave).
        toast(check.error);
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
    } else if (state.combo === "face") {
      type = "face";
      side = "inside";
    } else {
      type = "drill";
      side = "outside";
    }

    const isProfile = type === "profile";
    const reliefRough = type === "relief-rough";
    // Image engrave: laser raster OR mill relief — both carry the same raster
    // resolution fields (rasterLineInterval/DotPitch/Invert).
    const imageEngrave = type === "engrave" && opTargetsImage(state.entityIds);
    const raster = isLaser && imageEngrave;
    const rasterFields = imageEngrave;
    // Invert / tone curve apply to both the mill relief FINISH and its roughing.
    const reliefImageFields = imageEngrave || reliefRough;

    const op: CAMOperation = {
      id: existing?.id ?? nextId("cam"),
      name: state.name || autoName(state.combo, doc),
      type,
      side,
      entityIds: ids,
      followPattern: state.followPattern ? undefined : false,
      // Double-sided: persist "bottom" only; "top" is the default, so omit it.
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
      // Dog-bone corner relief applies to female corners (inside pocket, or concave corners on outside profile).
      cornerStyle:
        (state.combo.startsWith("profile") || state.combo === "pocket") &&
        (state.cornerStyle === "dogbone" || state.cornerStyle === "tbone")
          ? state.cornerStyle
          : undefined,
      // Plunge ramp angle override — only for ops that ramp (pocket, relief-rough).
      rampAngle:
        (state.combo === "pocket" || state.combo === "relief-rough") &&
        state.rampAngle !== undefined
          ? state.rampAngle
          : undefined,
      // Cut direction — mill profile contours only (a laser cut has no climb/conventional).
      cutDirection: type === "profile" && !isLaser ? state.cutDirection : undefined,
      // Roughing always leaves an allowance for the finish pass (implicit, no checkbox).
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
      faceTarget: type === "face" ? state.faceTarget : undefined,
      faceOverhang: type === "face" && state.faceOverhang > 0 ? state.faceOverhang : undefined,
      faceDirection: type === "face" ? state.faceDirection : undefined,
      restToolDiameter:
        type === "pocket" && state.restToolDiameter > 0 ? state.restToolDiameter : undefined,
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
      // Overscan serves both vector fill and raster rows.
      laserOverscan:
        isLaser && type === "engrave" && (raster || state.laserFill) && state.laserOverscan > 0
          ? state.laserOverscan
          : undefined,
      airAssist: isLaser && state.airAssist ? true : undefined,
      // A halftone DERIVES its row pitch, so writing this field would leave a
      // number in the file that describes nothing the program does.
      rasterLineInterval:
        rasterFields && !(imageEngrave && state.toolType === "v-bit" && state.halftone)
          ? Math.max(0.001, state.rasterLineInterval)
          : undefined,
      rasterDotPitch: rasterFields && state.rasterDotPitch > 0 ? state.rasterDotPitch : undefined,
      rasterMinPower:
        raster && state.rasterDither === "none" && state.rasterMinPower > 0
          ? state.rasterMinPower
          : undefined,
      // Dithering is laser-only (a mill relief carves graded depth, not 1-bit dots).
      rasterDither: raster && state.rasterDither !== "none" ? state.rasterDither : undefined,
      rasterInvert: reliefImageFields && state.rasterInvert ? true : undefined,
      // Tone curve is a mill-relief control (a laser raster uses min/max power instead).
      reliefGamma:
        !isLaser && reliefImageFields && state.reliefGamma > 0 && state.reliefGamma !== 1
          ? state.reliefGamma
          : undefined,
      // V-carve halftone: the relief FINISH pass only (roughing clears bulk with
      // a flat tool — there is no groove to widen), and only with a V-bit.
      halftone:
        !isLaser && imageEngrave && state.toolType === "v-bit" && state.halftone
          ? true
          : undefined,
      halftoneLand:
        !isLaser && imageEngrave && state.halftone && state.halftoneLand > 0
          ? state.halftoneLand
          : undefined,
      paramExprs:
        Object.keys(state.paramExprs).length > 0
          ? { ...state.paramExprs }
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
  // Synchronously — a deferred focus steals typed input (see ui/modal.ts).
  nameInput.select();
}
