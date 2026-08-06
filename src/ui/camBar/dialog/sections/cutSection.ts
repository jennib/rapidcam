/**
 * Cut / Milling parameters section (depth, stepdown, stepover, peck, v-carve,
 * chamfer, plunge ramp, finishing allowance, coolant, 3D relief).
 */
import type { CADDocument } from "../../../../model/document";
import { RasterImageEntity } from "../../../../model/entities";
import {
  DEFAULTS,
  type ChamferSide,
  type CoolantMode,
} from "../../../../cam/types";
import { toMM, formatLength } from "../../../../core/units";
import { getMachineHasCoolant } from "../../../../core/prefs";
import type { OpState, OpDialogEvents } from "../opDialogState";
import { dSection, dField, lenU, lenView } from "../dialogDom";

export interface CutSectionController {
  root: HTMLElement;
  update: () => void;
  updateReliefEstimate: () => void;
}

export function buildCutSection(
  doc: CADDocument,
  state: OpState,
  events: OpDialogEvents,
): CutSectionController {
  const du = doc.displayUnit;
  const isLaser = doc.isLaser;
  const cutSec = dSection("Cut");

  const depthRow = document.createElement("div");
  depthRow.className = "tp-depth-row";
  const depthInp = document.createElement("input");
  depthInp.type = "number";
  depthInp.className = "dim";
  depthInp.step = "any";
  depthInp.value = lenView(state.depth, doc);
  depthInp.addEventListener("change", () => {
    const v = parseFloat(depthInp.value);
    if (Number.isFinite(v)) {
      state.depth = toMM(v, du);
      events.emitUpdateVBitHint();
      updateReliefEstimate();
    }
  });
  const throughBtn = document.createElement("button");
  throughBtn.className = "cbtn";
  throughBtn.textContent = "⊥ stock";
  throughBtn.title = `Set to stock thickness (${lenU(doc.stockThickness, doc)})`;
  throughBtn.addEventListener("click", () => {
    state.depth = -doc.stockThickness;
    depthInp.value = lenView(state.depth, doc);
    updateReliefEstimate();
  });
  depthRow.appendChild(depthInp);
  depthRow.appendChild(throughBtn);
  cutSec.appendChild(dField(`Depth (${du})`, depthRow));

  // V-bit effective width hint
  const vbitHint = document.createElement("div");
  vbitHint.style.cssText =
    "font-size:11px;color:var(--accent);padding:3px 0 4px 0;display:none;";
  cutSec.appendChild(vbitHint);

  const updateVBitHint = () => {
    if (state.toolType !== "v-bit" || state.combo !== "engrave") {
      vbitHint.style.display = "none";
      return;
    }
    const halfAngle = (state.vAngle / 2) * (Math.PI / 180);
    const width = 2 * Math.abs(state.depth) * Math.tan(halfAngle);
    vbitHint.textContent = `→ effective cut width: ${lenU(width, doc)}`;
    vbitHint.style.display = "block";
  };

  const stepInp = document.createElement("input");
  stepInp.type = "number";
  stepInp.className = "dim";
  stepInp.step = "any";
  stepInp.value = lenView(state.stepdown, doc);
  stepInp.addEventListener("change", () => {
    const v = parseFloat(stepInp.value);
    if (Number.isFinite(v)) state.stepdown = toMM(v, du);
    updateReliefEstimate();
  });
  const stepRow = dField(`Stepdown (${du})`, stepInp);
  cutSec.appendChild(stepRow);

  // Peck depth — drill ops only
  const peckInp = document.createElement("input");
  peckInp.type = "number";
  peckInp.className = "dim";
  peckInp.step = "any";
  peckInp.min = "0";
  peckInp.value = lenView(state.peckDepth, doc);
  peckInp.addEventListener("change", () => {
    const v = parseFloat(peckInp.value);
    state.peckDepth = Number.isFinite(v) && v > 0 ? toMM(v, du) : 0;
  });
  const peckRow = dField(`Peck depth (${du}, 0=off)`, peckInp);
  cutSec.appendChild(peckRow);

  const stepoverInp = document.createElement("input");
  stepoverInp.type = "number";
  stepoverInp.className = "dim";
  stepoverInp.step = "any";
  stepoverInp.min = "0.01";
  stepoverInp.max = "1";
  stepoverInp.value = String(state.stepover);
  stepoverInp.addEventListener("change", () => {
    const v = parseFloat(stepoverInp.value);
    if (Number.isFinite(v)) state.stepover = Math.min(1, Math.max(0.01, v));
  });
  const stepoverRow = dField("Stepover (0–1)", stepoverInp);
  cutSec.appendChild(stepoverRow);

  // V-carve pitch
  const vStepInp = document.createElement("input");
  vStepInp.type = "number";
  vStepInp.className = "dim";
  vStepInp.step = "any";
  vStepInp.min = "0.01";
  vStepInp.value = lenView(state.vStep, doc);
  vStepInp.addEventListener("change", () => {
    const v = parseFloat(vStepInp.value);
    if (Number.isFinite(v) && v > 0) state.vStep = toMM(v, du);
  });
  const vStepRow = dField(`V-carve pitch (${du})`, vStepInp);
  cutSec.appendChild(vStepRow);

  // V-carve hop clearance
  const vHopInp = document.createElement("input");
  vHopInp.type = "number";
  vHopInp.className = "dim";
  vHopInp.step = "any";
  vHopInp.min = "0";
  vHopInp.value = lenView(state.vHopClearance, doc);
  vHopInp.title =
    "0 = retract to safe Z between contours (safe). A positive height hops at that clearance instead — faster, but only safe if nothing (e.g. a hold-down clamp) stands above the stock within the carve.";
  vHopInp.addEventListener("change", () => {
    const v = parseFloat(vHopInp.value);
    if (Number.isFinite(v) && v >= 0) state.vHopClearance = toMM(v, du);
  });
  const vHopRow = dField(`V-carve hop clearance (${du}, 0 = safe Z)`, vHopInp);
  cutSec.appendChild(vHopRow);

  // Relief engrave
  const reliefLineInp = document.createElement("input");
  reliefLineInp.type = "number";
  reliefLineInp.className = "dim";
  reliefLineInp.step = "any";
  reliefLineInp.min = "0.01";
  reliefLineInp.value = lenView(state.rasterLineInterval, doc);
  reliefLineInp.title =
    "Spacing between scan rows (the stepover). Finer = smoother but much longer to cut.";
  reliefLineInp.addEventListener("change", () => {
    const v = parseFloat(reliefLineInp.value);
    if (Number.isFinite(v) && v > 0) state.rasterLineInterval = toMM(v, du);
    updateReliefEstimate();
  });
  const reliefLineRow = dField(`Relief stepover (${du})`, reliefLineInp);
  cutSec.appendChild(reliefLineRow);

  const reliefDotInp = document.createElement("input");
  reliefDotInp.type = "number";
  reliefDotInp.className = "dim";
  reliefDotInp.step = "any";
  reliefDotInp.min = "0";
  reliefDotInp.value = lenView(state.rasterDotPitch, doc);
  reliefDotInp.title = "Horizontal dot pitch. 0 = square dots (use the stepover).";
  reliefDotInp.addEventListener("change", () => {
    const v = parseFloat(reliefDotInp.value);
    if (Number.isFinite(v) && v >= 0) state.rasterDotPitch = toMM(v, du);
  });
  const reliefDotRow = dField(`Relief dot pitch (${du}, 0 = square)`, reliefDotInp);
  cutSec.appendChild(reliefDotRow);

  const reliefInvChk = document.createElement("input");
  reliefInvChk.type = "checkbox";
  reliefInvChk.className = "settings-checkbox";
  reliefInvChk.checked = state.rasterInvert;
  reliefInvChk.addEventListener("change", () => {
    state.rasterInvert = reliefInvChk.checked;
  });
  const reliefInvRow = dField("Invert (carve the light areas)", reliefInvChk);
  cutSec.appendChild(reliefInvRow);

  const reliefGammaInp = document.createElement("input");
  reliefGammaInp.type = "number";
  reliefGammaInp.className = "dim";
  reliefGammaInp.step = "any";
  reliefGammaInp.min = "0.1";
  reliefGammaInp.value = String(state.reliefGamma);
  reliefGammaInp.title =
    "Tone curve: depth ∝ darkness^gamma. 1 = linear. >1 lifts mid-tones (flatter background), <1 deepens them. Photos usually need ~1.5–2.5.";
  reliefGammaInp.addEventListener("change", () => {
    const v = parseFloat(reliefGammaInp.value);
    if (Number.isFinite(v) && v > 0) state.reliefGamma = v;
  });
  const reliefGammaRow = dField("Tone curve (gamma, 1 = linear)", reliefGammaInp);
  cutSec.appendChild(reliefGammaRow);

  const reliefEstRow = document.createElement("div");
  reliefEstRow.className = "props-row";
  const reliefEstSpan = document.createElement("span");
  reliefEstSpan.style.cssText = "opacity:0.7;font-size:11px;";
  reliefEstRow.appendChild(reliefEstSpan);
  cutSec.appendChild(reliefEstRow);

  const updateReliefEstimate = (): void => {
    const ent = [...state.entityIds]
      .map((id) => doc.entities.find((e) => e.id === id))
      .find((e): e is RasterImageEntity => e instanceof RasterImageEntity);
    if (!ent) {
      reliefEstSpan.textContent = "";
      return;
    }
    const maxDepth = Math.abs(state.depth);
    const stepdown = state.stepdown > 0 ? state.stepdown : maxDepth;
    const rough = state.combo === "relief-rough";
    const li = rough
      ? Math.max(0.05, state.stepover * state.diameter)
      : state.rasterLineInterval > 0
        ? state.rasterLineInterval
        : DEFAULTS.rasterLineInterval;
    const cutDepth = rough
      ? Math.max(0, maxDepth - Math.max(0, state.finishAllowance))
      : maxDepth;
    const passes = Math.max(1, Math.ceil(cutDepth / stepdown));
    const rows = ent.heightMM / li;
    const lenMM = rows * ent.widthMM * passes;
    const mins = state.feedrate > 0 ? lenMM / state.feedrate : 0;
    const time =
      mins >= 90 ? `${(mins / 60).toFixed(1)} h` : `${Math.max(1, Math.round(mins))} min`;
    reliefEstSpan.textContent = `≈ ${time} to cut @ ${state.feedrate} mm/min · ${Math.round(rows)} rows × ${passes} pass${passes > 1 ? "es" : ""}`;
  };

  const strategySelect = document.createElement("select");
  strategySelect.className = "unit";
  for (const [v, l] of [
    ["offset", "Adaptive (contour-parallel)"],
    ["raster", "Raster (zig-zag)"],
  ] as const) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = l;
    strategySelect.appendChild(o);
  }
  strategySelect.value = state.pocketStrategy;
  strategySelect.addEventListener("change", () => {
    state.pocketStrategy = strategySelect.value as "offset" | "raster";
  });
  const strategyRow = dField("Clearing", strategySelect);
  cutSec.appendChild(strategyRow);

  const finishChk = document.createElement("input");
  finishChk.type = "checkbox";
  finishChk.className = "settings-checkbox";
  finishChk.checked = state.finishPass;
  const finishRow = dField("Finishing pass", finishChk);
  cutSec.appendChild(finishRow);

  const finishAllowInp = document.createElement("input");
  finishAllowInp.type = "number";
  finishAllowInp.className = "dim";
  finishAllowInp.step = "any";
  finishAllowInp.min = "0";
  finishAllowInp.value = lenView(state.finishAllowance, doc);
  finishAllowInp.addEventListener("change", () => {
    const v = parseFloat(finishAllowInp.value);
    state.finishAllowance = Number.isFinite(v) && v >= 0 ? toMM(v, du) : 0;
  });
  const finishAllowRow = dField(`Finish allowance (${du})`, finishAllowInp);
  cutSec.appendChild(finishAllowRow);

  finishChk.addEventListener("change", () => {
    state.finishPass = finishChk.checked;
    finishAllowRow.style.display = finishChk.checked ? "" : "none";
  });

  const cornerSelect = document.createElement("select");
  cornerSelect.className = "unit";
  for (const [v, l] of [
    ["none", "None (leave fillet)"],
    ["dogbone", "Dog-bone"],
    ["tbone", "T-bone"],
  ] as const) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = l;
    cornerSelect.appendChild(o);
  }
  cornerSelect.value = state.cornerStyle;
  cornerSelect.addEventListener("change", () => {
    state.cornerStyle = cornerSelect.value as "none" | "dogbone" | "tbone";
  });
  const cornerRow = dField("Corner overcut", cornerSelect);
  cutSec.appendChild(cornerRow);

  const dirSelect = document.createElement("select");
  dirSelect.className = "unit";
  for (const [v, l] of [
    ["climb", "Climb"],
    ["conventional", "Conventional"],
  ] as const) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = l;
    dirSelect.appendChild(o);
  }
  dirSelect.value = state.cutDirection;
  dirSelect.addEventListener("change", () => {
    state.cutDirection = dirSelect.value as "climb" | "conventional";
  });
  const dirRow = dField("Cut direction", dirSelect);
  cutSec.appendChild(dirRow);

  const rampInp = document.createElement("input");
  rampInp.type = "number";
  rampInp.className = "dim";
  rampInp.step = "any";
  rampInp.min = "0.5";
  rampInp.max = "45";
  rampInp.value = state.rampAngle !== undefined ? String(state.rampAngle) : "";
  rampInp.placeholder = "auto";
  rampInp.addEventListener("change", () => {
    const v = parseFloat(rampInp.value);
    state.rampAngle =
      rampInp.value.trim() === "" || !Number.isFinite(v)
        ? undefined
        : Math.max(0.5, Math.min(45, v));
    if (state.rampAngle !== undefined) rampInp.value = String(state.rampAngle);
  });
  const rampRow = dField("Plunge ramp angle (°)", rampInp);
  cutSec.appendChild(rampRow);

  const chamWidthInp = document.createElement("input");
  chamWidthInp.type = "number";
  chamWidthInp.className = "dim";
  chamWidthInp.step = "any";
  chamWidthInp.min = "0";
  chamWidthInp.value = lenView(state.chamferWidth, doc);
  const chamHint = document.createElement("div");
  chamHint.className = "cam-vbit-hint";
  const updateChamHint = () => {
    const half = Math.tan(((state.vAngle ?? 60) / 2) * (Math.PI / 180));
    const depth = half > 1e-6 ? state.chamferWidth / half : 0;
    chamHint.textContent = `→ depth ${formatLength(depth, du)} ${du} · face ${(90 - (state.vAngle ?? 60) / 2).toFixed(0)}° from top`;
  };
  chamWidthInp.addEventListener("input", () => {
    const v = parseFloat(chamWidthInp.value);
    if (Number.isFinite(v) && v >= 0) state.chamferWidth = toMM(v, du);
    updateChamHint();
  });
  const chamWidthRow = dField(`Chamfer width (${du})`, chamWidthInp);
  cutSec.appendChild(chamWidthRow);
  cutSec.appendChild(chamHint);

  const chamSideSelect = document.createElement("select");
  chamSideSelect.className = "unit";
  for (const [v, l] of [
    ["on", "On edge (centred)"],
    ["outside", "Outside"],
    ["inside", "Inside"],
  ] as const) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = l;
    chamSideSelect.appendChild(o);
  }
  chamSideSelect.value = state.chamferSide;
  chamSideSelect.addEventListener("change", () => {
    state.chamferSide = chamSideSelect.value as ChamferSide;
  });
  const chamSideRow = dField("Bevel side", chamSideSelect);
  cutSec.appendChild(chamSideRow);

  const sharpenChk = document.createElement("input");
  sharpenChk.type = "checkbox";
  sharpenChk.className = "settings-checkbox";
  sharpenChk.checked = state.sharpenCorners;
  sharpenChk.addEventListener("change", () => {
    state.sharpenCorners = sharpenChk.checked;
  });
  const sharpenRow = dField("Sharpen corners", sharpenChk);
  cutSec.appendChild(sharpenRow);
  updateChamHint();

  events.onUpdateVBitHint(() => {
    updateVBitHint();
    updateChamHint();
  });

  const updateChamferVisibility = () => {
    const show = state.combo === "chamfer";
    chamWidthRow.style.display = show ? "" : "none";
    chamHint.style.display = show ? "" : "none";
    chamSideRow.style.display = show ? "" : "none";
    sharpenRow.style.display = show ? "" : "none";
  };

  if (getMachineHasCoolant()) {
    const coolantSelect = document.createElement("select");
    coolantSelect.className = "unit";
    for (const [v, l] of [
      ["off", "Off"],
      ["mist", "Mist (M7)"],
      ["flood", "Flood (M8)"],
    ] as const) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = l;
      coolantSelect.appendChild(o);
    }
    coolantSelect.value = state.coolant;
    coolantSelect.addEventListener("change", () => {
      state.coolant = coolantSelect.value as CoolantMode;
    });
    cutSec.appendChild(dField("Coolant", coolantSelect));
  }

  if (isLaser) cutSec.style.display = "none";

  const opTargetsImage = (ids: Set<string>): boolean => {
    for (const id of ids) {
      if (doc.entities.find((e) => e.id === id) instanceof RasterImageEntity) return true;
    }
    return false;
  };

  const updateReliefVisibility = (): void => {
    const isFinish = state.combo === "engrave" && opTargetsImage(state.entityIds);
    const isRough = state.combo === "relief-rough";
    for (const r of [reliefLineRow, reliefDotRow]) r.style.display = isFinish ? "" : "none";
    for (const r of [reliefInvRow, reliefGammaRow, reliefEstRow])
      r.style.display = isFinish || isRough ? "" : "none";
    if (isFinish && state.toolType !== "ball-nose" && state.toolType !== "v-bit") {
      events.emitSetToolType("ball-nose");
    }
    if (isFinish || isRough) updateReliefEstimate();
  };

  const update = () => {
    if (isLaser) {
      cutSec.style.display = "none";
      return;
    }
    cutSec.style.display = "";
    stepRow.style.display = state.combo === "drill" || state.combo === "vcarve" ? "none" : "";
    peckRow.style.display = state.combo === "drill" ? "" : "none";
    stepoverRow.style.display =
      state.combo === "pocket" || state.combo === "relief-rough" ? "" : "none";
    strategyRow.style.display = state.combo === "pocket" ? "" : "none";
    vStepRow.style.display = state.combo === "vcarve" ? "" : "none";
    vHopRow.style.display = state.combo === "vcarve" ? "" : "none";

    const showFinish = state.combo.startsWith("profile") || state.combo === "pocket";
    finishRow.style.display = showFinish ? "" : "none";
    finishAllowRow.style.display =
      (showFinish && state.finishPass) || state.combo === "relief-rough" ? "" : "none";
    cornerRow.style.display =
      state.combo === "profile-inside" || state.combo === "pocket" ? "" : "none";
    dirRow.style.display = state.combo.startsWith("profile") && !isLaser ? "" : "none";

    const showRamp = state.combo === "pocket" || state.combo === "relief-rough";
    rampRow.style.display = showRamp ? "" : "none";
    rampInp.placeholder = "auto";

    updateChamferVisibility();
    updateReliefVisibility();

    if ((state.combo === "chamfer" || state.combo === "vcarve") && state.toolType !== "v-bit") {
      events.emitSetToolType("v-bit");
    }
    if (
      state.combo === "relief-rough" &&
      (state.toolType === "ball-nose" || state.toolType === "v-bit")
    ) {
      events.emitSetToolType("end-mill");
    }
    events.emitUpdateVBitHint();
  };

  updateVBitHint();
  update();

  return { root: cutSec, update, updateReliefEstimate };
}
