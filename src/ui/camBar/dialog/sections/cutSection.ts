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
import { halftonePlan } from "../../../../cam/halftone";
import type { ToolShape } from "../../../../cam/toolProfile";
import { FINISH_STEPOVER_BAND, cuspReadout, spacingForCusp } from "../../../../cam/scallop";
import { formatLength, toMM } from "../../../../core/units";
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
  // cut section
  const cutSec = dSection("Cut");

  const depthRow = paramRow(
    doc,
    state,
    "depth",
    `Depth (${du})`,
    () => state.depth,
    (v) => {
      state.depth = v;
      events.emitUpdateVBitHint();
      updateReliefEstimate();
    },
    "len",
    {
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
      state.stepdown = v;
      updateReliefEstimate();
    },
    "len",
    {
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
      state.peckDepth = v;
    },
    "len",
  );
  cutSec.appendChild(peckRow.el);

  const stepoverRow = paramRow(
    doc,
    state,
    "stepover",
    "Stepover (0–1)",
    () => state.stepover,
    (v) => {
      state.stepover = v;
    },
    undefined,
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
      state.vStep = v;
    },
    "len",
  );
  cutSec.appendChild(vStepRow.el);

  // V-carve hop clearance — height (mm above the surface) for rapid hops between
  // contours. 0 = retract to safe Z (safe default); a positive value trades that
  // for speed, and is only safe if no clamp/fixture stands above the stock within
  // the carve. Off unless the user opts in.
  const vHopRow = paramRow(
    doc,
    state,
    "vHopClearance",
    `V-carve hop clearance (${du}, 0 = safe Z)`,
    () => state.vHopClearance,
    (v) => {
      state.vHopClearance = v;
    },
    "len",
    {
      title:
        "0 = retract to safe Z between contours (safe). A positive height hops at that clearance instead — faster, but only safe if nothing (e.g. a hold-down clamp) stands above the stock within the carve.",
    },
  );
  cutSec.appendChild(vHopRow.el);

  // V-carve halftone: screen the photo as parallel V-grooves whose width carries
  // the tone, instead of carving it as a surface. The row pitch stops being a
  // free parameter (it is the bit's widest groove), so the stepover row below is
  // hidden while this is on rather than left sitting there being ignored.
  const halftoneChk = document.createElement("input");
  halftoneChk.type = "checkbox";
  halftoneChk.className = "settings-checkbox";
  halftoneChk.checked = state.halftone;
  halftoneChk.addEventListener("change", () => {
    state.halftone = halftoneChk.checked;
    // The width law here is the V's. Ticking this with a ball-nose loaded would
    // silently mean nothing, so switch the tool the way the relief rows do.
    if (state.halftone && state.toolType !== "v-bit") events.emitSetToolType("v-bit");
    updateReliefVisibility();
  });
  const halftoneRow = dField("V-carve halftone (photo as V-grooves)", halftoneChk);
  halftoneRow.title =
    "Reproduce the image as parallel V-grooves whose WIDTH carries the tone (the PhotoVCarve look), rather than as a carved 2.5-D surface. Row spacing is derived from the bit angle and the cut depth so the darkest grooves just meet.";
  cutSec.appendChild(halftoneRow);

  const halftoneLandRow = paramRow(
    doc,
    state,
    "halftoneLand",
    `Groove land (${du}, 0 = touching)`,
    () => state.halftoneLand,
    (v) => {
      state.halftoneLand = v;
      updateReliefVisibility();
    },
    "len",
    {
      title:
        "Surface left standing between grooves in the BLACKEST area. 0 = the darkest tone is solid. A positive land trades peak blackness for a visible line texture and a shorter cut.",
    },
  );
  cutSec.appendChild(halftoneLandRow.el);

  // The screen this bit + depth actually produces. These numbers are geometry,
  // not preference — no adjustment to the image widens the tonal range — so they
  // belong in front of the user before the cut, not in a G-code comment after it.
  const halftoneInfoRow = document.createElement("div");
  halftoneInfoRow.className = "props-row";
  const halftoneInfoSpan = document.createElement("span");
  halftoneInfoSpan.style.cssText = "opacity:0.7;font-size:11px;";
  halftoneInfoRow.appendChild(halftoneInfoSpan);
  cutSec.appendChild(halftoneInfoRow);

  /**
   * The bit the relief maths must use: the library tool if one is selected, else
   * the inline fields. Shared by the halftone screen and the cusp readout — both
   * are geometry off the same bit, and reading it twice is how they would come
   * to disagree about which one is loaded.
   */
  const reliefBit = (): ToolShape & { vAngle: number; tipDiameter: number } => {
    const t = state.toolId ? doc.tools.find((td) => td.id === state.toolId) : undefined;
    return {
      toolType: t?.toolType ?? state.toolType,
      vAngle: t?.vAngle ?? state.vAngle,
      tipDiameter: t?.tipDiameter ?? state.tipDiameter ?? 0,
      diameter: t?.diameter ?? state.diameter,
    };
  };

  const updateHalftoneInfo = (): void => {
    if (!state.halftone) {
      halftoneInfoSpan.textContent = "";
      return;
    }
    const bit = reliefBit();
    const depth = Math.abs(state.depth);
    const plan = halftonePlan(bit, depth, state.halftoneLand);
    const parts = [
      `${lenU(plan.grooveWidth, doc)} grooves at ${lenU(plan.rowPitch, doc)} rows`,
      `darkest ${Math.round(plan.maxCoverage * 100)}% coverage`,
    ];
    if (plan.minCoverage > 0)
      parts.push(`lightest ${Math.round(plan.minCoverage * 100)}% (flat tip — no highlights)`);
    if (plan.capped) parts.push(`⚠ bit runs out of flute at ${lenU(plan.usableDepth, doc)}`);
    halftoneInfoSpan.textContent = `${bit.vAngle}° bit ${lenU(depth, doc)} deep → ${parts.join(" · ")}`;
  };

  // Relief engrave (a mill Engrave op targeting an image) — carve the image as
  // depth-modulated 2.5-D. Depth (max) + Stepdown above drive the cut; these set
  // the raster resolution. Needs a ball-nose/V-bit (forced below).
  const reliefLineRow = paramRow(
    doc,
    state,
    "rasterLineInterval",
    `Relief stepover (${du})`,
    () => state.rasterLineInterval,
    (v) => {
      state.rasterLineInterval = v;
      updateReliefEstimate();
    },
    "len",
    {
      title:
        "Spacing between scan rows (the stepover). Finer = smoother but much longer to cut.",
      onChange: () => {
        syncCusp();
        updateReliefEstimate();
      },
    },
  );
  cutSec.appendChild(reliefLineRow.el);

  // The stepover, stated as the surface it leaves — and drivable from that end.
  // Nothing new is stored: the two rows are one number read in both directions
  // (`cuspHeight` / `spacingForCusp`), which is how the CAM packages that expose
  // both link them. Asking for a finish is the question a user actually has; a
  // percentage of cutter diameter is an answer to it that changes meaning with
  // every bit.
  const cuspInp = document.createElement("input");
  cuspInp.type = "text";
  cuspInp.className = "dim";
  cuspInp.title =
    "The ridge left standing between adjacent passes. Type a target here and the " +
    "stepover above follows the bit — a cusp is a surface finish, so it means the " +
    "same thing on a ⌀1 as on a ⌀6.";
  // Same flex wrapper every `paramRow` uses, plus an invisible ƒx badge holding
  // its slot — so this input lines up with the ones above and below it. The
  // badge is only a spacer: a cusp is not a stored field, so there is nothing
  // here for a formula to drive, and a live badge would promise otherwise.
  const cuspWrap = document.createElement("div");
  cuspWrap.style.cssText = "display:flex;align-items:center;gap:4px;flex:1 1 auto;width:0;";
  const cuspSpacer = document.createElement("span");
  cuspSpacer.className = "tp-fx-badge";
  cuspSpacer.textContent = "ƒx";
  cuspSpacer.style.cssText = "visibility:hidden;padding:0 4px;flex:0 0 auto;";
  cuspSpacer.setAttribute("aria-hidden", "true");
  cuspWrap.append(cuspInp, cuspSpacer);
  const cuspRow = dField(`Cusp height (${du})`, cuspWrap);
  cutSec.appendChild(cuspRow);

  // Beside the control, not in a tooltip: the percentage of cutter diameter, so
  // Vectric's 8-12% rule of thumb stays available as the sanity check on
  // whatever the calculator produced.
  const cuspNoteRow = document.createElement("div");
  cuspNoteRow.className = "props-row";
  const cuspNoteSpan = document.createElement("span");
  cuspNoteSpan.style.cssText = "opacity:0.7;font-size:11px;";
  cuspNoteRow.appendChild(cuspNoteSpan);
  cutSec.appendChild(cuspNoteRow);

  /**
   * A cusp is two orders of magnitude smaller than the lengths this dialog
   * usually shows, so the standard display precision rounds every useful answer
   * to "0.01" or "0.00" — a field that cannot show its own values. One extra
   * digit past a micron (a ten-thousandth of an inch) is enough to steer by and
   * still stops short of pretending the machine can hold it.
   */
  const cuspView = (mm: number): string =>
    formatLength(mm, doc.displayUnit, doc.displayUnit === "in" ? 5 : 3);

  /** Show the cusp the CURRENT stepover leaves (called after anything moves it). */
  function syncCusp(): void {
    const bit = reliefBit();
    const r = cuspReadout(bit, state.rasterLineInterval);
    const pct = `${(r.fraction * 100).toFixed(0)}% of ⌀${lenU(bit.diameter, doc)}`;
    if (!r.overlapping) {
      // Not a large cusp — no cusp. Adjacent passes never touch, so what stands
      // between them is uncut stock at full height, and printing a number for it
      // would be inventing one.
      cuspInp.value = "";
      cuspInp.placeholder = "passes don't overlap";
      cuspNoteSpan.textContent = `⚠ ${pct} — wider than the bit, so full-height ridges are left uncut. ${lenU(r.suggested, doc)} is the usual finish stepover.`;
      return;
    }
    cuspInp.placeholder = "";
    cuspInp.value = cuspView(r.cusp);
    cuspNoteSpan.textContent = r.inBand
      ? `${pct} — within the 8–12% usual for a 3D finish pass.`
      : `${pct} — the usual 3D finish range is ${FINISH_STEPOVER_BAND[0] * 100}–${FINISH_STEPOVER_BAND[1] * 100}% of ⌀ (${lenU(bit.diameter * FINISH_STEPOVER_BAND[0], doc)}–${lenU(bit.diameter * FINISH_STEPOVER_BAND[1], doc)}).`;
  }

  const commitCusp = (): void => {
    const raw = parseFloat(cuspInp.value.trim());
    if (!Number.isFinite(raw) || raw <= 0) {
      syncCusp();
      return;
    }
    const step = spacingForCusp(reliefBit(), toMM(raw, doc.displayUnit));
    // Through the row rather than around it: `setValue` clamps by the shared CAM
    // param table and drops any formula the stepover was bound to, which is what
    // typing a number into that row would have done.
    if (step > 0) reliefLineRow.setValue(step);
    // Re-read rather than trust the request — the stepover clamps, and a bit
    // finer than the asked-for cusp cannot deliver it.
    syncCusp();
    updateReliefEstimate();
  };
  cuspInp.addEventListener("change", commitCusp);
  cuspInp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      commitCusp();
      cuspInp.blur();
    }
  });

  // Steep/shallow split. Nothing to size — the contour spacing and the 45° split
  // are both derived from the stepover above — so it is one checkbox, and the
  // sentence beside it says what changes rather than naming a strategy.
  const steepChk = document.createElement("input");
  steepChk.type = "checkbox";
  steepChk.className = "settings-checkbox";
  steepChk.checked = state.reliefSteepPass;
  steepChk.addEventListener("change", () => {
    state.reliefSteepPass = steepChk.checked;
  });
  const steepRow = dField("Contour the steep areas", steepChk);
  steepRow.title =
    "A raster stepping across a near-vertical wall leaves ridges spaced by how far " +
    "the wall climbs in one stepover, so the cusp above is not what you get there. " +
    "With this on, anything steeper than 45° is cut by constant-Z contours spaced to " +
    "the same cusp instead, and left out of the raster. Adds cutting time on models " +
    "with walls; does nothing at all on a shallow one.";
  cutSec.appendChild(steepRow);

  const reliefDotRow = paramRow(
    doc,
    state,
    "rasterDotPitch",
    `Relief dot pitch (${du}, 0 = square)`,
    () => state.rasterDotPitch,
    (v) => {
      state.rasterDotPitch = v;
    },
    "len",
    {
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
  // The advice differs by mode and the two point OPPOSITE ways, so the tooltip
  // has to follow the mode rather than state one of them as the rule. A relief
  // shades a shaped surface (mid-tones usually want lifting); a halftone already
  // matches photo tone through the linear-light mapping, so gamma is only a trim
  // — and a groove in pale stock is not black, which shows up as flat DARKS, not
  // flat mid-tones.
  const RELIEF_GAMMA_TIP =
    "Tone curve: depth ∝ darkness^gamma. 1 = linear. >1 lifts mid-tones (flatter background), <1 deepens them. Photos usually need ~1.5–2.5.";
  const HALFTONE_GAMMA_TIP =
    "Tone curve on groove width. Halftone maps tone through linear light, so 1 is the matched setting and this is a trim. Above 1 lightens and opens up the shadows — useful because a groove in pale stock is not black, so the darkest tones compress into each other. Below 1 deepens the mid-tones.";
  reliefGammaInp.title = RELIEF_GAMMA_TIP;
  reliefGammaInp.addEventListener("change", () => {
    const v = parseFloat(reliefGammaInp.value);
    if (Number.isFinite(v) && v > 0) state.reliefGamma = v;
  });
  const reliefGammaRow = dField("Tone curve (gamma, 1 = linear)", reliefGammaInp);
  cutSec.appendChild(reliefGammaRow);

  // Live cut-time estimate — a relief is a long job (often tens of minutes to
  // hours); surface it so a multi-MB, hour-long program isn't a surprise.
  const reliefEstRow = document.createElement("div");
  reliefEstRow.className = "props-row";
  const reliefEstSpan = document.createElement("span");
  reliefEstSpan.style.cssText = "opacity:0.7;font-size:11px;";
  reliefEstRow.appendChild(reliefEstSpan);
  cutSec.appendChild(reliefEstRow);

  const updateReliefEstimate = (): void => {
    // Depth and the bit drive both readouts, and every field that changes either
    // already refreshes the estimate — so piggyback rather than re-hook them all.
    updateHalftoneInfo();
    syncCusp();
    const ent = [...state.entityIds]
      .map((id) => doc.entities.find((e) => e.id === id))
      .find((e): e is RasterImageEntity => e instanceof RasterImageEntity);
    if (!ent) {
      reliefEstSpan.textContent = "";
      return;
    }
    const maxDepth = Math.abs(state.depth);
    const stepdown = state.stepdown > 0 ? state.stepdown : maxDepth;
    // Roughing rasters at the tool's stepover (fraction × diameter) over the
    // depth minus the finish allowance; the finish pass rasters at its line
    // interval over the full depth.
    // A halftone ignores the stepover field — its rows are the bit's groove width
    // — so estimating off that field would report a job several times the real one.
    const li =
      state.halftone && state.toolType === "v-bit"
        ? halftonePlan(reliefBit(), maxDepth, state.halftoneLand).rowPitch
        : state.rasterLineInterval > 0
          ? state.rasterLineInterval
          : DEFAULTS.rasterLineInterval;
    const passes = Math.max(1, Math.ceil(maxDepth / stepdown));
    const rows = ent.heightMM / li;
    const lenMM = rows * ent.widthMM * passes;
    const mins = state.feedrate > 0 ? lenMM / state.feedrate : 0;
    const time =
      mins >= 90 ? `${(mins / 60).toFixed(1)} h` : `${Math.max(1, Math.round(mins))} min`;
    reliefEstSpan.textContent = `≈ ${time} to cut @ ${state.feedrate} mm/min · ${Math.round(rows)} rows × ${passes} pass${passes > 1 ? "es" : ""}`;
  };

  const strategySelect = document.createElement("select");
  strategySelect.className = "unit";
  // "offset" was labelled "Adaptive" and is not: its load follows the shape of
  // the wall. The real one is now a separate choice.
  for (const [v, l] of [
    ["offset", "Offset (contour-parallel)"],
    ["adaptive", "Adaptive (light cuts, longer path)"],
    ["raster", "Raster (zig-zag)"],
  ] as const) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = l;
    strategySelect.appendChild(o);
  }
  strategySelect.value = state.pocketStrategy;
  strategySelect.addEventListener("change", () => {
    state.pocketStrategy = strategySelect.value as "offset" | "adaptive" | "raster";
  });
  const strategyRow = dField("Clearing", strategySelect);
  cutSec.appendChild(strategyRow);

  // --- facing ---------------------------------------------------------------
  const faceTargetSelect = document.createElement("select");
  faceTargetSelect.className = "unit";
  for (const [v, l] of [
    ["stock", "The blank (top of the stock)"],
    ["bed", "The spoilboard — machine must be empty"],
  ] as const) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = l;
    faceTargetSelect.appendChild(o);
  }
  faceTargetSelect.value = state.faceTarget;
  faceTargetSelect.addEventListener("change", () => {
    state.faceTarget = faceTargetSelect.value as "stock" | "bed";
    // Re-run visibility: the spoilboard warning appears and disappears with it.
    update();
  });
  const faceTargetRow = dField("Skim", faceTargetSelect);
  cutSec.appendChild(faceTargetRow);

  // The spoilboard case is a different job, not a different setting: no
  // workpiece on the machine and Z zeroed on the board. Said here, at the
  // moment of choosing, as well as in the program and at pre-flight.
  const faceWarn = document.createElement("div");
  faceWarn.style.cssText =
    "font-size:11px;line-height:1.4;padding:6px 8px;border-radius:4px;" +
    "background:rgba(220,160,60,0.14);border:1px solid rgba(220,160,60,0.5);";
  faceWarn.textContent =
    "Surfacing the spoilboard cuts your wasteboard. Take the workpiece off the machine, " +
    "check no clamp stands in the way, and zero X/Y/Z on the spoilboard itself — not on stock. " +
    "Post it as its own program.";
  cutSec.appendChild(faceWarn);

  const faceDirSelect = document.createElement("select");
  faceDirSelect.className = "unit";
  for (const [v, l] of [
    ["x", "Along X"],
    ["y", "Along Y"],
  ] as const) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = l;
    faceDirSelect.appendChild(o);
  }
  faceDirSelect.value = state.faceDirection;
  faceDirSelect.addEventListener("change", () => {
    state.faceDirection = faceDirSelect.value as "x" | "y";
  });
  const faceDirRow = dField("Rows", faceDirSelect);
  cutSec.appendChild(faceDirRow);

  const faceOverhangRow = paramRow(
    doc,
    state,
    "faceOverhang",
    `Extra overhang (${du})`,
    () => state.faceOverhang,
    (v) => {
      state.faceOverhang = v;
    },
    "len",
  );
  faceOverhangRow.el.title =
    "The cutter already overhangs the edge by its own radius. Add to that when the " +
    "blank's true size is uncertain, or it sits slightly out of square.";
  cutSec.appendChild(faceOverhangRow.el);

  // Rest machining — clear only what a bigger tool left standing. 0 = off, so
  // the field is one number rather than a checkbox plus a number.
  const restRow = paramRow(
    doc,
    state,
    "restToolDiameter",
    `Rest: prev tool ⌀ (${du})`,
    () => state.restToolDiameter,
    (v) => {
      state.restToolDiameter = v;
    },
    "len",
  );
  restRow.el.title =
    "Set to the diameter of the tool that already roughed this, and this operation " +
    "cuts only what that tool could not reach — the corners of a pocket, or the " +
    "narrow valleys of a relief a big cutter cannot drop into. Leave at 0 to clear " +
    "the whole area.";
  cutSec.appendChild(restRow.el);

  // Finishing pass — profile + pocket only. Leaves an allowance during
  // roughing and removes it in a final full-depth wall lap.
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
      state.finishAllowance = v;
    },
    "len",
  );
  cutSec.appendChild(finishAllowRow.el);

  finishChk.addEventListener("change", () => {
    state.finishPass = finishChk.checked;
    finishAllowRow.el.style.display = finishChk.checked ? "" : "none";
  });

  // Corner overcut — female (inside profile / pocket) cuts only. A dog-bone
  // relieves each inside corner so a mating square part seats despite the
  // tool's corner radius. Visibility is toggled in the combo handler below.
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

  // Cut direction — profile contours (mill). Climb vs conventional relative to
  // the M3 spindle; visibility is set in the combo handler below.
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

  // Plunge ramp angle — pocket and relief-rough ramp into the cut instead of
  // plunging straight. Empty = the per-context default (shown as placeholder);
  // visibility + placeholder are set in the combo handler below.
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
      state.chamferWidth = v;
      updateChamHint();
    },
    "len",
    {
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
    // The halftone screen is derived from the SAME bit geometry — angle, tip and
    // diameter — so anything that moves the V-bit hint moves the row pitch, and
    // with it the readout AND the cut-time estimate. Without this, changing the
    // V angle left both showing the previous bit's numbers.
    updateReliefEstimate();
  });

  const updateChamferVisibility = () => {
    const show = state.combo === "chamfer";
    chamWidthRow.el.style.display = show ? "" : "none";
    chamHint.style.display = show ? "" : "none";
    chamSideRow.style.display = show ? "" : "none";
    sharpenRow.style.display = show ? "" : "none";
  };

  // Coolant — per operation, shown only when the machine has coolant (a
  // machine-wide capability). Off/Mist (M7)/Flood (M8).
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

  // Relief rows visible only for a mill Engrave op targeting an image; that op
  // also needs a depth-shaping bit, so force a ball-nose if it's a flat end mill.
  const updateReliefVisibility = (): void => {
    const isFinish =
      (state.combo === "engrave" || state.combo === "relief") && opTargetsImage(state.entityIds);
    // Halftoning is a V-bit trick and only applies to the relief FINISH pass.
    const canHalftone = isFinish && state.toolType === "v-bit";
    const halftoning = canHalftone && state.halftone;
    halftoneRow.style.display = canHalftone ? "" : "none";
    for (const r of [halftoneLandRow.el, halftoneInfoRow])
      r.style.display = halftoning ? "" : "none";
    // The stepover is what a halftone DERIVES; leaving the field on screen while
    // it is ignored is the same lie as a disabled control that looks live. The
    // cusp row is the same number from the other end, so it follows exactly.
    reliefLineRow.el.style.display = isFinish && !halftoning ? "" : "none";
    for (const r of [cuspRow, cuspNoteRow, steepRow])
      r.style.display = isFinish && !halftoning ? "" : "none";
    reliefDotRow.el.style.display = isFinish ? "" : "none";
    // Image controls (invert / tone curve / estimate) belong to the relief finish.
    for (const r of [reliefInvRow, reliefGammaRow, reliefEstRow])
      r.style.display = isFinish ? "" : "none";
    if (isFinish && state.toolType !== "ball-nose" && state.toolType !== "v-bit" && state.toolType !== "tapered-ball-nose") {
      events.emitSetToolType("ball-nose");
    }
    reliefGammaInp.title = halftoning ? HALFTONE_GAMMA_TIP : RELIEF_GAMMA_TIP;
    if (halftoning) updateHalftoneInfo();
    if (isFinish) updateReliefEstimate();
  };

  // The halftone row is gated on a V-bit being loaded, and the tool is chosen in
  // a different section — so without this the option stayed hidden however the
  // user set the tool, and the only way to reach it was not to need it.
  events.onToolTypeChanged(() => updateReliefVisibility());

  const update = () => {
    if (isLaser) {
      cutSec.style.display = "none";
      return;
    }
    cutSec.style.display = "";
    stepRow.el.style.display = state.combo === "drill" || state.combo === "vcarve" ? "none" : "";
    peckRow.el.style.display = state.combo === "drill" ? "" : "none";
    stepoverRow.el.style.display = state.combo === "pocket" ? "" : "none";
    strategyRow.style.display = state.combo === "pocket" ? "" : "none";

    const facing = state.combo === "face";
    faceTargetRow.style.display = facing ? "" : "none";
    faceDirRow.style.display = facing ? "" : "none";
    faceOverhangRow.el.style.display = facing ? "" : "none";
    // Only when the spoilboard is the target — on the blank it would be noise,
    // and a warning shown for everything is read as decoration.
    faceWarn.style.display = facing && state.faceTarget === "bed" ? "" : "none";
    // Rest machining is a clearing idea, so it belongs to the two ops that clear
    // — it was showing on a profile, where it would have been read as a promise
    // and done nothing. The emitter honours it for exactly these two.
    restRow.el.style.display = state.combo === "pocket" ? "" : "none";
    vStepRow.el.style.display = state.combo === "vcarve" ? "" : "none";
    vHopRow.el.style.display = state.combo === "vcarve" ? "" : "none";

    const showFinish = state.combo.startsWith("profile") || state.combo === "pocket";
    finishRow.style.display = showFinish ? "" : "none";
    finishAllowRow.el.style.display = showFinish && state.finishPass ? "" : "none";
    // Corner overcut is a female-feature relief — inside profiles and pockets only.
    cornerRow.style.display =
      state.combo === "profile-inside" || state.combo === "pocket" ? "" : "none";
    // Cut direction — mill profile contours only (a laser beam has no climb/conventional).
    dirRow.style.display = state.combo.startsWith("profile") && !isLaser ? "" : "none";

    // Plunge ramp angle — ops that ramp into the cut (pocket; a relief's ramp
    // lives on its roughing stage).
    const showRamp = state.combo === "pocket";
    rampRow.el.style.display = showRamp ? "" : "none";
    rampRow.inp.placeholder = "auto";

    updateChamferVisibility();
    updateReliefVisibility();

    // Chamfer and v-carve both need a V-bit (the cut angle comes from the tool).
    if ((state.combo === "chamfer" || state.combo === "vcarve") && state.toolType !== "v-bit") {
      events.emitSetToolType("v-bit");
    }
    events.emitUpdateVBitHint();
  };

  updateVBitHint();
  update();

  return { root: cutSec, update, updateReliefEstimate };
}
