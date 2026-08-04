import { evalExpr } from "../core/expr";
import { listFonts } from "../core/fontManager";
import { regularPolygonPoints } from "../core/geom";
import { getImageEntry } from "../core/imageManager";
import {
  applyFlipH,
  applyFlipV,
  applyRotate,
  applyScale,
  selectionBounds,
} from "../core/transform";
import { formatAngle, formatLength, parseAngle, parseLength } from "../core/units";
import { GENERATORS } from "../generators/index";
import { findBinding } from "../model/bindings";
import type { Constraint, ConstraintType, PointRef } from "../model/constraints";
import { type Dimension, type DimensionType, makeDimension } from "../model/dimensions";
import { ORIGIN_ENTITY_ID, type CADDocument, type GroupDef } from "../model/document";
import {
  ArcEntity,
  type EntityId,
  type Bounds,
  CircleEntity,
  type Entity,
  LineEntity,
  PolylineEntity,
  RasterImageEntity,
  RectEntity,
  TextEntity,
} from "../model/entities";
import { nextId } from "../model/ids";
import { type Variable, varMap } from "../model/variables";
import type { PreviewShape } from "../view/overlay";
import { ContextMenu, type ContextMenuEntry } from "./contextMenu";
import { openGeneratorDialog } from "./generatorDialog";

/**
 * Menu entries for the ƒx variable picker: a clickable row per variable (drives
 * the field by that variable via `onPick`), or a single disabled hint when the
 * document has none. Pure, so the picker's contents are unit-testable without DOM.
 */
export function varPickerEntries(
  variables: readonly Variable[],
  onPick: (name: string) => void,
): ContextMenuEntry[] {
  if (variables.length === 0) {
    return [
      { label: "No variables yet — add one in Variables below", enabled: false, onClick: () => {} },
    ];
  }
  const entries: ContextMenuEntry[] = [
    { label: "Drive by variable:", enabled: false, onClick: () => {} },
  ];
  for (const v of variables) {
    entries.push({ label: `${v.name} = ${v.value}`, onClick: () => onPick(v.name) });
  }
  return entries;
}

const DIM_LABELS: Record<DimensionType, string> = {
  distance: "Distance",
  horizontal: "Horizontal",
  vertical: "Vertical",
  radius: "Radius",
  diameter: "Diameter",
  angle: "Angle",
  arclength: "Arc Length",
  "line-distance": "Point to Line",
  "circle-gap": "Circle Gap",
  "angle-x": "Angle to X",
  "arc-sweep": "Arc Sweep",
};

const CON_LABELS: Record<ConstraintType, string> = {
  coincident: "Coincident",
  horizontal: "Horizontal",
  vertical: "Vertical",
  parallel: "Parallel",
  perpendicular: "Perpendicular",
  equal: "Equal",
  concentric: "Concentric",
  pointOnLine: "Point on Line",
  tangent: "Tangent",
  pointOnArc: "Point on Arc",
  pointOnCircle: "Point on Circle",
  symmetric: "Symmetric",
  collinear: "Collinear",
  midpoint: "Midpoint",
  angle: "Angle",
  fixedPoint: "Fixed Point",
  center: "Center",
  fixed: "Fixed",
};

export class PropertiesBar {
  private content!: HTMLElement;
  private constructionBtn!: HTMLButtonElement;
  private isCollapsed = false;
  /** Aspect lock for the Transform > Scale section (distinct from an image
   *  entity's own `aspectLocked`, which persists on the entity). */
  private scaleLocked = true;
  private transformCollapsed = true;
  /** Shared popup for the ƒx badge's "drive by a variable" picker. */
  private readonly fxMenu = new ContextMenu();

  constructor(
    private host: HTMLElement,
    private doc: CADDocument,
    private pushHistory: () => void,
    private solve: () => void,
    private onConstructionToggle: () => void,
    private commitDimValue: (dim: Dimension, v: number, expr?: string) => boolean,
    /** Ghost-preview sink for the feature Edit… dialog (App's generatorPreviewSink). */
    private onGeneratorPreview?: (shapes: PreviewShape[] | null) => void,
  ) {
    this.build();
    this.doc.onChange(() => this.refresh());
    this.refresh();
  }

  private build(): void {
    this.host.innerHTML = "";

    const header = document.createElement("div");
    header.className = "props-header";

    const title = document.createElement("div");
    title.className = "props-title";
    title.textContent = "Properties";
    header.appendChild(title);

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "props-toggle";
    toggleBtn.textContent = "›";
    toggleBtn.title = "Collapse/Expand";
    toggleBtn.addEventListener("click", () => this.toggleCollapse());
    header.appendChild(toggleBtn);

    this.host.appendChild(header);

    this.content = document.createElement("div");
    this.content.className = "props-content";

    this.constructionBtn = document.createElement("button");
    this.constructionBtn.className = "btn props-construction-btn";
    this.constructionBtn.innerHTML =
      '<input type="checkbox" class="cm-checkbox" style="pointer-events: none;"> Construction Mode';
    this.constructionBtn.title =
      "New shapes are drawn as construction geometry until this is off again (X)";
    this.constructionBtn.addEventListener("click", () => this.onConstructionToggle());

    this.host.appendChild(this.content);
  }

  private toggleCollapse(): void {
    this.isCollapsed = !this.isCollapsed;
    if (this.isCollapsed) {
      this.host.classList.add("collapsed");
    } else {
      this.host.classList.remove("collapsed");
    }
    this.host.addEventListener(
      "transitionend",
      () => {
        window.dispatchEvent(new Event("resize"));
      },
      { once: true },
    );
  }

  private refresh(): void {
    this.content.innerHTML = "";
    const selected = this.doc.selected;
    // The "next shapes drawn are construction" MODE only means something when
    // nothing is selected — with a selection, construction is a property of
    // the selected entity/entities instead (shown in its own section below, or
    // toggled via the X hotkey / right-click for a multi-selection).
    if (selected.length === 0) {
      this.content.appendChild(this.constructionBtn);
      this.constructionBtn.classList.toggle("active", this.doc.isConstructionMode);
      const cb = this.constructionBtn.querySelector(".cm-checkbox") as HTMLInputElement | null;
      if (cb) cb.checked = this.doc.isConstructionMode;
    }

    const selDim = this.doc.selectedDimensionId
      ? (this.doc.dimensions.find((d) => d.id === this.doc.selectedDimensionId) ?? null)
      : null;
    const selCon = this.doc.selectedConstraintId
      ? (this.doc.constraints.find((c) => c.id === this.doc.selectedConstraintId) ?? null)
      : null;

    if (selected.length === 0 && !selDim && !selCon) {
      const empty = document.createElement("div");
      empty.className = "props-empty";
      empty.innerHTML = `
        <div class="empty-icon">⬚</div>
        <div>Select an object to edit its properties.</div>
      `;
      this.content.appendChild(empty);
      return;
    }

    // A dimension or constraint is selected (entities are cleared in that case).
    if (selDim) this.buildDimensionSection(selDim);
    if (selCon) this.buildConstraintSection(selCon);
    if (selected.length === 0) return;

    const bounds = selectionBounds(selected);
    if (!bounds) return;

    // Group / Create Group
    const selectedIds = new Set(selected.map((e) => e.id));
    let involvedGroup: GroupDef | null = null;
    for (const e of selected) {
      const g = this.doc.groupOf(e.id);
      if (g) {
        involvedGroup = g;
        break;
      }
    }
    if (involvedGroup) {
      const fullySelected = involvedGroup.entityIds.every((id) => selectedIds.has(id));
      this.buildGroupSection(involvedGroup, fullySelected);
    } else if (selected.length >= 2) {
      this.buildCreateGroupSection();
    }

    // Entity-specific properties (single selection only)
    if (selected.length === 1) {
      this.buildEntityPropertiesSection(selected[0]);
    }

    // Layer
    this.buildLayerSection(selected);

    // Transform (collapsible)
    this.buildTransformSection(bounds, selected);
  }

  // ---------------------------------------------------------------------------
  // Entity-specific properties

  private buildEntityPropertiesSection(entity: Entity): void {
    if (entity instanceof TextEntity) {
      this.buildTextProperties(entity);
    } else if (entity instanceof CircleEntity) {
      this.buildCircleProperties(entity);
    } else if (entity instanceof ArcEntity) {
      this.buildArcProperties(entity);
    } else if (entity instanceof LineEntity) {
      this.buildLineProperties(entity);
    } else if (entity instanceof RectEntity) {
      this.buildRectProperties(entity);
    } else if (entity instanceof PolylineEntity) {
      this.buildPolylineProperties(entity);
    } else if (entity instanceof RasterImageEntity) {
      this.buildImageProperties(entity);
    }
  }

  private buildImageProperties(entity: RasterImageEntity): void {
    const sec = this.createSection("IMAGE");

    // Source pixels + effective DPI at the current physical width — the engrave
    // resolution is bounded by this, so it tells the user how fine they can go.
    const e = getImageEntry(entity.imageId);
    const info = document.createElement("div");
    info.className = "props-row";
    const span = document.createElement("span");
    span.style.cssText = "opacity:0.65;font-size:11px;";
    span.textContent = e
      ? `${e.width}×${e.height}px · ~${Math.round(e.width / (entity.widthMM / 25.4))} dpi`
      : "⚠ image pixels not loaded";
    info.appendChild(span);
    sec.appendChild(info);

    // Width/Height/Angle are ordinary scalar DOFs driven through the shared
    // binding engine (a formula like "plateW/2" becomes a ScalarBinding on the
    // solver, same channel as circle radius). Aspect-lock is an edit-time
    // cross-link: editing one side writes a proportional value/formula to the
    // other (baked at the current ratio), so both re-evaluate together on a
    // variable change and the proportion holds — no solver ratio-constraint.
    const aspect = entity.heightMM !== 0 ? entity.widthMM / entity.heightMM : 1;
    // Set the paired scalar within the caller's edit: a formula → mirror binding,
    // a literal → clear the binding and set the value directly.
    const setPaired = (key: string, value: number, expr: string | undefined) => {
      const existing = findBinding(this.doc.bindings, entity.id, key);
      if (expr) {
        if (existing) existing.expr = expr;
        else
          this.doc.bindings.push({ id: nextId("bind"), entityId: entity.id, scalarKey: key, expr });
      } else {
        if (existing) this.doc.bindings = this.doc.bindings.filter((b) => b !== existing);
        entity.setScalar(key, value);
      }
    };
    this.bindingRow(
      sec,
      "Width",
      entity.id,
      "w",
      entity.widthMM,
      "mm",
      (v) => entity.setScalar("w", v),
      3,
      1,
      (v, expr) => {
        if (entity.aspectLocked)
          setPaired("h", v / aspect, expr ? `(${expr})/${aspect}` : undefined);
      },
    );
    this.bindingRow(
      sec,
      "Height",
      entity.id,
      "h",
      entity.heightMM,
      "mm",
      (v) => entity.setScalar("h", v),
      3,
      1,
      (v, expr) => {
        if (entity.aspectLocked)
          setPaired("w", v * aspect, expr ? `(${expr})*${aspect}` : undefined);
      },
    );

    const lockRow = document.createElement("div");
    lockRow.className = "props-row";
    const lockLbl = document.createElement("span");
    lockLbl.textContent = "Lock aspect";
    lockLbl.title =
      "Keep the image's proportions. Applies to both edits and constraints: " +
      "typing one of width/height writes a proportional value to the other, and a " +
      "constraint-driven resize scales uniformly.";
    const lockCb = document.createElement("input");
    lockCb.type = "checkbox";
    lockCb.checked = entity.aspectLocked;
    lockCb.addEventListener("change", () => {
      this.applyEdit(() => {
        entity.aspectLocked = lockCb.checked;
      });
    });
    lockRow.append(lockLbl, lockCb);
    sec.appendChild(lockRow);

    // What constraints/dimensions may change about the image. Both off (the
    // default) is a rigid body — a corner constraint just moves it. Resize turns
    // a driving dimension on the image into a calibration; rotate lets an edge be
    // levelled. They're separate because each freedom lets the solver satisfy the
    // OTHER's constraint the wrong way (tilt instead of scale; shrink instead of
    // turn), so granting only what the intent needs keeps the fit honest.
    const fitRow = document.createElement("div");
    fitRow.className = "props-row";
    const fitLbl = document.createElement("span");
    fitLbl.textContent = "Constraints may";
    fitLbl.title =
      "What a constraint or dimension is allowed to change about this image.\n" +
      "Neither: the image is rigid — constraints move it.\n" +
      "Resize: e.g. dimension a known distance on a scan to calibrate it " +
      "(uniformly, unless Lock aspect is off).\n" +
      "Rotate: e.g. make an edge horizontal to level a tilted scan.\n" +
      "Grant only what you need — spare freedom lets the solver satisfy a " +
      "constraint the wrong way (tilting to meet a size, or shrinking to meet an " +
      "angle).";
    const fitControls = document.createElement("span");
    fitControls.style.cssText = "display:flex;gap:10px;align-items:center;";
    const freedom: [string, "constraintResize" | "constraintRotate"][] = [
      ["resize", "constraintResize"],
      ["rotate", "constraintRotate"],
    ];
    for (const [label, prop] of freedom) {
      const wrap = document.createElement("label");
      wrap.style.cssText = "display:flex;gap:4px;align-items:center;font-size:11px;";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = entity[prop];
      cb.addEventListener("change", () => {
        this.applyEdit(() => {
          entity[prop] = cb.checked;
        });
      });
      wrap.append(cb, document.createTextNode(label));
      fitControls.appendChild(wrap);
    }
    fitRow.append(fitLbl, fitControls);
    sec.appendChild(fitRow);

    this.originCoordRow(sec, "X", "x", entity.id, "pos", entity.position.x, (v) => {
      entity.position = { x: v, y: entity.position.y };
    });
    this.originCoordRow(sec, "Y", "y", entity.id, "pos", entity.position.y, (v) => {
      entity.position = { x: entity.position.x, y: v };
    });

    // Angle — degrees (stored as radians); the engrave/relief sweeps along the
    // image's rotated rows, so this is honoured in the toolpath. The π/180 scale
    // lets the formula read in degrees while the "angle" DOF stays radians.
    this.bindingRow(
      sec,
      "Angle",
      entity.id,
      "angle",
      (entity.angle * 180) / Math.PI,
      "°",
      (v) => entity.setScalar("angle", (v * Math.PI) / 180),
      1,
      Math.PI / 180,
    );

    this.constructionRow(sec, entity);
    this.content.appendChild(sec);
  }

  // ---------------------------------------------------------------------------
  // Dimension / constraint properties

  private buildDimensionSection(dim: Dimension): void {
    const sec = this.createSection(`DIMENSION · ${DIM_LABELS[dim.type]}`);
    const isAngle = dim.type === "angle";

    const row = document.createElement("div");
    row.className = "props-row";
    const lbl = document.createElement("span");
    lbl.textContent = "Value";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.style.flex = "1";
    inp.value =
      !isAngle && dim.expr
        ? dim.expr
        : isAngle
          ? formatAngle(dim.value)
          : formatLength(dim.value, this.doc.displayUnit);
    // Flag a driving dimension whose formula no longer evaluates (a deleted variable) —
    // it silently keeps its last value otherwise, which would post a wrong toolpath.
    const broken =
      !!dim.expr && evalExpr(dim.expr, varMap(this.doc.variables, this.doc.stockThickness)) === null;
    if (broken) inp.style.borderColor = "var(--danger, #e05555)";
    inp.addEventListener("change", () => {
      const raw = inp.value.trim();
      let v: number | null = null;
      let expr: string | undefined;
      if (isAngle) {
        v = parseAngle(raw);
      } else {
        v = parseLength(raw, this.doc.displayUnit);
        if (v === null) {
          const ev = evalExpr(raw, varMap(this.doc.variables, this.doc.stockThickness));
          if (ev !== null) {
            v = ev;
            expr = raw;
          }
        }
      }
      if (v === null || v <= 0) {
        this.flashInput(inp);
        return;
      }
      if (!this.commitDimValue(dim, v, expr)) this.flashInput(inp);
    });
    row.appendChild(lbl);
    row.appendChild(inp);
    // Angle dimensions take no formula, so they get no name suggestions either.
    if (!isAngle) this.attachVarAutocomplete(inp, row);
    // Angle dimensions don't support formulas at all (see the isAngle branches
    // above) — no picker to offer there. Every other type already can via
    // dim.expr; it just had no way to find a variable's name short of typing it
    // blind, unlike every scalar/binding field's ƒx badge.
    if (!isAngle) {
      row.appendChild(
        this.fxBadge({
          input: inp,
          bound: !!dim.expr && !broken,
          broken,
          boundExpr: dim.expr,
          onUnbind: () => {
            if (!this.commitDimValue(dim, dim.value, undefined)) this.flashInput(inp);
          },
        }),
      );
    }
    sec.appendChild(row);

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:4px;margin-top:4px;";

    const drivingBtn = document.createElement("button");
    drivingBtn.className = dim.driving ? "btn active" : "btn";
    drivingBtn.style.flex = "1";
    drivingBtn.textContent = dim.driving ? "Driving" : "Reference";
    drivingBtn.title =
      "Driving dimensions force the geometry; reference dimensions only measure it";
    drivingBtn.addEventListener("click", () => {
      this.applyEdit(() => {
        dim.driving = !dim.driving;
      });
    });

    const delBtn = document.createElement("button");
    delBtn.className = "btn";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => {
      this.pushHistory();
      this.doc.removeDimension(dim.id);
      this.solve();
    });

    btnRow.append(drivingBtn, delBtn);

    if (dim.textOffset) {
      const resetPosBtn = document.createElement("button");
      resetPosBtn.className = "btn";
      resetPosBtn.textContent = "Reset Text";
      resetPosBtn.title = "Reset label position back to default";
      resetPosBtn.addEventListener("click", () => {
        this.pushHistory();
        delete dim.textOffset;
        this.doc.emitChange();
      });
      btnRow.appendChild(resetPosBtn);
    }

    sec.appendChild(btnRow);
    this.content.appendChild(sec);
  }

  private buildConstraintSection(con: Constraint): void {
    const sec = this.createSection("CONSTRAINT");

    const typeRow = document.createElement("div");
    typeRow.className = "props-row";
    const lbl = document.createElement("span");
    lbl.textContent = "Type";
    const val = document.createElement("input");
    val.type = "text";
    val.disabled = true;
    val.style.flex = "1";
    val.value = CON_LABELS[con.type] ?? con.type;
    typeRow.append(lbl, val);
    sec.appendChild(typeRow);

    // The angle constraint carries an editable target (radians in params[0]).
    if (con.type === "angle" && con.params && con.params.length > 0) {
      this.numRow(
        sec,
        "Angle",
        (con.params[0] * 180) / Math.PI,
        "°",
        (v) => {
          this.applyEdit(() => {
            con.params![0] = (v * Math.PI) / 180;
          });
        },
        1,
      );
    }

    const delBtn = document.createElement("button");
    delBtn.className = "btn";
    delBtn.style.cssText = "width:100%;margin-top:4px;";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => {
      this.pushHistory();
      this.doc.removeConstraint(con.id);
      this.solve();
    });
    sec.appendChild(delBtn);
    this.content.appendChild(sec);
  }

  // ---------------------------------------------------------------------------
  // Small editable-field helpers

  /** Push history, mutate geometry, re-solve, and refresh. */
  private applyEdit(mutate: () => void): void {
    this.pushHistory();
    mutate();
    this.solve();
    this.doc.emitChange();
  }

  /** "Construction" checkbox — a property of THIS entity (reference geometry
   *  shown for snapping/layout but excluded from toolpaths and export). Never
   *  touches doc.isConstructionMode: that's the separate mode governing what
   *  NEW shapes are drawn as, not what an already-drawn one currently is. */
  private constructionRow(sec: HTMLElement, entity: Entity): void {
    const row = document.createElement("div");
    row.className = "props-row";
    const lbl = document.createElement("span");
    lbl.textContent = "Construction";
    lbl.title = "Reference geometry — excluded from toolpaths and export.";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = entity.isConstruction;
    cb.addEventListener("change", () => {
      this.pushHistory();
      entity.isConstruction = cb.checked;
      this.doc.emitChange();
    });
    row.append(lbl, cb);
    sec.appendChild(row);
  }

  /** A "Label [input] unit" row whose input commits a parsed number on change. */
  private numRow(
    parent: HTMLElement,
    label: string,
    value: number,
    unit: string | null,
    onCommit: (v: number) => void,
    decimals = 3,
  ): void {
    const row = document.createElement("div");
    row.className = "props-row";
    const lbl = document.createElement("span");
    lbl.textContent = label;
    // A row declared in "mm" is a length → display and parse in the document's
    // unit (formatLength/parseLength); other units (counts, °) pass through.
    const du = this.doc.displayUnit;
    const isLen = unit === "mm";
    const fmt = (v: number) => (isLen ? formatLength(v, du, decimals) : v.toFixed(decimals));
    const inp = document.createElement("input");
    inp.type = "text";
    inp.style.flex = "1";
    inp.value = fmt(value);
    inp.addEventListener("change", () => {
      const v = isLen ? parseLength(inp.value, du) : parseFloat(inp.value);
      if (v === null || Number.isNaN(v)) {
        inp.value = fmt(value);
        return;
      }
      onCommit(v);
    });
    row.append(lbl, inp);
    const unitLabel = isLen ? du : unit;
    if (unitLabel) {
      const u = document.createElement("span");
      u.textContent = unitLabel;
      row.appendChild(u);
    }
    parent.appendChild(row);
  }

  /**
   * The `ƒx` affordance for a parametric field. Unlike the old badge it is
   * ALWAYS visible — dimmed when the field holds a plain number — so a first-time
   * user can SEE that the field accepts a formula. (Audit #3: the badge used to
   * appear only AFTER you already knew to type a variable name, so the whole
   * feature was invisible.) States:
   *   - literal (unbound): dim `ƒx`; click opens the variable picker.
   *   - bound: accent `ƒx`; click unbinds (`onUnbind`).
   *   - broken: danger `⚠`; click unbinds.
   */
  /**
   * Native type-ahead for variable names on a field that accepts a formula.
   *
   * The ƒx badge next to these fields is a *click-to-pick* popup; it does
   * nothing for someone who has started typing. The on-canvas dimension editor
   * has offered a `<datalist>` since it was written (see ui/dimEditor.ts), so
   * typing `wid` there suggests `width` while the identical field in this panel
   * suggested nothing — reported as "Rectangle H and W in properties does not
   * have auto complete for variable".
   *
   * Same name set as the dimension editor, `varMap` — which includes the
   * implicit `stock` (stock thickness) alongside the document's own variables,
   * so the two surfaces cannot disagree about what is in scope.
   *
   * The datalist is parented to the ROW, so the panel's next rebuild disposes of
   * it along with everything else; there is no separate cleanup to forget.
   */
  private attachVarAutocomplete(input: HTMLInputElement, row: HTMLElement): void {
    const names = [...varMap(this.doc.variables, this.doc.stockThickness).keys()];
    if (names.length === 0) return;
    const dl = document.createElement("datalist");
    dl.id = `_pv-${Math.random().toString(36).slice(2)}`;
    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = name;
      dl.appendChild(opt);
    }
    row.appendChild(dl);
    input.setAttribute("list", dl.id);
  }

  private fxBadge(opts: {
    input: HTMLInputElement;
    bound: boolean;
    broken: boolean;
    boundExpr?: string;
    onUnbind: () => void;
  }): HTMLSpanElement {
    const { input, bound, broken } = opts;
    const active = bound || broken;
    const badge = document.createElement("span");
    badge.textContent = broken ? "⚠" : "ƒx";
    const color = broken
      ? "var(--danger,#e05555)"
      : bound
        ? "var(--accent,#5b9)"
        : "var(--text-dim,#8b909c)";
    badge.style.cssText = `cursor:pointer;font-style:italic;padding:0 4px;color:${color};opacity:${active ? 0.95 : 0.5};`;
    badge.title = broken
      ? `Broken formula (unknown variable?): ${opts.boundExpr ?? ""} — click to unbind`
      : bound
        ? `Driven by formula: ${opts.boundExpr} (click to unbind)`
        : "Click to drive this with a variable or formula (e.g. width/2)";
    badge.addEventListener("click", (e) => {
      if (active) opts.onUnbind();
      else this.openVarPicker(e, input);
    });
    return badge;
  }

  /**
   * Popup anchored at the ƒx badge that lists the document's variables; clicking
   * one drives the field by it (fills the input and commits the same change a
   * user would by typing the name). With no variables, a single hint points at
   * the Variables panel — so the path from "I want this parametric" to a working
   * formula is always visible.
   */
  private openVarPicker(e: MouseEvent, input: HTMLInputElement): void {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const entries = varPickerEntries(this.doc.variables, (name) => {
      input.value = name;
      input.dispatchEvent(new Event("change"));
    });
    this.fxMenu.show(rect.left, rect.bottom + 2, entries);
  }

  /**
   * A scalar property row backed by the parametric engine. Enter a **formula**
   * referencing variables (e.g. `plateW/2`) and it creates/updates a headless
   * `ScalarBinding` on `(entityId, scalarKey)`, so the SOLVER drives the value
   * (unified with dimensions/constraints — no second channel). A plain number
   * clears the binding and applies a literal. An engine-driven field shows an
   * `ƒx` badge (hover = the formula, click = unbind back to a literal).
   */
  private bindingRow(
    parent: HTMLElement,
    label: string,
    entityId: string,
    scalarKey: string,
    currentValue: number,
    unit: string | null,
    applyLiteral: (v: number) => void,
    decimals = 3,
    scale = 1,
    // Fires inside the same edit after a literal or formula commits, with the
    // committed value and raw expr (undefined for a literal). Images use it to
    // propagate an aspect-locked edit to the paired dimension.
    onAfterCommit?: (value: number, expr: string | undefined) => void,
  ): void {
    const binding = findBinding(this.doc.bindings, entityId, scalarKey);
    // A field declared in "mm" is a length: show and read its literal in the
    // document's unit (formulas over variables always evaluate in internal mm).
    const du = this.doc.displayUnit;
    const isLen = unit === "mm";
    const fmtLit = (v: number) =>
      isLen ? formatLength(v, du, decimals) : (v / scale).toFixed(decimals);
    const row = document.createElement("div");
    row.className = "props-row";
    const lbl = document.createElement("span");
    lbl.textContent = label;
    const inp = document.createElement("input");
    inp.type = "text";
    inp.style.flex = "1";
    inp.value = binding ? binding.expr : fmtLit(currentValue);
    inp.title = "Enter a number, or a formula over variables (e.g. width/2) to drive it";
    this.attachVarAutocomplete(inp, row);
    // A binding whose formula no longer evaluates (e.g. a referenced variable was
    // deleted) is flagged red — the value silently held its last number otherwise.
    const broken = !!binding && evalExpr(binding.expr, varMap(this.doc.variables, this.doc.stockThickness)) === null;
    if (broken) inp.style.borderColor = "var(--danger, #e05555)";
    const reset = () => {
      const b = findBinding(this.doc.bindings, entityId, scalarKey);
      inp.value = b ? b.expr : fmtLit(currentValue);
    };

    const badge = this.fxBadge({
      input: inp,
      bound: !!binding && !broken,
      broken,
      boundExpr: binding?.expr,
      onUnbind: () => {
        const b = findBinding(this.doc.bindings, entityId, scalarKey);
        if (b)
          this.applyEdit(() => {
            this.doc.bindings = this.doc.bindings.filter((x) => x !== b);
          });
      },
    });

    inp.addEventListener("change", () => {
      const raw = inp.value.trim();
      const existing = findBinding(this.doc.bindings, entityId, scalarKey);
      if (raw === "") {
        reset();
        return;
      }
      // Literal vs formula. For a length field parseLength also accepts inch
      // fractions/suffixes ("1/2", "0.5in") and converts to internal mm; a plain
      // number is read in the document's unit. Anything else is a formula (which
      // always evaluates in mm, since variables are stored in mm).
      const lit = isLen
        ? parseLength(raw, du)
        : /^-?\d*\.?\d+$/.test(raw)
          ? parseFloat(raw)
          : null;
      if (lit !== null) {
        // literal → clear binding + set value
        this.applyEdit(() => {
          if (existing) this.doc.bindings = this.doc.bindings.filter((x) => x !== existing);
          applyLiteral(lit);
          onAfterCommit?.(lit, undefined);
        });
        return;
      }
      const ev = evalExpr(raw, varMap(this.doc.variables, this.doc.stockThickness));
      if (ev === null) {
        this.flashInput(inp);
        reset();
        return;
      }
      this.applyEdit(() => {
        // formula → create/update the binding
        if (existing) existing.expr = raw;
        else
          this.doc.bindings.push({
            id: nextId("bind"),
            entityId,
            scalarKey,
            expr: raw,
            ...(scale !== 1 ? { scale } : {}),
          });
        onAfterCommit?.(ev, raw);
      });
    });

    row.append(lbl, inp, badge);
    const unitLabel = isLen ? du : unit;
    if (unitLabel) {
      const u = document.createElement("span");
      u.textContent = unitLabel;
      row.appendChild(u);
    }
    parent.appendChild(row);
  }

  /**
   * Like {@link bindingRow} but for a *measurement* property (line length, rect
   * W/H) that has no scalar DOF — the formula parks in a **hidden driving
   * dimension** of `dimType` between `points`. Reuses the whole dimension engine
   * (solver residual, prune, rename) — it just isn't drawn. A plain number clears
   * the hidden dim and calls `applyLiteral` (the entity's own resize).
   */
  private hiddenDimRow(
    parent: HTMLElement,
    label: string,
    dimType: DimensionType,
    points: PointRef[],
    currentValue: number,
    unit: string | null,
    applyLiteral: (v: number) => void,
    decimals = 3,
    /**
     * True when the field is a POSITION rather than a size. Sizes (W/H, radius,
     * length) are rejected at <= 0 because there is no such shape; a coordinate
     * has no such rule — x = 0 is the origin and x = -10 is to the left of it —
     * and applying the size rule to coordinates silently reverted them.
     */
    allowNonPositive = false,
    /**
     * `entities` switches the row to an ENTITY-referenced dimension (an angle to
     * the X axis names one line, not a pair of points); `scale` converts the
     * displayed unit to the stored one, so an angle can read in degrees while
     * `Dimension.value` stays radians.
     */
    opts: { entities?: EntityId[]; scale?: number } = {},
  ): void {
    const byEntities = opts.entities;
    const scale = opts.scale ?? 1;
    const pkey = (p: PointRef) => `${p.entityId}:${p.key}`;
    const wantKeys = new Set(points.map(pkey));
    // Match ANY driving dimension of this measurement (hidden OR a user's visible
    // one) so the field reflects/edits it instead of adding a conflicting second
    // driver. Reference (non-driving) dims are ignored — they don't constrain.
    const findDim = () =>
      this.doc.dimensions.find((d) => {
        if (!d.driving || d.type !== dimType) return false;
        if (byEntities)
          return (
            d.entities.length === byEntities.length &&
            d.entities.every((id) => byEntities.includes(id))
          );
        return (
          d.points.length === points.length && d.points.every((p) => wantKeys.has(pkey(p)))
        );
      });
    const dim = findDim();

    // A field declared in "mm" is a length: show/read its literal in the
    // document's unit (formulas over variables always evaluate in internal mm).
    const du = this.doc.displayUnit;
    const isLen = unit === "mm";
    const fmtLit = (mm: number) => (isLen ? formatLength(mm, du, decimals) : mm.toFixed(decimals));
    const row = document.createElement("div");
    row.className = "props-row";
    const lbl = document.createElement("span");
    lbl.textContent = label;
    const inp = document.createElement("input");
    inp.type = "text";
    inp.style.flex = "1";
    inp.value = dim?.expr ?? fmtLit(currentValue);
    inp.title = "Enter a number, or a formula over variables (e.g. width/2) to drive it";
    this.attachVarAutocomplete(inp, row);
    const broken = !!dim?.expr && evalExpr(dim.expr, varMap(this.doc.variables, this.doc.stockThickness)) === null;
    if (broken) inp.style.borderColor = "var(--danger, #e05555)";
    const reset = () => {
      const d = findDim();
      inp.value = d?.expr ?? fmtLit(currentValue);
    };

    // Only a formula-driven dim is "bound"; a plain-literal driving dimension has no formula.
    const badge = this.fxBadge({
      input: inp,
      bound: !!dim?.expr && !broken,
      broken,
      boundExpr: dim?.expr,
      onUnbind: () => {
        const d = findDim();
        if (!d) return;
        // Clearing our own hidden dim removes it; a user's visible dim is kept
        // (its formula is dropped, becoming a plain-value dimension) — don't delete it.
        this.applyEdit(() => {
          if (d.hidden) this.doc.dimensions = this.doc.dimensions.filter((x) => x !== d);
          else d.expr = undefined;
        });
      },
    });

    inp.addEventListener("change", () => {
      const raw = inp.value.trim();
      const existing = findDim();
      if (raw === "") {
        reset();
        return;
      }
      // Literal (length → document's unit, incl. inch fractions/suffixes) vs a
      // formula (always evaluated in internal mm).
      const lit = isLen
        ? parseLength(raw, du)
        : /^-?\d*\.?\d+$/.test(raw)
          ? parseFloat(raw)
          : null;
      if (lit !== null) {
        // `lit` is in the DISPLAY unit; dimensions store internal (mm, radians).
        const v = lit * scale;
        if (!allowNonPositive && v <= 0) {
          reset();
          return;
        }
        this.applyEdit(() => {
          if (existing?.hidden) {
            // our hidden dim → drop it and resize freely
            this.doc.dimensions = this.doc.dimensions.filter((x) => x !== existing);
            applyLiteral(v);
          } else if (existing) {
            // a visible dim already drives it → set its value
            existing.expr = undefined;
            existing.value = v;
          } else {
            // undriven → resize the geometry directly
            applyLiteral(v);
          }
        });
        return;
      }
      if (evalExpr(raw, varMap(this.doc.variables, this.doc.stockThickness)) === null) {
        this.flashInput(inp);
        reset();
        return;
      }
      this.applyEdit(() => {
        // formula → drive the existing dim, or a new hidden one
        if (existing) existing.expr = raw;
        else
          this.doc.dimensions.push(
            makeDimension(dimType, {
              ...(byEntities ? { entities: byEntities } : { points }),
              value: currentValue,
              offset: 0,
              driving: true,
              expr: raw,
              hidden: true,
            }),
          );
      });
    });

    row.append(lbl, inp, badge);
    const unitLabel = isLen ? du : unit;
    if (unitLabel) {
      const u = document.createElement("span");
      u.textContent = unitLabel;
      row.appendChild(u);
    }
    parent.appendChild(row);
  }

  /**
   * A single POSITION coordinate (Cx, Ax, image X, ...), formula-drivable via
   * {@link hiddenDimRow} — a horizontal/vertical hidden dimension from the WCS
   * origin (always world (0,0); see ORIGIN_ENTITY_ID) to this entity's own
   * point. Reuses the exact mechanism Length/W/H already use for the same
   * reason: a point's X/Y isn't a scalar DOF the ScalarBinding channel can
   * drive, but "distance from a fixed point" is exactly what a hidden
   * horizontal/vertical dimension already models.
   *
   * Because that dimension type measures |Δ|, a formula can't express a
   * negative coordinate this way — the same limitation any horizontal/
   * vertical dimension has, not something new here.
   */
  private originCoordRow(
    parent: HTMLElement,
    label: string,
    axis: "x" | "y",
    entityId: string,
    pointKey: string,
    currentValue: number,
    applyLiteral: (v: number) => void,
  ): void {
    this.hiddenDimRow(
      parent,
      label,
      axis === "x" ? "horizontal" : "vertical",
      [
        { entityId: ORIGIN_ENTITY_ID, key: "p" },
        { entityId, key: pointKey },
      ],
      currentValue,
      "mm",
      applyLiteral,
      3,
      true, // a coordinate: 0 and negatives are ordinary positions
    );
  }

  /** A two-field "Lx [x] Ly [y]" coordinate row committing both values together. */

  private flashInput(inp: HTMLInputElement): void {
    inp.style.borderColor = "#e05555";
    setTimeout(() => {
      inp.style.borderColor = "";
    }, 600);
  }

  private buildTextProperties(entity: TextEntity): void {
    const sec = this.createSection("TEXT");

    // Text content
    const textRow = document.createElement("div");
    textRow.className = "props-row";
    const textLbl = document.createElement("span");
    textLbl.textContent = "Text";
    const textIn = document.createElement("input");
    textIn.type = "text";
    textIn.value = entity.text;
    textIn.style.flex = "1";
    textIn.addEventListener("change", () => {
      // applyEdit re-solves, so a centring/alignment constraint re-flows the text
      // to fit the new string (its ink extents changed).
      this.applyEdit(() => {
        entity.text = textIn.value;
      });
    });
    textRow.append(textLbl, textIn);
    sec.appendChild(textRow);

    // Font
    const fontRow = document.createElement("div");
    fontRow.className = "props-row";
    const fontLbl = document.createElement("span");
    fontLbl.textContent = "Font";
    const fontSel = document.createElement("select");
    fontSel.className = "dim";
    fontSel.style.flex = "1";
    const known = listFonts();
    // If the entity's font isn't loaded, show that honestly instead of letting the
    // <select> silently display its first option as if it were the entity's font.
    if (!known.some((f) => f.id === entity.fontId)) {
      const opt = document.createElement("option");
      opt.value = entity.fontId;
      opt.textContent = `⚠ missing: ${entity.fontId}`;
      opt.selected = true;
      fontSel.appendChild(opt);
    }
    for (const f of known) {
      const opt = document.createElement("option");
      opt.value = f.id;
      opt.textContent = f.name;
      if (f.id === entity.fontId) opt.selected = true;
      fontSel.appendChild(opt);
    }
    fontSel.addEventListener("change", () => {
      this.applyEdit(() => {
        entity.fontId = fontSel.value;
      });
    });
    fontRow.append(fontLbl, fontSel);
    sec.appendChild(fontRow);

    // Size and Angle go through the binding engine, like an image's — so both
    // take a formula, show the ƒx badge and suggest variable names. They were
    // hand-rolled parseFloat inputs, which is why a label could not be sized
    // from a variable while an image could.
    this.bindingRow(
      sec,
      "Size",
      entity.id,
      "size",
      entity.sizeMM,
      "mm",
      (v) => entity.setScalar("size", v),
    );
    this.bindingRow(
      sec,
      "Angle",
      entity.id,
      "angle",
      (entity.angle * 180) / Math.PI,
      "°",
      (v) => entity.setScalar("angle", (v * Math.PI) / 180),
      1,
      // Formula reads in degrees; the "angle" DOF stays radians.
      Math.PI / 180,
    );

    this.constructionRow(sec, entity);
    this.content.appendChild(sec);
  }

  private buildCircleProperties(entity: CircleEntity): void {
    const sec = this.createSection("CIRCLE");
    this.bindingRow(sec, "Radius", entity.id, "r", entity.radius, "mm", (v) => {
      if (v > 0) entity.radius = v;
    });
    this.originCoordRow(sec, "Cx", "x", entity.id, "c", entity.center.x, (v) => {
      entity.center = { x: v, y: entity.center.y };
    });
    this.originCoordRow(sec, "Cy", "y", entity.id, "c", entity.center.y, (v) => {
      entity.center = { x: entity.center.x, y: v };
    });
    this.constructionRow(sec, entity);
    this.content.appendChild(sec);
  }

  private buildArcProperties(entity: ArcEntity): void {
    const sec = this.createSection("ARC");
    const TAU = Math.PI * 2;
    const span = (((entity.endAngle - entity.startAngle) % TAU) + TAU) % TAU;
    const toDeg = (r: number) => (r * 180) / Math.PI;

    const DEG = Math.PI / 180;
    this.bindingRow(sec, "Radius", entity.id, "r", entity.radius, "mm", (v) => {
      if (v > 0) entity.radius = v;
    });
    this.bindingRow(
      sec,
      "Start",
      entity.id,
      "sa",
      toDeg(entity.startAngle),
      "°",
      (v) => {
        entity.startAngle = v * DEG;
      },
      1,
      DEG,
    );
    this.bindingRow(
      sec,
      "End",
      entity.id,
      "ea",
      toDeg(entity.endAngle),
      "°",
      (v) => {
        entity.endAngle = v * DEG;
      },
      1,
      DEG,
    );

    // Sweep was a disabled readout — you could see the included angle but not
    // set it, and certainly not drive it from a variable. A literal now moves the
    // END angle, keeping Start put (the arc grows the way it is drawn); a formula
    // parks in a hidden `arc-sweep` dimension and the solver holds it, which is
    // what lets Start move instead when something else pins the end.
    this.hiddenDimRow(
      sec,
      "Sweep",
      "arc-sweep",
      [],
      toDeg(span),
      "°",
      (deg) => {
        entity.endAngle = entity.startAngle + deg * DEG;
      },
      1,
      false, // a sweep of 0 or less is not an arc
      { entities: [entity.id] },
    );

    this.originCoordRow(sec, "Cx", "x", entity.id, "c", entity.center.x, (v) => {
      entity.center = { x: v, y: entity.center.y };
    });
    this.originCoordRow(sec, "Cy", "y", entity.id, "c", entity.center.y, (v) => {
      entity.center = { x: entity.center.x, y: v };
    });
    this.constructionRow(sec, entity);
    this.content.appendChild(sec);
  }

  private buildLineProperties(entity: LineEntity): void {
    const sec = this.createSection("LINE");

    // Length — a formula parks in a hidden distance dimension (a→b); a literal
    // resizes along the current direction, anchoring endpoint A.
    this.hiddenDimRow(
      sec,
      "Length",
      "distance",
      [
        { entityId: entity.id, key: "a" },
        { entityId: entity.id, key: "b" },
      ],
      entity.length,
      "mm",
      (v) => {
        if (v <= 0) return;
        const dx = entity.b.x - entity.a.x,
          dy = entity.b.y - entity.a.y;
        const L = Math.hypot(dx, dy) || 1;
        entity.b = { x: entity.a.x + (dx / L) * v, y: entity.a.y + (dy / L) * v };
      },
    );
    // Angle — a literal rotates endpoint B about A keeping the length; a formula
    // parks in a hidden `angle-x` dimension and the SOLVER holds the direction,
    // exactly as Length above parks in a hidden distance dimension. Which end
    // moves is then the solver's answer, decided by the sketch's other
    // constraints, rather than something this field picks.
    this.hiddenDimRow(
      sec,
      "Angle",
      "angle-x",
      [],
      (Math.atan2(entity.b.y - entity.a.y, entity.b.x - entity.a.x) * 180) / Math.PI,
      "°",
      (deg) => {
        const L = entity.length;
        const r = (deg * Math.PI) / 180;
        entity.b = { x: entity.a.x + L * Math.cos(r), y: entity.a.y + L * Math.sin(r) };
      },
      1,
      true, // any direction is valid, including 0 and negatives
      // No scale: `angle-x` stores degrees precisely so a literal and a formula
      // in this box mean the same thing.
      { entities: [entity.id] },
    );
    this.originCoordRow(sec, "Ax", "x", entity.id, "a", entity.a.x, (v) => {
      entity.a = { x: v, y: entity.a.y };
    });
    this.originCoordRow(sec, "Ay", "y", entity.id, "a", entity.a.y, (v) => {
      entity.a = { x: entity.a.x, y: v };
    });
    this.originCoordRow(sec, "Bx", "x", entity.id, "b", entity.b.x, (v) => {
      entity.b = { x: v, y: entity.b.y };
    });
    this.originCoordRow(sec, "By", "y", entity.id, "b", entity.b.y, (v) => {
      entity.b = { x: entity.b.x, y: v };
    });
    this.constructionRow(sec, entity);
    this.content.appendChild(sec);
  }

  private buildRectProperties(entity: RectEntity): void {
    const sec = this.createSection("RECTANGLE");
    // W/H formulas park in hidden horizontal/vertical dims between the corners;
    // a literal resizes anchored at the min (bottom-left) corner.
    const corners: PointRef[] = [
      { entityId: entity.id, key: "bl" },
      { entityId: entity.id, key: "tr" },
    ];
    this.hiddenDimRow(sec, "W", "horizontal", corners, entity.width, "mm", (v) => {
      if (v <= 0) return;
      const m = entity.minPt,
        h = entity.height;
      entity.p0 = { x: m.x, y: m.y };
      entity.p1 = { x: m.x + v, y: m.y + h };
    });
    this.hiddenDimRow(sec, "H", "vertical", corners, entity.height, "mm", (v) => {
      if (v <= 0) return;
      const m = entity.minPt,
        w = entity.width;
      entity.p0 = { x: m.x, y: m.y };
      entity.p1 = { x: m.x + w, y: m.y + v };
    });
    this.constructionRow(sec, entity);
    this.content.appendChild(sec);
  }

  private buildPolylineProperties(entity: PolylineEntity): void {
    // A pristine regular polygon stays editable by sides / across-flats Ø. The
    // metadata is dropped the moment it no longer matches the actual vertices
    // (a vertex was dragged, a constraint moved it, etc.) or once the shape is
    // referenced by a constraint/dimension (which pins its vertex topology).
    const asPolygon =
      entity.polygon && !this.isEntityReferenced(entity.id) && this.polygonMatches(entity)
        ? entity.polygon
        : null;
    if (entity.polygon && !asPolygon && !this.isEntityReferenced(entity.id)) {
      entity.polygon = undefined; // self-heal stale metadata
    }

    if (asPolygon) {
      const sec = this.createSection("POLYGON");
      this.numRow(
        sec,
        "Sides",
        asPolygon.sides,
        null,
        (v) => {
          const n = Math.round(v);
          if (n < 3 || n > 64) return;
          this.regenPolygon(entity, { sides: n }); // keep across-flats Ø
        },
        0,
      );
      const af = 2 * asPolygon.radius * Math.cos(Math.PI / asPolygon.sides);
      this.numRow(sec, "Ø (AF)", af, "mm", (v) => {
        if (v <= 0) return;
        this.regenPolygon(entity, { diameter: v });
      });
      this.content.appendChild(sec);
    }

    const sec = this.createSection("POLYLINE");
    const row = document.createElement("div");
    row.className = "props-row";
    const vLbl = document.createElement("span");
    vLbl.textContent = "Vertices";
    const vVal = document.createElement("input");
    vVal.type = "text";
    vVal.value = entity.points.length.toString();
    vVal.disabled = true;
    const closedBtn = document.createElement("button");
    closedBtn.className = entity.closed ? "btn active" : "btn";
    closedBtn.textContent = entity.closed ? "Closed" : "Open";
    closedBtn.title = "Toggle open/closed polyline";
    closedBtn.addEventListener("click", () => {
      this.pushHistory();
      entity.closed = !entity.closed;
      this.doc.emitChange();
    });
    row.append(vLbl, vVal, closedBtn);
    sec.appendChild(row);

    // Per-vertex coordinates. Scrolls when a shape (e.g. a polygon, which is a
    // closed polyline) has many vertices.
    const list = document.createElement("div");
    list.className = "props-vertex-list";
    // One row per coordinate, through the same origin-referenced hidden dim a
    // line's Ax/Ay uses — so a vertex takes a formula, shows the ƒx badge and
    // suggests variable names. It costs a row per vertex over the old paired
    // X/Y layout, which is the price of these being parametric at all.
    entity.points.forEach((p, i) => {
      // Hand-editing a vertex breaks regularity — forget the polygon params.
      const setVertex = (x: number, y: number) =>
        this.applyEdit(() => {
          entity.points[i] = { x, y };
          entity.polygon = undefined;
        });
      // Vertices are keyed by STABLE id, not index, so a formula survives an
      // edit that renumbers them (see PolylineEntity.dofPoints).
      const key = `v${entity.vertexIds[i]}`;
      this.originCoordRow(list, `${i} X`, "x", entity.id, key, p.x, (v) =>
        setVertex(v, entity.points[i].y),
      );
      this.originCoordRow(list, `${i} Y`, "y", entity.id, key, p.y, (v) =>
        setVertex(entity.points[i].x, v),
      );
    });
    sec.appendChild(list);

    this.constructionRow(sec, entity);
    this.content.appendChild(sec);
  }

  /** True if any constraint or dimension references this entity (pins its topology). */
  private isEntityReferenced(id: string): boolean {
    return (
      this.doc.constraints.some(
        (c) => c.entities.includes(id) || c.points.some((p) => p.entityId === id),
      ) ||
      this.doc.dimensions.some(
        (d) => d.entities.includes(id) || d.points.some((p) => p.entityId === id),
      )
    );
  }

  /** True while the polygon params still reproduce the actual vertices (≤1e-3 mm). */
  private polygonMatches(entity: PolylineEntity): boolean {
    const p = entity.polygon!;
    if (entity.points.length !== p.sides) return false;
    const expected = regularPolygonPoints(p.center, p.radius, p.sides, p.rotation);
    return entity.points.every(
      (q, i) => Math.hypot(q.x - expected[i].x, q.y - expected[i].y) < 1e-3,
    );
  }

  /** Regenerate a polygon's vertices from edited params, holding across-flats Ø by default. */
  private regenPolygon(
    entity: PolylineEntity,
    change: { sides?: number; diameter?: number },
  ): void {
    const p = entity.polygon!;
    const sides = change.sides ?? p.sides;
    const af = change.diameter ?? 2 * p.radius * Math.cos(Math.PI / p.sides);
    const radius = af / 2 / Math.cos(Math.PI / sides);
    this.applyEdit(() => {
      entity.replaceAllPoints(regularPolygonPoints(p.center, radius, sides, p.rotation));
      entity.polygon = { sides, center: { ...p.center }, radius, rotation: p.rotation };
    });
  }

  // ---------------------------------------------------------------------------
  // Transform (collapsible)

  private buildTransformSection(bounds: Bounds, selected: Entity[]): void {
    const x = bounds.min.x,
      y = bounds.min.y;
    const w = bounds.max.x - bounds.min.x,
      h = bounds.max.y - bounds.min.y;
    const cx = x + w / 2,
      cy = y + h / 2;

    const toggle = document.createElement("div");
    toggle.className = "props-transform-toggle";
    const label = document.createElement("span");
    label.textContent = "TRANSFORM";
    const chevron = document.createElement("span");
    chevron.className = "props-transform-chevron";
    chevron.textContent = this.transformCollapsed ? "›" : "⌄";
    toggle.append(label, chevron);
    this.content.appendChild(toggle);

    const body = document.createElement("div");
    body.className = "props-transform-body";
    body.style.display = this.transformCollapsed ? "none" : "flex";
    this.content.appendChild(body);

    toggle.addEventListener("click", () => {
      this.transformCollapsed = !this.transformCollapsed;
      body.style.display = this.transformCollapsed ? "none" : "flex";
      chevron.textContent = this.transformCollapsed ? "›" : "⌄";
    });

    // Redirect build methods into the transform body
    const origContent = this.content;
    this.content = body;

    this.buildPositionSection(x, y, w, h);
    this.buildScaleSection(w, h, x, y);
    this.buildRotateSection(cx, cy);
    this.buildFlipSection(cx, cy);
    if (selected.length >= 2) this.buildAlignSection();
    this.buildFitSection();

    this.content = origContent;
  }

  // ---------------------------------------------------------------------------
  // Group sections

  private buildGroupSection(group: GroupDef, fullySelected: boolean): void {
    // A group backing a generator feature gets a distinct title plus an
    // Edit… button that reopens the generator's parameter dialog — the
    // group is just how the feature's entities are tracked on the doc.
    const feat = this.doc.features.find((f) => f.groupId === group.id);
    const title = feat
      ? `Feature · ${GENERATORS[feat.generatorId]?.name ?? feat.generatorId}`
      : `Group · ${group.entityIds.length} entities`;
    const sec = this.createSection(title);

    const nameRow = document.createElement("div");
    nameRow.className = "props-row";
    const nameLbl = document.createElement("span");
    nameLbl.textContent = "Name";
    const nameIn = document.createElement("input");
    nameIn.type = "text";
    nameIn.value = group.name;
    nameIn.placeholder = "Unnamed group";
    nameIn.style.flex = "1";
    nameIn.addEventListener("change", () => {
      group.name = nameIn.value.trim();
    });
    nameRow.append(nameLbl, nameIn);
    sec.appendChild(nameRow);

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:4px;margin-top:4px;";

    if (feat) {
      const gen = GENERATORS[feat.generatorId];
      if (gen) {
        const editBtn = document.createElement("button");
        editBtn.className = "btn";
        editBtn.textContent = "Edit…";
        editBtn.title = "Edit this feature's parameters";
        editBtn.addEventListener("click", () => {
          openGeneratorDialog({
            doc: this.doc,
            pushHistory: this.pushHistory,
            gen,
            editFeatureId: feat.id,
            onPreview: this.onGeneratorPreview,
          });
        });
        btnRow.appendChild(editBtn);
      }
    }

    if (!fullySelected) {
      const selectBtn = document.createElement("button");
      selectBtn.className = "btn";
      selectBtn.textContent = "Select All";
      selectBtn.title = "Select all entities in this group";
      selectBtn.addEventListener("click", () => {
        for (const e of this.doc.entities) e.selected = group.entityIds.includes(e.id);
        this.doc.emitChange();
      });
      btnRow.appendChild(selectBtn);
    }

    const ungroupBtn = document.createElement("button");
    ungroupBtn.className = "btn";
    ungroupBtn.textContent = "Ungroup";
    ungroupBtn.title = feat
      ? "Ungroup and forget the feature (geometry becomes plain)"
      : "Ungroup";
    ungroupBtn.addEventListener("click", () => {
      this.pushHistory();
      this.doc.groups = this.doc.groups.filter((g) => g.id !== group.id);
      // Ungrouping is the explicit "explode to plain geometry" gesture — a
      // feature can't outlive the group that tracks its entities, so drop it
      // too rather than leaving a dangling FeatureInstance.
      if (feat) this.doc.features = this.doc.features.filter((f) => f.id !== feat.id);
      this.doc.emitChange();
    });
    btnRow.appendChild(ungroupBtn);

    sec.appendChild(btnRow);
    this.content.appendChild(sec);
  }

  private buildCreateGroupSection(): void {
    const sec = this.createSection(`Selection · ${this.doc.selected.length} entities`);
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.textContent = "Group";
    btn.addEventListener("click", () => {
      this.pushHistory();
      const group = {
        id: nextId("grp"),
        name: "",
        entityIds: this.doc.selected.map((e) => e.id),
      };
      this.doc.groups.push(group);
      this.doc.emitChange();
    });
    sec.appendChild(btn);
    this.content.appendChild(sec);
  }

  // ---------------------------------------------------------------------------
  // Layer

  private buildLayerSection(selected: Entity[]): void {
    const sec = this.createSection("Layer");

    let commonLayer = selected[0].layerId;
    for (const e of selected) {
      if (e.layerId !== commonLayer) {
        commonLayer = "mixed";
        break;
      }
    }

    const sel = document.createElement("select");
    sel.className = "dim";
    sel.style.width = "100%";

    if (commonLayer === "mixed") {
      const opt = document.createElement("option");
      opt.value = "mixed";
      opt.textContent = "Mixed Layers";
      opt.disabled = true;
      opt.selected = true;
      sel.appendChild(opt);
    }

    for (const layer of this.doc.layers) {
      const opt = document.createElement("option");
      opt.value = layer.id;
      opt.textContent = layer.name;
      if (layer.id === commonLayer) opt.selected = true;
      sel.appendChild(opt);
    }

    sel.addEventListener("change", () => {
      if (sel.value === "mixed") return;
      this.pushHistory();
      for (const e of selected) e.layerId = sel.value;
      this.doc.emitChange();
    });

    sec.appendChild(sel);
    this.content.appendChild(sec);
  }

  // ---------------------------------------------------------------------------
  // Transform sub-sections (appended into transform body via content redirect)

  private buildPositionSection(x: number, y: number, w: number, h: number): void {
    const sec = this.createSection("BOUNDING BOX");

    const rowSize = document.createElement("div");
    rowSize.className = "props-row";
    const lblW2 = document.createElement("span");
    lblW2.textContent = "W";
    const inW2 = document.createElement("input");
    inW2.type = "text";
    inW2.value = w.toFixed(2);
    inW2.disabled = true;
    const lblH2 = document.createElement("span");
    lblH2.textContent = "H";
    const inH2 = document.createElement("input");
    inH2.type = "text";
    inH2.value = h.toFixed(2);
    inH2.disabled = true;
    rowSize.append(lblW2, inW2, lblH2, inH2);
    sec.appendChild(rowSize);

    const rowPos = document.createElement("div");
    rowPos.className = "props-row";
    const lblX = document.createElement("span");
    lblX.textContent = "X";
    const inX = document.createElement("input");
    inX.type = "text";
    inX.value = x.toFixed(2);
    const lblY = document.createElement("span");
    lblY.textContent = "Y";
    const inY = document.createElement("input");
    inY.type = "text";
    inY.value = y.toFixed(2);
    rowPos.append(lblX, inX, lblY, inY);

    const applyPos = () => {
      const newX = parseFloat(inX.value);
      const newY = parseFloat(inY.value);
      if (Number.isNaN(newX) || Number.isNaN(newY)) return;
      const dx = newX - x;
      const dy = newY - y;
      if (dx === 0 && dy === 0) return;
      this.pushHistory();
      for (const ent of this.doc.selected) ent.translate({ x: dx, y: dy });
      this.solve();
      this.doc.emitChange();
    };

    inX.addEventListener("change", applyPos);
    inY.addEventListener("change", applyPos);

    sec.appendChild(rowPos);
    this.content.appendChild(sec);
  }

  private buildScaleSection(w: number, h: number, minX: number, minY: number): void {
    const sec = this.createSection("SCALE");
    const row = document.createElement("div");
    row.className = "props-row";

    const lblW = document.createElement("span");
    lblW.textContent = "W";
    const inW = document.createElement("input");
    inW.type = "text";
    inW.value = w.toFixed(2);
    const btnLock = document.createElement("button");
    btnLock.className = this.scaleLocked ? "btn active" : "btn";
    btnLock.textContent = this.scaleLocked ? "🔒" : "🔓";
    btnLock.title = "Toggle aspect ratio lock";
    const lblH = document.createElement("span");
    lblH.textContent = "H";
    const inH = document.createElement("input");
    inH.type = "text";
    inH.value = h.toFixed(2);

    btnLock.addEventListener("click", () => {
      this.scaleLocked = !this.scaleLocked;
      btnLock.textContent = this.scaleLocked ? "🔒" : "🔓";
      btnLock.className = this.scaleLocked ? "btn active" : "btn";
    });

    const parseInput = (val: string, base: number) => {
      if (val.endsWith("%")) return base * (parseFloat(val) / 100);
      return parseFloat(val);
    };

    inW.addEventListener("input", () => {
      if (!this.scaleLocked) return;
      const newW = parseInput(inW.value, w);
      if (!Number.isNaN(newW) && w !== 0) inH.value = (newW * (h / w)).toFixed(2);
    });

    inH.addEventListener("input", () => {
      if (!this.scaleLocked) return;
      const newH = parseInput(inH.value, h);
      if (!Number.isNaN(newH) && h !== 0) inW.value = (newH * (w / h)).toFixed(2);
    });

    row.append(lblW, inW, btnLock, lblH, inH);
    sec.appendChild(row);

    const btnApply = document.createElement("button");
    btnApply.className = "btn";
    btnApply.textContent = "Apply Scale";
    btnApply.addEventListener("click", () => {
      const newW = parseInput(inW.value, w);
      const newH = parseInput(inH.value, h);
      if (Number.isNaN(newW) || Number.isNaN(newH) || newW <= 0 || newH <= 0 || w === 0 || h === 0)
        return;
      this.pushHistory();
      applyScale(this.doc.selected, minX, minY, newW / w, newH / h);
      this.solve();
      this.doc.emitChange();
    });
    sec.appendChild(btnApply);
    this.content.appendChild(sec);
  }

  private buildRotateSection(cx: number, cy: number): void {
    const sec = this.createSection("ROTATE");
    const row = document.createElement("div");
    row.className = "props-row";

    const lblA = document.createElement("span");
    lblA.textContent = "°";
    const inA = document.createElement("input");
    inA.type = "text";
    inA.value = "0";

    const btnCCW = document.createElement("button");
    btnCCW.className = "btn";
    btnCCW.textContent = "↺ 90";
    btnCCW.addEventListener("click", () => {
      inA.value = ((parseFloat(inA.value) || 0) + 90).toString();
    });
    const btnCW = document.createElement("button");
    btnCW.className = "btn";
    btnCW.textContent = "↻ 90";
    btnCW.addEventListener("click", () => {
      inA.value = ((parseFloat(inA.value) || 0) - 90).toString();
    });

    row.append(inA, lblA, btnCCW, btnCW);
    sec.appendChild(row);

    const btnApply = document.createElement("button");
    btnApply.className = "btn";
    btnApply.textContent = "Apply Rotation";
    btnApply.addEventListener("click", () => {
      const angle = (parseFloat(inA.value) * Math.PI) / 180;
      if (Number.isNaN(angle) || angle === 0) return;
      this.pushHistory();
      applyRotate(this.doc.selected, cx, cy, angle, (oldE, newE) => {
        const idx = this.doc.entities.findIndex((x) => x.id === oldE.id);
        if (idx >= 0) this.doc.entities[idx] = newE;
      });
      this.solve();
      this.doc.emitChange();
    });
    sec.appendChild(btnApply);
    this.content.appendChild(sec);
  }

  private buildFlipSection(cx: number, cy: number): void {
    const sec = this.createSection("FLIP");
    const row = document.createElement("div");
    row.className = "props-row";

    const btnH = document.createElement("button");
    btnH.className = "btn";
    btnH.style.flex = "1";
    btnH.textContent = "Flip H";
    btnH.addEventListener("click", () => {
      this.pushHistory();
      applyFlipH(this.doc.selected, cx);
      this.solve();
      this.doc.emitChange();
    });

    const btnV = document.createElement("button");
    btnV.className = "btn";
    btnV.style.flex = "1";
    btnV.textContent = "Flip V";
    btnV.addEventListener("click", () => {
      this.pushHistory();
      applyFlipV(this.doc.selected, cy);
      this.solve();
      this.doc.emitChange();
    });

    row.append(btnH, btnV);
    sec.appendChild(row);
    this.content.appendChild(sec);
  }

  private buildAlignSection(): void {
    const sec = this.createSection("ALIGN");
    const row = document.createElement("div");
    row.className = "props-row props-align-row";

    const align = (mode: "left" | "right" | "top" | "bottom" | "centerH" | "centerV") => {
      const bounds = selectionBounds(this.doc.selected);
      if (!bounds) return;
      this.pushHistory();
      for (const ent of this.doc.selected) {
        const eb = ent.bounds();
        let dx = 0,
          dy = 0;
        if (mode === "left") dx = bounds.min.x - eb.min.x;
        if (mode === "right") dx = bounds.max.x - eb.max.x;
        if (mode === "top") dy = bounds.max.y - eb.max.y;
        if (mode === "bottom") dy = bounds.min.y - eb.min.y;
        if (mode === "centerH") dx = (bounds.min.x + bounds.max.x) / 2 - (eb.min.x + eb.max.x) / 2;
        if (mode === "centerV") dy = (bounds.min.y + bounds.max.y) / 2 - (eb.min.y + eb.max.y) / 2;
        if (dx !== 0 || dy !== 0) ent.translate({ x: dx, y: dy });
      }
      this.solve();
      this.doc.emitChange();
    };

    const makeBtn = (text: string, m: Parameters<typeof align>[0]) => {
      const b = document.createElement("button");
      b.className = "btn";
      b.textContent = text;
      b.title = `Align ${m}`;
      b.addEventListener("click", () => align(m));
      return b;
    };

    row.append(
      makeBtn("⇤", "left"),
      makeBtn("⇥", "right"),
      makeBtn("⇧", "top"),
      makeBtn("⇩", "bottom"),
      makeBtn("↔", "centerH"),
      makeBtn("↕", "centerV"),
    );
    sec.appendChild(row);

    // "Center inner in outer" — only when exactly two full groups are selected
    const selectedIds = new Set(this.doc.selected.map((e) => e.id));
    const twoGroups = this.doc.groups.filter(
      (g) => g.entityIds.length > 0 && g.entityIds.every((id) => selectedIds.has(id)),
    );
    if (twoGroups.length === 2) {
      const entsOf = (g: GroupDef) => this.doc.entities.filter((e) => g.entityIds.includes(e.id));
      const b0 = selectionBounds(entsOf(twoGroups[0]));
      const b1 = selectionBounds(entsOf(twoGroups[1]));
      if (b0 && b1) {
        const centerInBtn = document.createElement("button");
        centerInBtn.className = "btn";
        centerInBtn.style.marginTop = "4px";
        centerInBtn.style.width = "100%";
        centerInBtn.textContent = "⊙ Center inner in outer";
        centerInBtn.title = "Move the smaller group so it is centred within the larger group";
        centerInBtn.addEventListener("click", () => {
          const area0 = (b0.max.x - b0.min.x) * (b0.max.y - b0.min.y);
          const area1 = (b1.max.x - b1.min.x) * (b1.max.y - b1.min.y);
          const [innerGroup, innerB, outerB] =
            area0 <= area1 ? [twoGroups[0], b0, b1] : [twoGroups[1], b1, b0];
          const dx = (outerB.min.x + outerB.max.x) / 2 - (innerB.min.x + innerB.max.x) / 2;
          const dy = (outerB.min.y + outerB.max.y) / 2 - (innerB.min.y + innerB.max.y) / 2;
          if (dx === 0 && dy === 0) return;
          this.pushHistory();
          for (const e of entsOf(innerGroup)) e.translate({ x: dx, y: dy });
          this.solve();
          this.doc.emitChange();
        });
        sec.appendChild(centerInBtn);
      }
    }

    this.content.appendChild(sec);
  }

  private buildFitSection(): void {
    const sec = this.createSection("FIT TO CANVAS");
    const row = document.createElement("div");
    row.className = "props-row";

    const lblM = document.createElement("span");
    lblM.textContent = "Margin";
    const inM = document.createElement("input");
    inM.type = "text";
    inM.value = "10";
    const lblU = document.createElement("span");
    lblU.textContent = "mm";

    row.append(lblM, inM, lblU);
    sec.appendChild(row);

    const btnRow = document.createElement("div");
    btnRow.className = "props-row";

    const btnFit = document.createElement("button");
    btnFit.className = "btn";
    btnFit.style.flex = "1";
    btnFit.textContent = "Fit & Center";
    btnFit.addEventListener("click", () => {
      const margin = parseFloat(inM.value) || 0;
      const bounds = selectionBounds(this.doc.selected);
      if (!bounds) return;
      const w = bounds.max.x - bounds.min.x;
      const h = bounds.max.y - bounds.min.y;
      if (w === 0 || h === 0) return;

      const availW = this.doc.canvas.width - 2 * margin;
      const availH = this.doc.canvas.height - 2 * margin;
      if (availW <= 0 || availH <= 0) return;

      const scale = Math.min(availW / w, availH / h);
      this.pushHistory();
      applyScale(this.doc.selected, bounds.min.x, bounds.min.y, scale, scale);

      const newW = w * scale;
      const newH = h * scale;
      const cx = bounds.min.x + newW / 2;
      const cy = bounds.min.y + newH / 2;
      const dx = this.doc.canvas.width / 2 - cx;
      const dy = this.doc.canvas.height / 2 - cy;
      for (const ent of this.doc.selected) ent.translate({ x: dx, y: dy });

      this.solve();
      this.doc.emitChange();
    });

    const btnCenter = document.createElement("button");
    btnCenter.className = "btn";
    btnCenter.style.flex = "1";
    btnCenter.textContent = "Center";
    btnCenter.addEventListener("click", () => {
      const bounds = selectionBounds(this.doc.selected);
      if (!bounds) return;
      const cx = bounds.min.x + (bounds.max.x - bounds.min.x) / 2;
      const cy = bounds.min.y + (bounds.max.y - bounds.min.y) / 2;
      const dx = this.doc.canvas.width / 2 - cx;
      const dy = this.doc.canvas.height / 2 - cy;
      if (dx === 0 && dy === 0) return;
      this.pushHistory();
      for (const ent of this.doc.selected) ent.translate({ x: dx, y: dy });
      this.solve();
      this.doc.emitChange();
    });

    btnRow.append(btnFit, btnCenter);
    sec.appendChild(btnRow);
    this.content.appendChild(sec);
  }

  // ---------------------------------------------------------------------------

  private createSection(title: string): HTMLElement {
    const sec = document.createElement("div");
    sec.className = "props-section";
    const h = document.createElement("div");
    h.className = "props-section-title";
    h.textContent = title;
    sec.appendChild(h);
    return sec;
  }
}
