/**
 * Geometry section: entity/region picking, canvas pick-mode, and the live entity list.
 */
import type { CADDocument, GroupDef } from "../../../../model/document";
import {
  type Entity,
  TextEntity,
  LineEntity,
  ArcEntity,
  BezierEntity,
} from "../../../../model/entities";
import type { Vec2 } from "../../../../core/vec2";
import { formatLength } from "../../../../core/units";
import {
  collectClosedLoops,
  groupLinesIntoClosedChains,
  pointInPolygon,
} from "../../../../cam/loops";
import { regionAtPoint, interiorPoint } from "../../../../cam/regions";
import { groupContoursIntoRegions } from "../../../../cam/vcarve";
import { textToContours } from "../../../../cam/textOutlines";
import {
  describeEntity,
  isValidFor,
  findContiguousChain,
} from "../../../camBarHelpers";
import type { OpState, OpDialogEvents } from "../opDialogState";
import { dSection, dField } from "../dialogDom";

export interface GeometrySectionController {
  root: HTMLElement;
  renderEntities: () => void;
  startPickMode: () => void;
  stopPickMode: () => void;
  getPickActive: () => boolean;
  cleanup: () => void;
  updateModeVisibility: () => void;
}

export function buildGeometrySection(
  doc: CADDocument,
  state: OpState,
  events: OpDialogEvents,
): GeometrySectionController {
  let renderEntities!: () => void;
  let pickModeActive = false;
  let unsubPickMode: (() => void) | null = null;

  const geoSec = dSection("Geometry");

  const modeSelect = document.createElement("select");
  modeSelect.className = "d-input tp-boundary-mode";
  modeSelect.innerHTML = `
    <option value="regions">Flood-fill Regions</option>
    <option value="entities">Explicit Entities</option>
  `;
  modeSelect.value = state.pocketBoundaryMode;
  modeSelect.addEventListener("change", () => {
    state.pocketBoundaryMode = modeSelect.value as "regions" | "entities";
    if (state.pocketBoundaryMode === "regions") {
      state.entityIds.clear();
    } else {
      state.regionSeeds = [];
    }
    renderEntities();
  });

  const modeRow = dField("Boundary mode", modeSelect);
  modeRow.style.display = state.combo === "pocket" || state.combo === "vcarve" ? "" : "none";
  geoSec.appendChild(modeRow);

  // Geometry toolbar
  const geoBar = document.createElement("div");
  geoBar.style.cssText = "display:flex;gap:6px;margin-bottom:6px;";

  const pickBtn = document.createElement("button");
  pickBtn.className = "btn";
  pickBtn.title = "Click entities on the canvas to add them to this toolpath";
  pickBtn.textContent = "Pick";

  const fromSelBtn = document.createElement("button");
  fromSelBtn.className = "btn";
  fromSelBtn.style.flex = "1";
  fromSelBtn.title = "Add whatever is currently selected on the canvas";
  fromSelBtn.textContent = "+ From Selection";
  fromSelBtn.addEventListener("click", () => {
    if (
      (state.combo === "pocket" || state.combo === "vcarve") &&
      state.pocketBoundaryMode === "regions"
    ) {
      const docLoops = collectClosedLoops(doc.entities);
      const selectedEnts = doc.entities.filter((e) => e.selected);
      const selLoops = collectClosedLoops(selectedEnts.filter((e) => !(e instanceof TextEntity)));
      let added = 0;

      const addSeed = (p: Vec2, region: ReturnType<typeof regionAtPoint>) => {
        if (!region) return false;
        if (
          state.regionSeeds.some(
            (s) =>
              pointInPolygon(s, region.outer) &&
              !region.holes.some((h: Vec2[]) => pointInPolygon(s, h)),
          )
        )
          return false;
        state.regionSeeds.push(p);
        return true;
      };

      for (const loop of selLoops) {
        const p = interiorPoint(loop.verts);
        if (!p) continue;
        if (addSeed(p, regionAtPoint(p, docLoops))) added++;
      }

      const texts = selectedEnts.filter((e): e is TextEntity => e instanceof TextEntity);
      for (const t of texts) {
        const regions = groupContoursIntoRegions(
          textToContours(t).map((c: { points: Vec2[] }) => c.points),
        );
        for (const r of regions) {
          const p = interiorPoint(r.outer, r.holes);
          if (p && addSeed(p, regionAtPoint(p, docLoops))) added++;
        }
      }

      if (added > 0) renderEntities();
      return;
    }
    let added = 0;
    for (const e of doc.entities) {
      if (e.selected && !e.isConstruction && isValidFor(e, state.combo)) {
        state.entityIds.add(e.id);
        added++;
      }
    }
    if (added > 0) {
      if (pickModeActive) stopPickMode();
      renderEntities();
    }
  });

  const clearBtn = document.createElement("button");
  clearBtn.className = "btn";
  clearBtn.textContent = "Clear";
  clearBtn.addEventListener("click", () => {
    state.regionSeeds.length = 0;
    for (const id of state.entityIds) {
      const ent = doc.entities.find((x) => x.id === id);
      if (ent) ent.selected = false;
    }
    state.entityIds.clear();
    renderEntities();
  });

  geoBar.appendChild(pickBtn);
  geoBar.appendChild(fromSelBtn);
  geoBar.appendChild(clearBtn);
  geoSec.appendChild(geoBar);

  const pickHint = document.createElement("div");
  pickHint.style.cssText =
    "display:none;font-size:11px;color:var(--accent);margin-bottom:6px;padding:4px 6px;" +
    "background:var(--panel-2);border-radius:4px;border:1px solid var(--accent-dim);";
  pickHint.textContent = "Click entities on the canvas to add them";
  geoSec.appendChild(pickHint);

  const stopPickMode = () => {
    if (unsubPickMode) {
      unsubPickMode();
      unsubPickMode = null;
    }
    doc.regionPickHandler = null;
    doc.regionHoverHandler = null;
    doc.regionPickHoverFill = null;
    pickModeActive = false;
    pickBtn.classList.remove("active");
    pickHint.style.display = "none";
    doc.emitChange();
  };

  const startPickMode = () => {
    pickModeActive = true;
    pickBtn.classList.add("active");
    pickHint.style.display = "block";

    if (
      (state.combo === "pocket" || state.combo === "vcarve") &&
      state.pocketBoundaryMode === "regions"
    ) {
      pickHint.textContent = "Click an enclosed area to add it; click again to remove";
      doc.regionPickHandler = (world) => {
        const loops = collectClosedLoops(doc.entities);
        const hit = state.regionSeeds.findIndex((seed) => {
          const r = regionAtPoint(seed, loops);
          return (
            r &&
            pointInPolygon(world, r.outer) &&
            !r.holes.some((h: Vec2[]) => pointInPolygon(world, h))
          );
        });
        if (hit >= 0) state.regionSeeds.splice(hit, 1);
        else if (regionAtPoint(world, loops)) state.regionSeeds.push({ ...world });
        else return true;
        renderEntities();
        return true;
      };
      doc.regionHoverHandler = (world) => {
        const loops = collectClosedLoops(doc.entities);
        const region = regionAtPoint(world, loops);
        doc.regionPickHoverFill = region ? [region.outer, ...region.holes] : null;
      };
      return;
    }

    pickHint.textContent = "Click entities on the canvas to add them";
    for (const e of doc.entities) {
      if (!e.isConstruction && isValidFor(e, state.combo) && e.selected)
        state.entityIds.add(e.id);
    }
    renderEntities();
    unsubPickMode = doc.onChange(() => {
      let changed = false;
      for (const e of doc.entities) {
        if (!e.isConstruction && isValidFor(e, state.combo) && e.selected) {
          if (!state.entityIds.has(e.id)) {
            state.entityIds.add(e.id);
            changed = true;
          }
        }
      }
      if (changed) renderEntities();
    });
  };

  pickBtn.addEventListener("click", () => {
    if (pickModeActive) stopPickMode();
    else startPickMode();
  });

  const entityList = document.createElement("div");
  geoSec.appendChild(entityList);

  const renderRegionList = () => {
    const loops = collectClosedLoops(doc.entities);
    const items = state.regionSeeds.map((seed) => ({ seed, region: regionAtPoint(seed, loops) }));

    const highlight = new Set<string>();
    const fills: Vec2[][][] = [];
    for (const it of items) {
      if (!it.region) continue;
      for (const id of it.region.loopIds) highlight.add(id);
      fills.push([it.region.outer, ...it.region.holes]);
    }
    doc.toolpathHighlightIds = highlight;
    doc.regionPickFills = fills;
    doc.emitChange();

    entityList.innerHTML = "";
    if (items.length === 0) {
      const mt = document.createElement("div");
      mt.className = "tp-entity-empty";
      mt.textContent = pickModeActive
        ? "No areas picked yet — click inside an enclosed area on the canvas"
        : "No areas picked yet — press Pick, then click inside an enclosed area";
      entityList.appendChild(mt);
      return;
    }

    const u = doc.displayUnit;
    items.forEach((it, idx) => {
      const row = document.createElement("div");
      row.className = `tp-entity-row${it.region ? "" : " tp-entity-disabled"}`;
      row.style.cssText = "display:flex;align-items:center;gap:8px;";

      const desc = document.createElement("span");
      desc.style.flex = "1";
      if (it.region) {
        let minX = Infinity,
          minY = Infinity,
          maxX = -Infinity,
          maxY = -Infinity;
        for (const v of it.region.outer) {
          if (v.x < minX) minX = v.x;
          if (v.x > maxX) maxX = v.x;
          if (v.y < minY) minY = v.y;
          if (v.y > maxY) maxY = v.y;
        }
        const size = `${formatLength(maxX - minX, u)} × ${formatLength(maxY - minY, u)}`;
        const isl =
          it.region.holes.length > 0
            ? ` — ${it.region.holes.length} island${it.region.holes.length === 1 ? "" : "s"}`
            : "";
        desc.textContent = `Area ${idx + 1} — ${size}${isl}`;
      } else {
        desc.textContent = `Area ${idx + 1} — no longer enclosed`;
        desc.style.opacity = "0.45";
      }

      row.addEventListener("mouseenter", () => {
        doc.regionPickHoverFill = it.region ? [it.region.outer, ...it.region.holes] : null;
        doc.emitChange();
      });
      row.addEventListener("mouseleave", () => {
        doc.regionPickHoverFill = null;
        doc.emitChange();
      });

      const rmBtn = document.createElement("button");
      rmBtn.className = "btn";
      rmBtn.style.cssText = "padding:2px 8px;font-size:10px;";
      rmBtn.textContent = "✕";
      rmBtn.title = "Remove this area";
      rmBtn.addEventListener("click", () => {
        state.regionSeeds.splice(idx, 1);
        doc.regionPickHoverFill = null;
        renderEntities();
      });

      row.appendChild(desc);
      row.appendChild(rmBtn);
      entityList.appendChild(row);
    });
  };

  renderEntities = () => {
    events.emitRefreshBeamLayer();
    if (
      (state.combo === "pocket" || state.combo === "vcarve") &&
      (state.regionSeeds.length > 0 || pickModeActive)
    ) {
      renderRegionList();
      return;
    }
    doc.toolpathHighlightIds = new Set([...state.entityIds, ...state.islandIds]);
    doc.regionPickFills = null;
    doc.emitChange();
    entityList.innerHTML = "";

    const ents = doc.entities.filter((e) => !e.isConstruction && isValidFor(e, state.combo));
    if (ents.length === 0) {
      const mt = document.createElement("div");
      mt.className = "tp-entity-empty";
      mt.textContent = "No geometry in document";
      entityList.appendChild(mt);
      return;
    }

    const entityGroupMap = new Map<string, GroupDef>();
    for (const g of doc.groups) for (const eid of g.entityIds) entityGroupMap.set(eid, g);

    const byLayer = new Map<string, Entity[]>();
    for (const e of ents) {
      const arr = byLayer.get(e.layerId) ?? [];
      arr.push(e);
      byLayer.set(e.layerId, arr);
    }

    const makeEntityRow = (e: Entity, section: "boundary" | "island", indent = false) => {
      const thisSet = section === "boundary" ? state.entityIds : state.islandIds;
      const otherSet = section === "boundary" ? state.islandIds : state.entityIds;
      const inOther = otherSet.has(e.id);
      const disabled = inOther;

      const row = document.createElement("div");
      row.className = `tp-entity-row${disabled ? " tp-entity-disabled" : ""}`;
      row.style.cssText = `display:flex;align-items:center;${indent ? "padding-left:20px;" : ""}`;

      const lbl = document.createElement("label");
      lbl.style.cssText = `display:flex;align-items:center;gap:8px;flex:1;cursor:${disabled ? "default" : "pointer"};`;

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "tp-entity-cb";
      cb.checked = thisSet.has(e.id);
      cb.disabled = disabled;
      cb.addEventListener("change", () => {
        if (cb.checked) {
          thisSet.add(e.id);
          otherSet.delete(e.id);
        } else {
          thisSet.delete(e.id);
          e.selected = false;
        }
        renderEntities();
      });

      const desc = document.createElement("span");
      desc.textContent = describeEntity(e, doc);
      if (inOther) {
        desc.style.opacity = "0.45";
        desc.title = section === "boundary" ? "Assigned to Islands" : "Assigned to Boundary";
      }

      lbl.appendChild(cb);
      lbl.appendChild(desc);
      row.appendChild(lbl);

      if (
        section === "boundary" &&
        !inOther &&
        (e instanceof LineEntity || e instanceof ArcEntity || e instanceof BezierEntity)
      ) {
        const chainBtn = document.createElement("button");
        chainBtn.className = "btn";
        chainBtn.style.cssText = "padding:2px 6px;font-size:10px;";
        chainBtn.textContent = "Chain";
        chainBtn.title = "Select connected chain";
        chainBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const chainIds = findContiguousChain(e.id, doc, state.combo);
          for (const id of chainIds) {
            state.entityIds.add(id);
            state.islandIds.delete(id);
          }
          renderEntities();
        });
        row.appendChild(chainBtn);
      }

      return row;
    };

    const makeChainRow = (chain: LineEntity[], section: "boundary" | "island") => {
      const thisSet = section === "boundary" ? state.entityIds : state.islandIds;
      const otherSet = section === "boundary" ? state.islandIds : state.entityIds;
      const allInOther = chain.every((e) => otherSet.has(e.id));
      const someInOther = chain.some((e) => otherSet.has(e.id));
      const disabled = allInOther || someInOther;
      const checked = !disabled && chain.every((e) => thisSet.has(e.id));
      const indeterminate = !disabled && !checked && chain.some((e) => thisSet.has(e.id));

      const row = document.createElement("div");
      row.className = `tp-entity-row${disabled ? " tp-entity-disabled" : ""}`;
      row.style.cssText = "display:flex;align-items:center;";

      const lbl = document.createElement("label");
      lbl.style.cssText = `display:flex;align-items:center;gap:8px;flex:1;cursor:${disabled ? "default" : "pointer"};`;

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "tp-entity-cb";
      cb.checked = checked;
      cb.indeterminate = indeterminate;
      cb.disabled = disabled;
      cb.addEventListener("change", () => {
        for (const e of chain) {
          if (cb.checked) {
            thisSet.add(e.id);
            otherSet.delete(e.id);
          } else {
            thisSet.delete(e.id);
            e.selected = false;
          }
        }
        renderEntities();
      });

      const desc = document.createElement("span");
      desc.textContent = `Closed path — ${chain.length} segments`;
      if (disabled) {
        desc.style.opacity = "0.45";
        desc.title = section === "boundary" ? "Assigned to Islands" : "Assigned to Boundary";
      }

      lbl.appendChild(cb);
      lbl.appendChild(desc);
      row.appendChild(lbl);
      return row;
    };

    const renderSection = (section: "boundary" | "island", container: HTMLElement) => {
      const thisSet = section === "boundary" ? state.entityIds : state.islandIds;
      const otherSet = section === "boundary" ? state.islandIds : state.entityIds;

      for (const layer of doc.layers) {
        const layerEnts = byLayer.get(layer.id) ?? [];
        if (layerEnts.length === 0) continue;

        const groupsInLayer = new Map<string, { group: GroupDef; ents: Entity[] }>();
        const ungroupedEnts: Entity[] = [];
        for (const e of layerEnts) {
          const g = entityGroupMap.get(e.id);
          if (g) {
            if (!groupsInLayer.has(g.id)) groupsInLayer.set(g.id, { group: g, ents: [] });
            groupsInLayer.get(g.id)!.ents.push(e);
          } else {
            ungroupedEnts.push(e);
          }
        }

        const lh = document.createElement("div");
        lh.style.cssText =
          "display:flex;justify-content:space-between;align-items:center;" +
          "padding:4px 8px;background:var(--panel);border-radius:4px;margin-top:8px;margin-bottom:4px;";
        const lhTitle = document.createElement("span");
        lhTitle.style.cssText = "font-size:11px;font-weight:700;color:var(--text);";
        lhTitle.textContent = layer.name;
        lh.appendChild(lhTitle);

        if (section === "boundary") {
          const lToggle = document.createElement("button");
          lToggle.className = "btn";
          lToggle.style.cssText = "padding:2px 6px;font-size:10px;";
          lToggle.textContent = "Toggle";
          lToggle.addEventListener("click", () => {
            const valid = layerEnts.filter(
              (e) => isValidFor(e, state.combo) && !otherSet.has(e.id),
            );
            const allChecked = valid.every((e) => thisSet.has(e.id));
            for (const e of valid) {
              if (allChecked) {
                thisSet.delete(e.id);
                e.selected = false;
              } else thisSet.add(e.id);
            }
            renderEntities();
          });
          lh.appendChild(lToggle);
        }
        container.appendChild(lh);

        for (const { group, ents: gEnts } of groupsInLayer.values()) {
          const validEnts = gEnts.filter((e) => isValidFor(e, state.combo));
          const available = validEnts.filter((e) => !otherSet.has(e.id));
          const isValid = validEnts.length > 0;
          const allChecked = available.length > 0 && available.every((e) => thisSet.has(e.id));
          const someChecked = available.some((e) => thisSet.has(e.id));

          const groupRow = document.createElement("div");
          groupRow.className = `tp-entity-row${isValid ? "" : " tp-entity-disabled"}`;
          groupRow.style.cssText = "display:flex;align-items:center;";

          const lbl = document.createElement("label");
          lbl.style.cssText = `display:flex;align-items:center;gap:8px;flex:1;cursor:${isValid ? "pointer" : "default"};`;

          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.className = "tp-entity-cb";
          cb.checked = allChecked;
          cb.indeterminate = someChecked && !allChecked;
          cb.disabled = !isValid;
          cb.addEventListener("change", () => {
            for (const e of available) {
              if (cb.checked) {
                thisSet.add(e.id);
                otherSet.delete(e.id);
              } else {
                thisSet.delete(e.id);
                e.selected = false;
              }
            }
            renderEntities();
          });

          const nameInput = document.createElement("input");
          nameInput.type = "text";
          nameInput.value = group.name;
          nameInput.placeholder = `Group — ${gEnts.length} ${gEnts.length === 1 ? "entity" : "entities"}`;
          nameInput.style.cssText =
            "background:transparent;border:none;border-bottom:1px solid var(--border);" +
            "color:var(--text);font:inherit;font-style:italic;width:160px;padding:0 2px;outline:none;";
          nameInput.addEventListener("change", () => {
            group.name = nameInput.value.trim();
          });
          nameInput.addEventListener("click", (ev) => ev.stopPropagation());

          lbl.appendChild(cb);
          lbl.appendChild(nameInput);
          groupRow.appendChild(lbl);
          container.appendChild(groupRow);
          for (const e of gEnts) container.appendChild(makeEntityRow(e, section, true));
        }

        const ungroupedLines = ungroupedEnts.filter(
          (e): e is LineEntity => e instanceof LineEntity,
        );
        const ungroupedOther = ungroupedEnts.filter((e) => !(e instanceof LineEntity));
        const { chains: lineChains, singles: openLines } =
          groupLinesIntoClosedChains(ungroupedLines);
        for (const chain of lineChains) container.appendChild(makeChainRow(chain, section));
        if (section === "boundary")
          for (const e of openLines) container.appendChild(makeEntityRow(e, section));
        for (const e of ungroupedOther) container.appendChild(makeEntityRow(e, section));
      }
    };

    const makeSectionList = () => {
      const el = document.createElement("div");
      el.className = "tp-entity-list";
      return el;
    };

    const list = makeSectionList();
    entityList.appendChild(list);
    renderSection("boundary", list);
  };

  return {
    root: geoSec,
    renderEntities,
    startPickMode,
    stopPickMode,
    getPickActive: () => pickModeActive,
    cleanup: () => {
      if (unsubPickMode) unsubPickMode();
    },
    updateModeVisibility: () => {
      modeRow.style.display = state.combo === "pocket" || state.combo === "vcarve" ? "" : "none";
    },
  };
}
