import { CADDocument, LayerDef } from "../model/document";
import { nextId } from "../model/ids";

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
    this.host.addEventListener("transitionend", () => {
      window.dispatchEvent(new Event("resize"));
    }, { once: true });
  }

  private render(): void {
    this.listEl.innerHTML = "";

    for (const layer of this.doc.layers) {
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.gap = "6px";
      row.style.padding = "4px";
      row.style.backgroundColor = this.doc.activeLayerId === layer.id ? "rgba(255,255,255,0.1)" : "transparent";
      row.style.borderRadius = "4px";

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

      // Name input
      const nameInp = document.createElement("input");
      nameInp.type = "text";
      nameInp.value = layer.name;
      nameInp.className = "dim";
      nameInp.style.flex = "1";
      nameInp.style.width = "10px"; // let flex grow
      nameInp.onchange = () => {
        this.pushHistory();
        layer.name = nameInp.value || "Layer";
        this.doc.emitChange();
      };
      row.appendChild(nameInp);

      // Visibility toggle (eye)
      const visBtn = document.createElement("button");
      visBtn.className = "icon-btn";
      visBtn.style.padding = "2px";
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
      lockBtn.style.padding = "2px";
      lockBtn.innerHTML = layer.locked ? "🔒" : "🔓";
      lockBtn.title = "Toggle Lock";
      lockBtn.onclick = () => {
        this.pushHistory();
        layer.locked = !layer.locked;
        this.doc.clearSelection(); // avoid selecting locked entities
        this.doc.emitChange();
      };
      row.appendChild(lockBtn);

      // Delete button
      const delBtn = document.createElement("button");
      delBtn.className = "icon-btn";
      delBtn.style.padding = "2px";
      delBtn.innerHTML = "🗑";
      delBtn.title = "Delete Layer";
      delBtn.disabled = this.doc.layers.length <= 1;
      delBtn.style.opacity = delBtn.disabled ? "0.3" : "1";
      delBtn.onclick = () => {
        if (this.doc.layers.length <= 1) return;
        this.pushHistory();
        
        // Remove entities on this layer
        this.doc.entities = this.doc.entities.filter(e => e.layerId !== layer.id);
        
        // Remove layer
        this.doc.layers = this.doc.layers.filter(l => l.id !== layer.id);
        
        // Reset active layer if we deleted the active one
        if (this.doc.activeLayerId === layer.id) {
          this.doc.activeLayerId = this.doc.layers[0].id;
        }
        
        this.doc.emitChange();
      };
      row.appendChild(delBtn);

      this.listEl.appendChild(row);
    }
  }
}
