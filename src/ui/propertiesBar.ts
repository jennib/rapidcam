import { CADDocument, GroupDef } from "../model/document";
import { selectionBounds, applyScale, applyRotate, applyFlipH, applyFlipV } from "../core/transform";
import { nextId } from "../model/ids";
import { listFonts } from "../core/fontManager";
import {
  Entity, TextEntity, CircleEntity, ArcEntity, LineEntity, RectEntity, PolylineEntity, Bounds,
} from "../model/entities";

export class PropertiesBar {
  private content!: HTMLElement;
  private constructionBtn!: HTMLButtonElement;
  private isCollapsed = false;
  private aspectLocked = true;
  private transformCollapsed = true;

  constructor(
    private host: HTMLElement,
    private doc: CADDocument,
    private pushHistory: () => void,
    private solve: () => void,
    private onConstructionToggle: () => void,
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
    this.constructionBtn.innerHTML = '<span class="cm-led"></span>Construction Mode';
    this.constructionBtn.title = "Toggle construction geometry mode (X)";
    this.constructionBtn.addEventListener("click", () => this.onConstructionToggle());
    this.content.appendChild(this.constructionBtn);

    this.host.appendChild(this.content);
  }

  private toggleCollapse(): void {
    this.isCollapsed = !this.isCollapsed;
    if (this.isCollapsed) {
      this.host.classList.add("collapsed");
    } else {
      this.host.classList.remove("collapsed");
    }
    this.host.addEventListener("transitionend", () => {
      window.dispatchEvent(new Event("resize"));
    }, { once: true });
  }

  private refresh(): void {
    this.content.innerHTML = "";
    this.content.appendChild(this.constructionBtn);
    const selected = this.doc.selected;
    const cmActive = selected.length > 0
      ? selected.every(e => e.isConstruction)
      : this.doc.isConstructionMode;
    this.constructionBtn.classList.toggle("active", cmActive);

    if (selected.length === 0) {
      const empty = document.createElement("div");
      empty.className = "props-empty";
      empty.textContent = "No selection";
      this.content.appendChild(empty);
      return;
    }

    const bounds = selectionBounds(selected);
    if (!bounds) return;

    // Group / Create Group
    const selectedIds = new Set(selected.map(e => e.id));
    let involvedGroup: GroupDef | null = null;
    for (const e of selected) {
      const g = this.doc.groupOf(e.id);
      if (g) { involvedGroup = g; break; }
    }
    if (involvedGroup) {
      const fullySelected = involvedGroup.entityIds.every(id => selectedIds.has(id));
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
    }
  }

  private buildTextProperties(entity: TextEntity): void {
    const sec = this.createSection("TEXT");

    // Text content
    const textRow = document.createElement("div");
    textRow.className = "props-row";
    const textLbl = document.createElement("span"); textLbl.textContent = "Text";
    const textIn = document.createElement("input");
    textIn.type = "text";
    textIn.value = entity.text;
    textIn.style.flex = "1";
    textIn.addEventListener("change", () => {
      this.pushHistory();
      entity.text = textIn.value;
      this.doc.emitChange();
    });
    textRow.append(textLbl, textIn);
    sec.appendChild(textRow);

    // Font
    const fontRow = document.createElement("div");
    fontRow.className = "props-row";
    const fontLbl = document.createElement("span"); fontLbl.textContent = "Font";
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
      this.pushHistory();
      entity.fontId = fontSel.value;
      this.doc.emitChange();
    });
    fontRow.append(fontLbl, fontSel);
    sec.appendChild(fontRow);

    // Size
    const sizeRow = document.createElement("div");
    sizeRow.className = "props-row";
    const sizeLbl = document.createElement("span"); sizeLbl.textContent = "Size";
    const sizeIn = document.createElement("input"); sizeIn.type = "text"; sizeIn.value = entity.sizeMM.toFixed(1);
    const sizeUnit = document.createElement("span"); sizeUnit.textContent = "mm";
    sizeIn.addEventListener("change", () => {
      const v = parseFloat(sizeIn.value);
      if (isNaN(v) || v <= 0) return;
      this.pushHistory();
      entity.sizeMM = v;
      this.doc.emitChange();
    });
    sizeRow.append(sizeLbl, sizeIn, sizeUnit);
    sec.appendChild(sizeRow);

    // Angle
    const angleRow = document.createElement("div");
    angleRow.className = "props-row";
    const angleLbl = document.createElement("span"); angleLbl.textContent = "Angle";
    const angleIn = document.createElement("input"); angleIn.type = "text"; angleIn.value = (entity.angle * 180 / Math.PI).toFixed(1);
    const angleUnit = document.createElement("span"); angleUnit.textContent = "°";
    angleIn.addEventListener("change", () => {
      const v = parseFloat(angleIn.value);
      if (isNaN(v)) return;
      this.pushHistory();
      entity.angle = v * Math.PI / 180;
      this.doc.emitChange();
    });
    angleRow.append(angleLbl, angleIn, angleUnit);
    sec.appendChild(angleRow);

    this.content.appendChild(sec);
  }

  private buildCircleProperties(entity: CircleEntity): void {
    const sec = this.createSection("CIRCLE");
    const row = document.createElement("div");
    row.className = "props-row";
    const lbl = document.createElement("span"); lbl.textContent = "Radius";
    const inp = document.createElement("input"); inp.type = "text"; inp.value = entity.radius.toFixed(3);
    const unit = document.createElement("span"); unit.textContent = "mm";
    inp.addEventListener("change", () => {
      const v = parseFloat(inp.value);
      if (isNaN(v) || v <= 0) return;
      this.pushHistory();
      entity.radius = v;
      this.solve();
      this.doc.emitChange();
    });
    row.append(lbl, inp, unit);
    sec.appendChild(row);
    this.content.appendChild(sec);
  }

  private buildArcProperties(entity: ArcEntity): void {
    const sec = this.createSection("ARC");
    const toDeg = (r: number) => (r * 180 / Math.PI).toFixed(1) + "°";
    const TAU = Math.PI * 2;
    const span = ((entity.endAngle - entity.startAngle) % TAU + TAU) % TAU;

    const rRow = document.createElement("div");
    rRow.className = "props-row";
    const rLbl = document.createElement("span"); rLbl.textContent = "Radius";
    const rIn = document.createElement("input"); rIn.type = "text"; rIn.value = entity.radius.toFixed(3);
    const rUnit = document.createElement("span"); rUnit.textContent = "mm";
    rIn.addEventListener("change", () => {
      const v = parseFloat(rIn.value);
      if (isNaN(v) || v <= 0) return;
      this.pushHistory();
      entity.radius = v;
      this.solve();
      this.doc.emitChange();
    });
    rRow.append(rLbl, rIn, rUnit);
    sec.appendChild(rRow);

    const angRow = document.createElement("div");
    angRow.className = "props-row";
    const sLbl = document.createElement("span"); sLbl.textContent = "Start";
    const sVal = document.createElement("input"); sVal.type = "text"; sVal.value = toDeg(entity.startAngle); sVal.disabled = true;
    const eLbl = document.createElement("span"); eLbl.textContent = "End";
    const eVal = document.createElement("input"); eVal.type = "text"; eVal.value = toDeg(entity.endAngle); eVal.disabled = true;
    angRow.append(sLbl, sVal, eLbl, eVal);
    sec.appendChild(angRow);

    const sweepRow = document.createElement("div");
    sweepRow.className = "props-row";
    const swLbl = document.createElement("span"); swLbl.textContent = "Sweep";
    const swVal = document.createElement("input"); swVal.type = "text"; swVal.value = toDeg(span); swVal.disabled = true;
    sweepRow.append(swLbl, swVal);
    sec.appendChild(sweepRow);

    this.content.appendChild(sec);
  }

  private buildLineProperties(entity: LineEntity): void {
    const sec = this.createSection("LINE");
    const dx = entity.b.x - entity.a.x;
    const dy = entity.b.y - entity.a.y;
    const angleDeg = Math.atan2(dy, dx) * 180 / Math.PI;

    const row = document.createElement("div");
    row.className = "props-row";
    const lenLbl = document.createElement("span"); lenLbl.textContent = "Length";
    const lenVal = document.createElement("input"); lenVal.type = "text"; lenVal.value = entity.length.toFixed(3); lenVal.disabled = true;
    const lenUnit = document.createElement("span"); lenUnit.textContent = "mm";
    const angLbl = document.createElement("span"); angLbl.textContent = "Angle";
    const angVal = document.createElement("input"); angVal.type = "text"; angVal.value = angleDeg.toFixed(1) + "°"; angVal.disabled = true;
    row.append(lenLbl, lenVal, lenUnit, angLbl, angVal);
    sec.appendChild(row);
    this.content.appendChild(sec);
  }

  private buildRectProperties(entity: RectEntity): void {
    const sec = this.createSection("RECTANGLE");
    const row = document.createElement("div");
    row.className = "props-row";
    const wLbl = document.createElement("span"); wLbl.textContent = "W";
    const wVal = document.createElement("input"); wVal.type = "text"; wVal.value = entity.width.toFixed(3); wVal.disabled = true;
    const hLbl = document.createElement("span"); hLbl.textContent = "H";
    const hVal = document.createElement("input"); hVal.type = "text"; hVal.value = entity.height.toFixed(3); hVal.disabled = true;
    const unit = document.createElement("span"); unit.textContent = "mm";
    row.append(wLbl, wVal, hLbl, hVal, unit);
    sec.appendChild(row);
    this.content.appendChild(sec);
  }

  private buildPolylineProperties(entity: PolylineEntity): void {
    const sec = this.createSection("POLYLINE");
    const row = document.createElement("div");
    row.className = "props-row";
    const vLbl = document.createElement("span"); vLbl.textContent = "Vertices";
    const vVal = document.createElement("input"); vVal.type = "text"; vVal.value = entity.points.length.toString(); vVal.disabled = true;
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
    this.content.appendChild(sec);
  }

  // ---------------------------------------------------------------------------
  // Transform (collapsible)

  private buildTransformSection(bounds: Bounds, selected: Entity[]): void {
    const x = bounds.min.x, y = bounds.min.y;
    const w = bounds.max.x - bounds.min.x, h = bounds.max.y - bounds.min.y;
    const cx = x + w / 2, cy = y + h / 2;

    const toggle = document.createElement("div");
    toggle.className = "props-transform-toggle";
    const label = document.createElement("span"); label.textContent = "TRANSFORM";
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
    const sec = this.createSection(`Group · ${group.entityIds.length} entities`);

    const nameRow = document.createElement("div");
    nameRow.className = "props-row";
    const nameLbl = document.createElement("span");
    nameLbl.textContent = "Name";
    const nameIn = document.createElement("input");
    nameIn.type = "text";
    nameIn.value = group.name;
    nameIn.placeholder = "Unnamed group";
    nameIn.style.flex = "1";
    nameIn.addEventListener("change", () => { group.name = nameIn.value.trim(); });
    nameRow.append(nameLbl, nameIn);
    sec.appendChild(nameRow);

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:4px;margin-top:4px;";

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
    ungroupBtn.addEventListener("click", () => {
      this.pushHistory();
      this.doc.groups = this.doc.groups.filter(g => g.id !== group.id);
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
        entityIds: this.doc.selected.map(e => e.id)
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
      if (e.layerId !== commonLayer) { commonLayer = "mixed"; break; }
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
    const lblW2 = document.createElement("span"); lblW2.textContent = "W";
    const inW2 = document.createElement("input"); inW2.type = "text"; inW2.value = w.toFixed(2); inW2.disabled = true;
    const lblH2 = document.createElement("span"); lblH2.textContent = "H";
    const inH2 = document.createElement("input"); inH2.type = "text"; inH2.value = h.toFixed(2); inH2.disabled = true;
    rowSize.append(lblW2, inW2, lblH2, inH2);
    sec.appendChild(rowSize);

    const rowPos = document.createElement("div");
    rowPos.className = "props-row";
    const lblX = document.createElement("span"); lblX.textContent = "X";
    const inX = document.createElement("input"); inX.type = "text"; inX.value = x.toFixed(2);
    const lblY = document.createElement("span"); lblY.textContent = "Y";
    const inY = document.createElement("input"); inY.type = "text"; inY.value = y.toFixed(2);
    rowPos.append(lblX, inX, lblY, inY);

    const applyPos = () => {
      const newX = parseFloat(inX.value);
      const newY = parseFloat(inY.value);
      if (isNaN(newX) || isNaN(newY)) return;
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

    const lblW = document.createElement("span"); lblW.textContent = "W";
    const inW = document.createElement("input"); inW.type = "text"; inW.value = w.toFixed(2);
    const btnLock = document.createElement("button");
    btnLock.className = this.aspectLocked ? "btn active" : "btn";
    btnLock.textContent = this.aspectLocked ? "🔒" : "🔓";
    btnLock.title = "Toggle aspect ratio lock";
    const lblH = document.createElement("span"); lblH.textContent = "H";
    const inH = document.createElement("input"); inH.type = "text"; inH.value = h.toFixed(2);

    btnLock.addEventListener("click", () => {
      this.aspectLocked = !this.aspectLocked;
      btnLock.textContent = this.aspectLocked ? "🔒" : "🔓";
      btnLock.className = this.aspectLocked ? "btn active" : "btn";
    });

    const parseInput = (val: string, base: number) => {
      if (val.endsWith("%")) return base * (parseFloat(val) / 100);
      return parseFloat(val);
    };

    inW.addEventListener("input", () => {
      if (!this.aspectLocked) return;
      const newW = parseInput(inW.value, w);
      if (!isNaN(newW) && w !== 0) inH.value = (newW * (h / w)).toFixed(2);
    });

    inH.addEventListener("input", () => {
      if (!this.aspectLocked) return;
      const newH = parseInput(inH.value, h);
      if (!isNaN(newH) && h !== 0) inW.value = (newH * (w / h)).toFixed(2);
    });

    row.append(lblW, inW, btnLock, lblH, inH);
    sec.appendChild(row);

    const btnApply = document.createElement("button");
    btnApply.className = "btn";
    btnApply.textContent = "Apply Scale";
    btnApply.addEventListener("click", () => {
      const newW = parseInput(inW.value, w);
      const newH = parseInput(inH.value, h);
      if (isNaN(newW) || isNaN(newH) || newW <= 0 || newH <= 0 || w === 0 || h === 0) return;
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

    const lblA = document.createElement("span"); lblA.textContent = "°";
    const inA = document.createElement("input"); inA.type = "text"; inA.value = "0";

    const btnCCW = document.createElement("button"); btnCCW.className = "btn"; btnCCW.textContent = "↺ 90";
    btnCCW.addEventListener("click", () => { inA.value = ((parseFloat(inA.value) || 0) + 90).toString(); });
    const btnCW = document.createElement("button"); btnCW.className = "btn"; btnCW.textContent = "↻ 90";
    btnCW.addEventListener("click", () => { inA.value = ((parseFloat(inA.value) || 0) - 90).toString(); });

    row.append(inA, lblA, btnCCW, btnCW);
    sec.appendChild(row);

    const btnApply = document.createElement("button");
    btnApply.className = "btn";
    btnApply.textContent = "Apply Rotation";
    btnApply.addEventListener("click", () => {
      const angle = parseFloat(inA.value) * Math.PI / 180;
      if (isNaN(angle) || angle === 0) return;
      this.pushHistory();
      applyRotate(this.doc.selected, cx, cy, angle, (oldE, newE) => {
        const idx = this.doc.entities.findIndex(x => x.id === oldE.id);
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
    btnH.className = "btn"; btnH.style.flex = "1";
    btnH.textContent = "Flip H";
    btnH.addEventListener("click", () => {
      this.pushHistory();
      applyFlipH(this.doc.selected, cx);
      this.solve();
      this.doc.emitChange();
    });

    const btnV = document.createElement("button");
    btnV.className = "btn"; btnV.style.flex = "1";
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
        let dx = 0, dy = 0;
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
    const selectedIds = new Set(this.doc.selected.map(e => e.id));
    const twoGroups = this.doc.groups.filter(g =>
      g.entityIds.length > 0 && g.entityIds.every(id => selectedIds.has(id))
    );
    if (twoGroups.length === 2) {
      const entsOf = (g: GroupDef) => this.doc.entities.filter(e => g.entityIds.includes(e.id));
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
          const [innerGroup, innerB, outerB] = area0 <= area1
            ? [twoGroups[0], b0, b1] : [twoGroups[1], b1, b0];
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

    const lblM = document.createElement("span"); lblM.textContent = "Margin";
    const inM = document.createElement("input"); inM.type = "text"; inM.value = "10";
    const lblU = document.createElement("span"); lblU.textContent = "mm";

    row.append(lblM, inM, lblU);
    sec.appendChild(row);

    const btnRow = document.createElement("div");
    btnRow.className = "props-row";

    const btnFit = document.createElement("button");
    btnFit.className = "btn"; btnFit.style.flex = "1";
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
    btnCenter.className = "btn"; btnCenter.style.flex = "1";
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
