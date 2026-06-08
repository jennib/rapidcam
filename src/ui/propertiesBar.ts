import { CADDocument, GroupDef } from "../model/document";
import { selectionBounds, applyScale, applyRotate, applyFlipH, applyFlipV } from "../core/transform";
import { nextId } from "../model/ids";

export class PropertiesBar {
  private content!: HTMLElement;
  private constructionBtn!: HTMLButtonElement;
  private isCollapsed = false;
  private aspectLocked = true;

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

    // Find a group that contains any selected entity (pick the first one found)
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

    this.buildPositionSection(bounds.min.x, bounds.min.y, bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y);
    this.buildScaleSection(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.min.x, bounds.min.y);
    this.buildRotateSection(bounds.min.x + (bounds.max.x - bounds.min.x) / 2, bounds.min.y + (bounds.max.y - bounds.min.y) / 2);
    this.buildFlipSection(bounds.min.x + (bounds.max.x - bounds.min.x) / 2, bounds.min.y + (bounds.max.y - bounds.min.y) / 2);
    
    if (selected.length >= 2) {
      this.buildAlignSection();
    }
    
    this.buildFitSection();
    this.buildLayerSection(selected);
  }

  private buildGroupSection(group: GroupDef, fullySelected: boolean): void {
    const sec = this.createSection(`Group · ${group.entityIds.length} entities`);

    // Name field
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

  private buildLayerSection(selected: import("../model/entities").Entity[]): void {
    const sec = this.createSection("Layer");
    
    // Check if all selected entities share the same layer
    let commonLayer = selected[0].layerId;
    for (const e of selected) {
      if (e.layerId !== commonLayer) {
        commonLayer = "mixed";
        break;
      }
    }

    const select = document.createElement("select");
    select.className = "dim";
    select.style.width = "100%";
    
    if (commonLayer === "mixed") {
      const opt = document.createElement("option");
      opt.value = "mixed";
      opt.textContent = "Mixed Layers";
      opt.disabled = true;
      opt.selected = true;
      select.appendChild(opt);
    }

    for (const layer of this.doc.layers) {
      const opt = document.createElement("option");
      opt.value = layer.id;
      opt.textContent = layer.name;
      if (layer.id === commonLayer) opt.selected = true;
      select.appendChild(opt);
    }

    select.addEventListener("change", () => {
      if (select.value === "mixed") return;
      this.pushHistory();
      for (const e of selected) {
        e.layerId = select.value;
      }
      this.doc.emitChange();
    });

    sec.appendChild(select);
    this.content.appendChild(sec);
  }

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
      for (const ent of this.doc.selected) {
        ent.translate({ x: dx, y: dy });
      }
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

    const align = (mode: "left"|"right"|"top"|"bottom"|"centerH"|"centerV") => {
      const bounds = selectionBounds(this.doc.selected);
      if (!bounds) return;
      this.pushHistory();
      for (const ent of this.doc.selected) {
        const eb = ent.bounds();
        let dx = 0, dy = 0;
        if (mode === "left") dx = bounds.min.x - eb.min.x;
        if (mode === "right") dx = bounds.max.x - eb.max.x;
        if (mode === "top") dy = bounds.max.y - eb.max.y; // Y is up
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
      makeBtn("↕", "centerV")
    );
    sec.appendChild(row);

    // "Center in" — only shown when exactly two full groups are selected
    const selectedIds = new Set(this.doc.selected.map(e => e.id));
    const twoGroups = this.doc.groups.filter(g => g.entityIds.length > 0 && g.entityIds.every(id => selectedIds.has(id)));
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
      
      // new bounds after scale
      const newW = w * scale;
      const newH = h * scale;
      const cx = bounds.min.x + newW / 2;
      const cy = bounds.min.y + newH / 2;
      const targetCx = this.doc.canvas.width / 2;
      const targetCy = this.doc.canvas.height / 2;
      const dx = targetCx - cx;
      const dy = targetCy - cy;

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
      const targetCx = this.doc.canvas.width / 2;
      const targetCy = this.doc.canvas.height / 2;
      const dx = targetCx - cx;
      const dy = targetCy - cy;

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
