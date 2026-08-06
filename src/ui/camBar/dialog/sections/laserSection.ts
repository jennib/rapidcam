/**
 * Laser section: power, feed, passes, kerf, layer recipe link/fork, vector fill,
 * raster engraving parameters, live dither swatch, and material presets.
 */
import type { CADDocument } from "../../../../model/document";
import { RasterImageEntity } from "../../../../model/entities";
import {
  type DitherMode,
  DITHER_MODES,
  DITHER_LABELS,
  ditherRampRGBA,
} from "../../../../cam/dither";
import {
  type LaserPreset,
  type LaserPresetKind,
  presetsFor,
  addPreset,
  newPresetId,
} from "../../../../cam/laserPresets";
import type { OpState, OpDialogEvents } from "../opDialogState";
import {
  dSection,
  dField,
  numRow,
  lenView,
  feedView,
  feedU,
  beamLayer,
} from "../dialogDom";

export function buildLaserSection(
  doc: CADDocument,
  state: OpState,
  events: OpDialogEvents,
): { root: HTMLElement; update: () => void } {
  const sec = dSection("Laser");

  const feed = numRow(
    doc,
    `Feed (${doc.displayUnit}/min)`,
    () => state.feedrate,
    (v) => {
      state.feedrate = Math.max(1, v);
    },
    "feed",
  );
  const power = numRow(
    doc,
    "Power (%)",
    () => state.laserPower,
    (v) => {
      state.laserPower = Math.min(100, Math.max(0, v));
    },
  );
  const passes = numRow(
    doc,
    "Passes",
    () => state.laserPasses,
    (v) => {
      state.laserPasses = Math.max(1, Math.round(v));
    },
  );
  const kerf = numRow(
    doc,
    `Kerf width (${doc.displayUnit})`,
    () => state.kerfWidth,
    (v) => {
      state.kerfWidth = Math.max(0, v);
    },
    "len",
  );

  const layerBanner = document.createElement("div");
  layerBanner.className = "tp-field tp-beam-layer";
  layerBanner.style.cssText =
    "display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;";
  const layerNote = document.createElement("span");
  layerNote.style.cssText = "flex:1;min-width:150px;font-size:11px;color:var(--text-dim);";
  const layerBtn = document.createElement("button");
  layerBtn.type = "button";
  layerBtn.className = "btn tp-beam-layer-toggle";
  layerBanner.append(layerNote, layerBtn);
  sec.appendChild(layerBanner);

  const beamFields = [feed, power, passes, kerf];

  const updateLayerBanner = (): void => {
    const layer = beamLayer(doc, [...state.entityIds], state.laserOverride);
    const forkedFrom = state.laserOverride
      ? beamLayer(doc, [...state.entityIds], false)
      : null;
    layerBanner.style.display = layer || forkedFrom ? "" : "none";
    for (const f of beamFields) {
      f.inp.disabled = !!layer;
      f.inp.style.opacity = layer ? "0.55" : "";
    }
    if (layer) {
      layerNote.textContent = `⚡ Power, speed and passes come from the "${layer.name}" layer.`;
      layerNote.title =
        "Edit them in the Layers panel to change every toolpath cutting this layer.";
      layerBtn.textContent = "Use custom settings";
      layerBtn.title = `Give this toolpath its own power and speed, independent of the "${layer.name}" layer`;
    } else if (forkedFrom) {
      layerNote.textContent = `Custom settings — not following the "${forkedFrom.name}" layer.`;
      layerNote.title = "";
      layerBtn.textContent = "Follow the layer";
      layerBtn.title = `Take power, speed and passes from the "${forkedFrom.name}" layer again`;
    }
  };

  layerBtn.addEventListener("click", () => {
    if (!state.laserOverride) {
      const layer = beamLayer(doc, [...state.entityIds], false);
      if (layer?.laser) {
        state.feedrate = layer.laser.feedrate;
        state.laserPower = layer.laser.laserPower;
        state.laserPasses = layer.laser.laserPasses;
        if (layer.laser.kerfWidth !== undefined) state.kerfWidth = layer.laser.kerfWidth;
        if (layer.laser.airAssist !== undefined) state.airAssist = layer.laser.airAssist;
      }
    }
    state.laserOverride = !state.laserOverride;
    update();
  });

  sec.appendChild(feed.el);
  sec.appendChild(power.el);
  sec.appendChild(passes.el);
  sec.appendChild(kerf.el);

  // Fill (area engrave)
  const fillChk = document.createElement("input");
  fillChk.type = "checkbox";
  fillChk.className = "settings-checkbox";
  fillChk.checked = state.laserFill;
  const fillRow = dField("Fill area (engrave solid)", fillChk);
  const fillSpacing = numRow(
    doc,
    `Fill spacing (${doc.displayUnit})`,
    () => state.laserFillSpacing,
    (v) => {
      state.laserFillSpacing = Math.max(0.01, v);
    },
    "len",
  );
  const overscan = numRow(
    doc,
    `Overscan (${doc.displayUnit}, 0=off)`,
    () => state.laserOverscan,
    (v) => {
      state.laserOverscan = Math.max(0, v);
    },
    "len",
  );
  sec.appendChild(fillRow);
  sec.appendChild(fillSpacing.el);
  sec.appendChild(overscan.el);

  // Raster engrave
  const rLine = numRow(
    doc,
    `Line interval (${doc.displayUnit})`,
    () => state.rasterLineInterval,
    (v) => {
      state.rasterLineInterval = Math.max(0.001, v);
    },
    "len",
  );
  const rDot = numRow(
    doc,
    `Dot pitch (${doc.displayUnit}, 0=square)`,
    () => state.rasterDotPitch,
    (v) => {
      state.rasterDotPitch = Math.max(0, v);
    },
    "len",
  );
  const rMin = numRow(
    doc,
    "Min power (%)",
    () => state.rasterMinPower,
    (v) => {
      state.rasterMinPower = Math.min(100, Math.max(0, v));
    },
  );

  const rDitherSel = document.createElement("select");
  rDitherSel.className = "dim";
  for (const mode of ["none", ...DITHER_MODES] as DitherMode[]) {
    const o = document.createElement("option");
    o.value = mode;
    o.textContent = DITHER_LABELS[mode];
    rDitherSel.appendChild(o);
  }
  rDitherSel.value = state.rasterDither;
  rDitherSel.title =
    "Dithering renders tone as a pattern of full-power dots (density = darkness) " +
    "rather than modulating power per dot. Floyd–Steinberg is the classic; Jarvis " +
    "is smoother; Atkinson is higher-contrast (good on wood); Ordered is a fast " +
    "Bayer pattern. Off = greyscale power modulation.";
  const rDitherRow = dField("Dithering", rDitherSel);

  const SW = 232;
  const SH = 40;
  const rDitherSwatch = document.createElement("canvas");
  rDitherSwatch.width = SW;
  rDitherSwatch.height = SH;
  rDitherSwatch.style.cssText = `width:${SW}px;height:${SH}px;image-rendering:pixelated;border-radius:4px;display:block;`;
  rDitherSwatch.title = "Magnified pattern preview (1 pixel = 1 laser dot) — dark→light ramp";
  const rDitherSwatchCap = document.createElement("span");
  rDitherSwatchCap.style.cssText = "opacity:0.6;font-size:11px;";
  rDitherSwatchCap.textContent = "Pattern (magnified: 1 px = 1 dot)";
  const rDitherSwatchRow = document.createElement("div");
  rDitherSwatchRow.className = "props-row";
  rDitherSwatchRow.style.cssText = "flex-direction:column;align-items:flex-start;gap:2px;";
  rDitherSwatchRow.append(rDitherSwatchCap, rDitherSwatch);

  const renderDitherSwatch = (): void => {
    const sctx = rDitherSwatch.getContext("2d");
    if (!sctx) return;
    const img = sctx.createImageData(SW, SH);
    img.data.set(ditherRampRGBA(state.rasterDither, SW, SH));
    sctx.putImageData(img, 0, 0);
  };

  const invChk = document.createElement("input");
  invChk.type = "checkbox";
  invChk.className = "settings-checkbox";
  invChk.checked = state.rasterInvert;
  invChk.addEventListener("change", () => {
    state.rasterInvert = invChk.checked;
  });
  const rInvRow = dField("Invert (engrave light areas)", invChk);
  sec.appendChild(rLine.el);
  sec.appendChild(rDot.el);
  sec.appendChild(rMin.el);
  sec.appendChild(rDitherRow);
  sec.appendChild(rDitherSwatchRow);
  sec.appendChild(rInvRow);

  const airChk = document.createElement("input");
  airChk.type = "checkbox";
  airChk.className = "settings-checkbox";
  airChk.checked = state.airAssist;
  airChk.addEventListener("change", () => {
    state.airAssist = airChk.checked;
  });
  sec.appendChild(dField("Air assist (M8/M9)", airChk));

  const presetKind = (): LaserPresetKind =>
    state.combo === "engrave" ? "engrave" : state.combo === "score" ? "score" : "cut";

  const applyPreset = (p: LaserPreset): void => {
    state.feedrate = p.feedrate;
    state.laserPower = p.laserPower;
    state.laserPasses = p.laserPasses;
    if (p.kerfWidth !== undefined) state.kerfWidth = p.kerfWidth;
    if (p.airAssist !== undefined) state.airAssist = p.airAssist;
    feed.inp.value = feedView(p.feedrate, doc);
    power.inp.value = String(p.laserPower);
    passes.inp.value = String(p.laserPasses);
    if (p.kerfWidth !== undefined) kerf.inp.value = lenView(p.kerfWidth, doc);
    if (p.airAssist !== undefined) airChk.checked = p.airAssist;
  };

  const presetRow = document.createElement("div");
  presetRow.className = "tp-field tp-preset-row";
  const presetLabel = document.createElement("label");
  presetLabel.textContent = "Material preset";
  const presetBtns = document.createElement("div");
  presetBtns.style.cssText = "display:flex;gap:6px;flex:1;";

  const loadPresetBtn = document.createElement("button");
  loadPresetBtn.type = "button";
  loadPresetBtn.className = "btn tp-preset-load";
  loadPresetBtn.textContent = "Load preset";
  const savePresetBtn = document.createElement("button");
  savePresetBtn.type = "button";
  savePresetBtn.className = "btn tp-preset-save";
  savePresetBtn.textContent = "Save as preset…";
  savePresetBtn.title = "Save this op's power, speed and passes as a reusable recipe";
  presetBtns.append(loadPresetBtn, savePresetBtn);
  presetRow.append(presetLabel, presetBtns);

  const presetPicker = document.createElement("div");
  presetPicker.className = "tp-preset-picker";
  presetPicker.style.cssText =
    "display:none;margin:0 0 8px;max-height:150px;overflow-y:auto;" +
    "background:var(--panel);border:1px solid var(--border);border-radius:4px;";

  const refreshPresets = (): void => {
    presetPicker.innerHTML = "";
    const available = presetsFor(presetKind());
    if (available.length === 0) {
      const mt = document.createElement("div");
      mt.className = "tp-preset-empty";
      mt.style.cssText = "padding:8px;font-size:11px;color:var(--text-dim);line-height:1.5;";
      mt.textContent =
        `No ${presetKind()} presets saved yet. Dial in power and speed (the ` +
        `Material Test button generates a grid), then "Save as preset…".`;
      presetPicker.appendChild(mt);
      return;
    }
    for (const p of available) {
      const row = document.createElement("div");
      row.className = "tp-preset-item";
      row.style.cssText =
        "display:flex;align-items:center;gap:6px;padding:5px 8px;cursor:pointer;" +
        "border-bottom:1px solid var(--border);font-size:11px;";
      row.addEventListener("mouseover", () => {
        row.style.background = "var(--panel-2)";
      });
      row.addEventListener("mouseout", () => {
        row.style.background = "";
      });
      const nameSpan = document.createElement("span");
      nameSpan.style.flex = "1";
      nameSpan.textContent = p.name;
      const detailSpan = document.createElement("span");
      detailSpan.style.color = "var(--text-dim)";
      detailSpan.textContent = `${p.laserPower}% · ${feedU(p.feedrate, doc)} · ${p.laserPasses}×`;
      row.append(nameSpan, detailSpan);
      row.addEventListener("click", () => {
        applyPreset(p);
        presetPicker.style.display = "none";
        pickerOpen = false;
      });
      presetPicker.appendChild(row);
    }
  };

  let pickerOpen = false;
  loadPresetBtn.addEventListener("click", () => {
    pickerOpen = !pickerOpen;
    if (pickerOpen) refreshPresets();
    presetPicker.style.display = pickerOpen ? "" : "none";
  });

  savePresetBtn.addEventListener("click", () => {
    const suggested = state.name?.trim() || `${presetKind()} preset`;
    const name = window.prompt("Name this material preset", suggested)?.trim();
    if (!name) return;
    const kind = presetKind();
    addPreset({
      id: newPresetId(),
      name,
      kind,
      feedrate: state.feedrate,
      laserPower: state.laserPower,
      laserPasses: state.laserPasses,
      ...(kind === "cut" ? { kerfWidth: state.kerfWidth } : {}),
      airAssist: state.airAssist,
    });
    if (pickerOpen) refreshPresets();
  });

  sec.insertBefore(presetRow, feed.el);
  sec.insertBefore(presetPicker, feed.el);

  const opTargetsImage = (ids: Set<string>): boolean => {
    for (const id of ids) {
      if (doc.entities.find((e) => e.id === id) instanceof RasterImageEntity) return true;
    }
    return false;
  };

  const update = () => {
    updateLayerBanner();
    const active = beamLayer(doc, [...state.entityIds], state.laserOverride)?.laser;
    feed.inp.value = feedView(active?.feedrate ?? state.feedrate, doc);
    power.inp.value = String(active?.laserPower ?? state.laserPower);
    passes.inp.value = String(active?.laserPasses ?? state.laserPasses);
    kerf.inp.value = lenView(active?.kerfWidth ?? state.kerfWidth, doc);
    const isCut = state.combo === "profile-outside" || state.combo === "profile-inside";
    const isEngrave = state.combo === "engrave";
    const isRaster = isEngrave && opTargetsImage(state.entityIds);
    if (pickerOpen) refreshPresets();
    kerf.el.style.display = isCut ? "" : "none";
    fillRow.style.display = isEngrave && !isRaster ? "" : "none";
    fillSpacing.el.style.display = isEngrave && !isRaster && state.laserFill ? "" : "none";
    overscan.el.style.display =
      isRaster || (isEngrave && !isRaster && state.laserFill) ? "" : "none";
    for (const r of [rLine.el, rDot.el, rDitherRow, rDitherSwatchRow, rInvRow])
      r.style.display = isRaster ? "" : "none";
    rMin.el.style.display = isRaster && state.rasterDither === "none" ? "" : "none";
  };

  rDitherSel.addEventListener("change", () => {
    state.rasterDither = rDitherSel.value as DitherMode;
    renderDitherSwatch();
    update();
  });
  renderDitherSwatch();
  fillChk.addEventListener("change", () => {
    state.laserFill = fillChk.checked;
    update();
  });

  events.onRefreshBeamLayer(() => updateLayerBanner());

  update();
  return { root: sec, update };
}
