import type { CADDocument, LayerDef } from "../model/document";
import { nextId } from "../model/ids";
import { confirmDialog } from "./modal";
import { DEFAULTS, getAssociatedOperations } from "../cam/types";
import { loadPresets } from "../cam/laserPresets";
import { fromMM, toMM } from "../core/units";

export class LayersBar {
  private content!: HTMLElement;
  private listEl!: HTMLElement;
  private isCollapsed = false;

  constructor(
    private host: HTMLElement,
    private doc: CADDocument,
    private pushHistory: () => void,
  ) {
    this.build();
    this.doc.onChange(() => this.render());
    this.render();
  }

  private build(): void {
    this.host.innerHTML = "";

    const header = document.createElement("div");
    header.className = "layers-header";

    const title = document.createElement("div");
    title.className = "layers-title";
    title.textContent = "Layers";
    header.appendChild(title);

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "layers-toggle";
    toggleBtn.textContent = "›";
    toggleBtn.title = "Collapse/Expand";
    toggleBtn.addEventListener("click", () => this.toggleCollapse());
    header.appendChild(toggleBtn);

    this.host.appendChild(header);

    this.content = document.createElement("div");
    this.content.className = "layers-content";

    this.listEl = document.createElement("div");
    this.listEl.style.display = "flex";
    this.listEl.style.flexDirection = "column";
    this.listEl.style.gap = "4px";
    this.listEl.style.marginBottom = "8px";
    this.content.appendChild(this.listEl);

    const addBtn = document.createElement("button");
    addBtn.className = "btn";
    addBtn.textContent = "+ New Layer";
    addBtn.style.width = "100%";
    addBtn.onclick = () => {
      this.pushHistory();
      const newLayer: LayerDef = {
        id: nextId("layer"),
        name: `Layer ${this.doc.layers.length + 1}`,
        color: "#10b981", // default new layer color (emerald)
        visible: true,
        locked: false,
      };
      this.doc.layers.push(newLayer);
      this.doc.activeLayerId = newLayer.id;
      this.doc.emitChange();
    };
    this.content.appendChild(addBtn);

    this.host.appendChild(this.content);
  }

  private toggleCollapse(): void {
    this.isCollapsed = !this.isCollapsed;
    this.host.classList.toggle("collapsed", this.isCollapsed);
    this.host.addEventListener(
      "transitionend",
      () => {
        window.dispatchEvent(new Event("resize"));
      },
      { once: true },
    );
  }

  private render(): void {
    this.listEl.innerHTML = "";

    for (const layer of this.doc.layers) {
      // Sizing lives in .layer-row (style.css). The panel is ~225px and the row
      // carries up to seven controls; it was already at its limit on a mill, and
      // adding the beam toggle pushed Delete clean outside the panel.
      const row = document.createElement("div");
      row.className = "layer-row";
      row.style.backgroundColor =
        this.doc.activeLayerId === layer.id ? "rgba(255,255,255,0.1)" : "transparent";

      // Radio button for active layer
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "activeLayer";
      radio.checked = this.doc.activeLayerId === layer.id;
      radio.onclick = () => {
        this.doc.activeLayerId = layer.id;
        this.doc.emitChange();
      };
      row.appendChild(radio);

      // Color picker
      const colorInp = document.createElement("input");
      colorInp.type = "color";
      colorInp.value = layer.color;
      colorInp.style.width = "20px";
      colorInp.style.height = "20px";
      colorInp.style.padding = "0";
      colorInp.style.border = "none";
      colorInp.style.cursor = "pointer";
      colorInp.onchange = () => {
        this.pushHistory();
        layer.color = colorInp.value;
        this.doc.emitChange();
      };
      row.appendChild(colorInp);

      const nameInp = document.createElement("input");
      nameInp.type = "text";
      nameInp.value = layer.name;
      nameInp.className = "dim";
      nameInp.title = layer.name;
      nameInp.onchange = () => {
        this.pushHistory();
        layer.name = nameInp.value || "Layer";
        this.doc.emitChange();
      };
      row.appendChild(nameInp);

      // Visibility toggle (eye)
      const visBtn = document.createElement("button");
      visBtn.className = "icon-btn";
      visBtn.innerHTML = layer.visible ? "👁" : "🕶";
      visBtn.title = "Toggle Visibility";
      visBtn.onclick = () => {
        this.pushHistory();
        layer.visible = !layer.visible;
        this.doc.clearSelection(); // avoid selecting hidden entities
        this.doc.emitChange();
      };
      row.appendChild(visBtn);

      // Lock toggle
      const lockBtn = document.createElement("button");
      lockBtn.className = "icon-btn";
      lockBtn.innerHTML = layer.locked ? "🔒" : "🔓";
      lockBtn.title = "Toggle Lock";
      lockBtn.onclick = () => {
        this.pushHistory();
        layer.locked = !layer.locked;
        this.doc.clearSelection(); // avoid selecting locked entities
        this.doc.emitChange();
      };
      row.appendChild(lockBtn);

      // Fixture (workholding) toggle — closed shapes on a fixture layer are clamps
      // / keep-outs: not machined, and pre-flight flags any move that would hit one.
      const fixBtn = document.createElement("button");
      fixBtn.className = "icon-btn";
      fixBtn.innerHTML = "🗜";
      fixBtn.style.opacity = layer.fixture ? "1" : "0.35";
      fixBtn.title = layer.fixture
        ? "Workholding layer (clamps / keep-outs) — click to make it a normal layer"
        : "Mark as a workholding (fixture) layer";
      fixBtn.onclick = () => {
        this.pushHistory();
        layer.fixture = !layer.fixture;
        if (layer.fixture && !(layer.fixtureHeight && layer.fixtureHeight > 0))
          layer.fixtureHeight = 20;
        else if (!layer.fixture) layer.fixtureHeight = undefined;
        this.doc.emitChange();
      };
      row.appendChild(fixBtn);

      // Clamp height (mm above the stock top) — shown only for a fixture layer.
      if (layer.fixture) {
        const htInp = document.createElement("input");
        htInp.type = "number";
        htInp.min = "0";
        htInp.step = "1";
        htInp.value = String(layer.fixtureHeight ?? 20);
        htInp.className = "dim";
        htInp.style.width = "42px";
        htInp.title = "Clamp height above the stock top (mm) — rapids must clear this";
        htInp.onchange = () => {
          this.pushHistory();
          const v = parseFloat(htInp.value);
          layer.fixtureHeight = Number.isFinite(v) && v > 0 ? v : undefined;
          this.doc.emitChange();
        };
        row.appendChild(htInp);
      }

      // Beam recipe toggle — laser documents only, and never on a fixture layer
      // (a clamp isn't cut, so power/speed for it would be meaningless).
      if (this.doc.isLaser && !layer.fixture) {
        const beamBtn = document.createElement("button");
        beamBtn.className = "icon-btn layer-beam-toggle";
        beamBtn.innerHTML = "⚡";
        beamBtn.style.opacity = layer.laser ? "1" : "0.35";
        beamBtn.title = layer.laser
          ? "This layer sets its own power and speed — click to let each toolpath keep its own"
          : "Give this layer its own power and speed, shared by every toolpath that cuts it";
        beamBtn.onclick = () => {
          this.pushHistory();
          layer.laser = layer.laser
            ? undefined
            : // The same numbers a new operation would have used anyway, so
              // enabling a recipe changes nothing until the user tunes it. See
              // cam/laserPresets.ts for why nothing here ships pre-seeded with
              // material figures somebody might trust.
              {
                feedrate: DEFAULTS.feedrate,
                laserPower: DEFAULTS.laserPower,
                laserPasses: DEFAULTS.laserPasses,
              };
          this.doc.emitChange();
        };
        row.appendChild(beamBtn);
      }

      // Delete button
      const delBtn = document.createElement("button");
      delBtn.className = "icon-btn danger";
      delBtn.innerHTML = "🗑";
      delBtn.title = "Delete Layer";
      delBtn.disabled = this.doc.layers.length <= 1;
      delBtn.style.opacity = delBtn.disabled ? "0.3" : "1";
      delBtn.onclick = async () => {
        if (this.doc.layers.length <= 1) return;

        const entsOnLayer = this.doc.entities.filter((e) => e.layerId === layer.id);
        if (entsOnLayer.length > 0) {
          const ops = getAssociatedOperations(this.doc.operations, entsOnLayer.map((e) => e.id));
          const opsNote = ops.length > 0
            ? `\n\nWarning: ${entsOnLayer.length > 1 ? "Objects on this layer are" : "An object on this layer is"} associated with toolpath${ops.length > 1 ? "s" : ""}:\n${[...new Set(ops.map((o) => o.name))].map((n) => `• ${n}`).join("\n")}`
            : "";
          const ok = await confirmDialog({
            title: "Delete layer?",
            message: `Layer "${layer.name}" contains ${entsOnLayer.length} object${entsOnLayer.length > 1 ? "s" : ""}.\nDeleting the layer deletes them too.${opsNote}`,
            confirmLabel: "Delete",
            danger: true,
          });
          if (!ok) return;
        }

        this.pushHistory();

        // Remove entities on this layer
        this.doc.entities = this.doc.entities.filter((e) => e.layerId !== layer.id);

        // Remove layer
        this.doc.layers = this.doc.layers.filter((l) => l.id !== layer.id);

        // Reset active layer if we deleted the active one
        if (this.doc.activeLayerId === layer.id) {
          this.doc.activeLayerId = this.doc.layers[0].id;
        }

        this.doc.emitChange();
      };
      row.appendChild(delBtn);

      this.listEl.appendChild(row);

      if (this.doc.isLaser && !layer.fixture && layer.laser)
        this.listEl.appendChild(this.beamRow(layer));
    }
  }

  /**
   * The beam recipe editor for one layer: power, speed, passes, and a picker to
   * fill them from a saved material preset. Sits under its layer's row so the
   * relationship is obvious, and edits are live — every toolpath cutting this
   * layer picks the numbers up at export (cam/types.ts `resolveOpLaser`), which
   * is the point: re-tune once after a test cut, not once per operation.
   */
  private beamRow(layer: LayerDef): HTMLElement {
    const unit = this.doc.displayUnit;
    const wrap = document.createElement("div");
    wrap.className = "layer-beam-row";

    // Two short lines rather than one long one: the layers panel is ~210px wide,
    // and a single row of three fields plus their units overflowed — the power
    // field clipped "100" to "1(" and the passes suffix wrapped onto its own line.
    const line = (): HTMLElement => {
      const el = document.createElement("div");
      el.className = "layer-beam-line";
      wrap.appendChild(el);
      return el;
    };

    const num = (
      value: string,
      width: string,
      title: string,
      commit: (v: number) => void,
    ): HTMLInputElement => {
      const inp = document.createElement("input");
      inp.type = "number";
      inp.className = "dim";
      inp.value = value;
      inp.style.width = width;
      inp.title = title;
      inp.min = "0";
      inp.onchange = () => {
        const v = parseFloat(inp.value);
        if (!Number.isFinite(v) || v < 0) return void this.render(); // reject, restore
        this.pushHistory();
        commit(v);
        this.doc.emitChange();
      };
      return inp;
    };

    const recipe = layer.laser;
    if (!recipe) return wrap;

    const unitTag = (t: string) => {
      const s = document.createElement("span");
      s.textContent = t;
      return s;
    };

    line().append(
      num(String(recipe.laserPower), "38px", "Beam power, % of machine maximum", (v) => {
        recipe.laserPower = Math.min(100, v);
      }),
      unitTag("%"),
      num(
        String(round3(fromMM(recipe.feedrate, unit))),
        "58px",
        `Cutting speed, ${unit}/min`,
        (v) => {
          recipe.feedrate = toMM(v, unit);
        },
      ),
      unitTag(`${unit}/min`),
    );

    const second = line();
    second.append(
      num(String(recipe.laserPasses), "38px", "How many times the beam re-traces each path", (v) => {
        recipe.laserPasses = Math.max(1, Math.round(v));
      }),
      unitTag(recipe.laserPasses === 1 ? "pass" : "passes"),
    );

    // Fill from a saved recipe. Every kind is offered, labelled — a layer isn't
    // itself a cut or an engrave, so narrowing the list the way the toolpath
    // dialog does would hide the very preset the user saved for this colour.
    const presets = loadPresets();
    if (presets.length > 0) {
      const sel = document.createElement("select");
      sel.className = "dim layer-beam-preset";
      sel.title = "Fill power, speed and passes from a saved material preset";
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Preset…";
      sel.appendChild(placeholder);
      for (const p of presets) {
        const o = document.createElement("option");
        o.value = p.id;
        o.textContent = `${p.name} (${p.kind})`;
        sel.appendChild(o);
      }
      sel.onchange = () => {
        const p = presets.find((x) => x.id === sel.value);
        if (!p) return;
        this.pushHistory();
        // Copied by value, exactly as the toolpath dialog applies one: the
        // document must not hold a reference to a recipe living in this
        // browser's localStorage.
        layer.laser = {
          feedrate: p.feedrate,
          laserPower: p.laserPower,
          laserPasses: p.laserPasses,
          ...(p.kerfWidth !== undefined ? { kerfWidth: p.kerfWidth } : {}),
          ...(p.airAssist !== undefined ? { airAssist: p.airAssist } : {}),
        };
        this.doc.emitChange();
      };
      second.appendChild(sel);
    }

    return wrap;
  }
}

/** Trim float noise from a unit conversion without hiding a real decimal. */
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
