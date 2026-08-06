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
import { formatLength } from "../../../../core/units";
import { getMachineHasCoolant } from "../../../../core/prefs";
import type { OpState, OpDialogEvents } from "../opDialogState";
import { dSection, dField, lenU, paramRow } from "../dialogDom";

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

  const depthRow = paramRow(
    doc,
    state,
    "depth",
    `Depth (${du})`,
    () => state.depth,
    (v) => {
      state.depth = -Math.abs(v);
      events.emitUpdateVBitHint();
      updateReliefEstimate();
    },
    "len",
    {
      transformValue: (v) => -Math.abs(v),
      onChange: () => {
        events.emitUpdateVBitHint();
        updateReliefEstimate();
      },
    },
  );
  const throughBtn = document.createElement("button");
  throughBtn.className = "cbtn";
  throughBtn.textContent = "⊥ stock";
  throughBtn.title = `Set to stock thickness (${lenU(doc.stockThickness, doc)})`;
  throughBtn.addEventListener("click", () => {
    depthRow.setValue("-stock");
  });
  depthRow.el.querySelector(".tp-fx-badge")?.after(throughBtn);
  cutSec.appendChild(depthRow.el);

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

  const stepRow = paramRow(
    doc,
    state,
    "stepdown",
    `Stepdown (${du})`,
    () => state.stepdown,
    (v) => {
      state.stepdown = Math.max(0.01, v);
      updateReliefEstimate();
    },
    "len",
    {
      min: 0.01,
      onChange: () => updateReliefEstimate(),
    },
  );
  cutSec.appendChild(stepRow.el);

  // Peck depth — drill ops only
  const peckRow = paramRow(
    doc,
    state,
    "peckDepth",
    `Peck depth (${du}, 0=off)`,
    () => state.peckDepth,
    (v) => {
      state.peckDepth = Math.max(0, v);
    },
    "len",
    { min: 0 },
  );
  cutSec.appendChild(peckRow.el);

  const stepoverRow = paramRow(
    doc,
    state,
    "stepover",
    "Stepover (0–1)",
    () => state.stepover,
    (v) => {
      state.stepover = Math.min(1, Math.max(0.01, v));
    },
    undefined,
    { min: 0.01, max: 1 },
  );
  cutSec.appendChild(stepoverRow.el);

  // V-carve pitch
  const vStepRow = paramRow(
    doc,
    state,
    "vStep",
    `V-carve pitch (${du})`,
    () => state.vStep,
    (v) => {
      state.vStep = Math.max(0.01, v);
    },
    "len",
    { min: 0.01 },
  );
  cutSec.appendChild(vStepRow.el);

  // V-carve hop clearance
  const vHopRow = paramRow(
    doc,
    state,
    "vHopClearance",
    `V-carve hop clearance (${du}, 0 = safe Z)`,
    () => state.vHopClearance,
    (v) => {
      state.vHopClearance = Math.max(0, v);
    },
    "len",
    {
      min: 0,
      title:
        "0 = retract to safe Z between contours (safe). A positive height hops at that clearance instead — faster, but only safe if nothing (e.g. a hold-down clamp) stands above the stock within the carve.",
    },
  );
  cutSec.appendChild(vHopRow.el);

  // Relief engrave
  const reliefLineRow = paramRow(
    doc,
    state,
    "rasterLineInterval",
    `Relief stepover (${du})`,
    () => state.rasterLineInterval,
    (v) => {
      state.rasterLineInterval = Math.max(0.01, v);
      updateReliefEstimate();
    },
    "len",
    {
      min: 0.01,
      title:
        "Spacing between scan rows (the stepover). Finer = smoother but much longer to cut.",
      onChange: () => updateReliefEstimate(),
    },
  );
  cutSec.appendChild(reliefLineRow.el);

  const reliefDotRow = paramRow(
    doc,
    state,
    "rasterDotPitch",
    `Relief dot pitch (${du}, 0 = square)`,
    () => state.rasterDotPitch,
    (v) => {
      state.rasterDotPitch = Math.max(0, v);
    },
    "len",
    {
      min: 0,
      title: "Horizontal dot pitch. 0 = square dots (use the stepover).",
    },
  );
  cutSec.appendChild(reliefDotRow.el);

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

  const finishAllowRow = paramRow(
    doc,
    state,
    "finishAllowance",
    `Finish allowance (${du})`,
    () => state.finishAllowance,
    (v) => {
      state.finishAllowance = Math.max(0, v);
    },
    "len",
    { min: 0 },
  );
  cutSec.appendChild(finishAllowRow.el);

  finishChk.addEventListener("change", () => {
    state.finishPass = finishChk.checked;
    finishAllowRow.el.style.display = finishChk.checked ? "" : "none";
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

  const rampRow = paramRow(
    doc,
    state,
    "rampAngle",
    "Plunge ramp angle (°)",
    () => state.rampAngle ?? 0,
    (v) => {
      state.rampAngle = v > 0 ? Math.max(0.5, Math.min(45, v)) : undefined;
    },
    undefined,
    {
      min: 0.5,
      max: 45,
      placeholder: "auto",
    },
  );
  cutSec.appendChild(rampRow.el);

  const chamHint = document.createElement("div");
  chamHint.className = "cam-vbit-hint";
  const updateChamHint = () => {
    const half = Math.tan(((state.vAngle ?? 60) / 2) * (Math.PI / 180));
    const depth = half > 1e-6 ? state.chamferWidth / half : 0;
    chamHint.textContent = `→ depth ${formatLength(depth, du)} ${du} · face ${(90 - (state.vAngle ?? 60) / 2).toFixed(0)}° from top`;
  };
  const chamWidthRow = paramRow(
    doc,
    state,
    "chamferWidth",
    `Chamfer width (${du})`,
    () => state.chamferWidth,
    (v) => {
      state.chamferWidth = Math.max(0, v);
      updateChamHint();
    },
    "len",
    {
      min: 0,
      onChange: () => updateChamHint(),
    },
  );
  cutSec.appendChild(chamWidthRow.el);
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
    chamWidthRow.el.style.display = show ? "" : "none";
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
    for (const r of [reliefLineRow.el, reliefDotRow.el]) r.style.display = isFinish ? "" : "none";
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
    stepRow.el.style.display = state.combo === "drill" || state.combo === "vcarve" ? "none" : "";
    peckRow.el.style.display = state.combo === "drill" ? "" : "none";
    stepoverRow.el.style.display =
      state.combo === "pocket" || state.combo === "relief-rough" ? "" : "none";
    strategyRow.style.display = state.combo === "pocket" ? "" : "none";
    vStepRow.el.style.display = state.combo === "vcarve" ? "" : "none";
    vHopRow.el.style.display = state.combo === "vcarve" ? "" : "none";

    const showFinish = state.combo.startsWith("profile") || state.combo === "pocket";
    finishRow.style.display = showFinish ? "" : "none";
    finishAllowRow.el.style.display =
      (showFinish && state.finishPass) || state.combo === "relief-rough" ? "" : "none";
    cornerRow.style.display =
      state.combo === "profile-inside" || state.combo === "pocket" ? "" : "none";
    dirRow.style.display = state.combo.startsWith("profile") && !isLaser ? "" : "none";

    const showRamp = state.combo === "pocket" || state.combo === "relief-rough";
    rampRow.el.style.display = showRamp ? "" : "none";
    rampRow.inp.placeholder = "auto";

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
