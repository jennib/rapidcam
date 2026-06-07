import { Vec2 } from "../core/vec2";
import { TextEntity } from "../model/entities";
import { Tool, ToolContext, ToolPointerEvent, ToolOverlay } from "./tool";
import { ICONS } from "./icons";
import { listFonts, defaultFontId, loadFromFile, initBundledFonts } from "../core/fontManager";

export class TextTool implements Tool {
  readonly id = "text";
  readonly label = "Text (T)";
  readonly icon = ICONS.text;

  private pendingText = "";
  private pendingFontId = "";
  private pendingSizeMM = 10;
  private pendingAngle = 0;
  private hoverPos: Vec2 | null = null;
  private backdrop: HTMLElement | null = null;
  private fontSelectEl: HTMLSelectElement | null = null;

  onActivate(ctx: ToolContext): void {
    this.hoverPos = null;
    // Ensure bundled fonts are loaded; refresh the selector when each arrives
    void initBundledFonts(() => this.refreshFontSelect());
    this.openDialog(ctx);
  }

  onDeactivate(_ctx: ToolContext): void {
    this.closeDialog();
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    if (!this.pendingText) return;
    this.hoverPos = e.world;
    ctx.requestRender();
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0 || !this.pendingText || !this.hoverPos || !this.pendingFontId) return;

    ctx.pushHistory();
    const ent = new TextEntity(
      this.pendingText,
      this.pendingFontId,
      this.pendingSizeMM,
      { ...this.hoverPos },
      this.pendingAngle,
    );
    ctx.doc.addSelected(ent);
    ctx.requestRender();
  }

  cancel(ctx: ToolContext): void {
    this.closeDialog();
    this.pendingText = "";
    this.hoverPos = null;
    ctx.requestRender();
  }

  getOverlay(): ToolOverlay {
    if (!this.pendingText || !this.hoverPos) return { previews: [], selectionRect: null };
    const pos = this.hoverPos;
    const w = this.pendingSizeMM * 0.6 * Math.max(this.pendingText.length, 1);
    const h = this.pendingSizeMM * 1.2;
    const cos = Math.cos(this.pendingAngle), sin = Math.sin(this.pendingAngle);
    const corners = [
      { x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h },
    ].map(p => ({
      x: pos.x + p.x * cos - p.y * sin,
      y: pos.y + p.x * sin + p.y * cos,
    }));
    return {
      previews: [{ kind: "polyline", points: corners, closed: true }],
      selectionRect: null,
    };
  }

  // --- font select refresh ---

  private refreshFontSelect(): void {
    if (!this.fontSelectEl) return;
    const fonts = listFonts();
    this.fontSelectEl.innerHTML = "";
    if (fonts.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "— Load a font below —";
      this.fontSelectEl.appendChild(opt);
      return;
    }
    for (const f of fonts) {
      const opt = document.createElement("option");
      opt.value = f.id;
      opt.textContent = f.name;
      if (f.id === this.pendingFontId) opt.selected = true;
      this.fontSelectEl.appendChild(opt);
    }
    if (!this.pendingFontId || !fonts.find(f => f.id === this.pendingFontId)) {
      this.pendingFontId = defaultFontId();
      if (this.fontSelectEl.options.length > 0) {
        this.fontSelectEl.value = this.pendingFontId;
      }
    }
  }

  // --- dialog ----------------------------------------------------------------

  private closeDialog(): void {
    if (this.backdrop) {
      this.backdrop.remove();
      this.backdrop = null;
      this.fontSelectEl = null;
    }
  }

  private openDialog(ctx: ToolContext): void {
    this.closeDialog();

    const backdrop = document.createElement("div");
    backdrop.className = "tp-backdrop";
    backdrop.addEventListener("click", e => { if (e.target === backdrop) this.cancel(ctx); });
    this.backdrop = backdrop;

    const dialog = document.createElement("div");
    dialog.className = "tp-dialog";
    dialog.style.width = "320px";
    dialog.addEventListener("click", e => e.stopPropagation());

    const hdr = document.createElement("div");
    hdr.className = "tp-dialog-header";
    const h3 = document.createElement("h3");
    h3.textContent = "Place Text";
    hdr.appendChild(h3);
    dialog.appendChild(hdr);

    const body = document.createElement("div");
    body.className = "tp-dialog-body";
    dialog.appendChild(body);

    // Text content
    const textInp = addField(body, "Text", inp => {
      inp.type = "text";
      inp.className = "dim";
      inp.value = this.pendingText || "";
      inp.style.width = "200px";
      inp.placeholder = "Enter text…";
    }) as HTMLInputElement;

    // Font selector
    const fontRow = document.createElement("div");
    fontRow.className = "tp-field";
    const fontLbl = document.createElement("label");
    fontLbl.textContent = "Font";
    fontRow.appendChild(fontLbl);
    const fontSel = document.createElement("select");
    fontSel.className = "dim";
    fontSel.style.width = "180px";
    this.fontSelectEl = fontSel;
    fontRow.appendChild(fontSel);
    body.appendChild(fontRow);
    this.refreshFontSelect();

    // Load font file button
    const loadRow = document.createElement("div");
    loadRow.className = "tp-field";
    loadRow.appendChild(document.createElement("label")); // spacer
    const loadBtn = document.createElement("button");
    loadBtn.className = "btn";
    loadBtn.textContent = "Load font (.ttf/.otf/.woff)…";
    loadBtn.style.fontSize = "11px";
    loadBtn.addEventListener("click", () => {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = ".ttf,.otf,.woff,.woff2";
      inp.onchange = async () => {
        const file = inp.files?.[0];
        if (!file) return;
        try {
          const { id } = await loadFromFile(file);
          this.pendingFontId = id;
          this.refreshFontSelect();
        } catch (e) {
          alert(`Could not load font: ${(e as Error).message}`);
        }
      };
      inp.click();
    });
    loadRow.appendChild(loadBtn);
    body.appendChild(loadRow);

    // Size
    const sizeInp = addField(body, "Height (mm)", inp => {
      inp.type = "number";
      inp.className = "dim";
      inp.value = this.pendingSizeMM.toString();
      inp.step = "0.5";
      inp.min = "0.5";
      inp.style.width = "90px";
    }) as HTMLInputElement;

    // Angle
    const angleInp = addField(body, "Angle (°)", inp => {
      inp.type = "number";
      inp.className = "dim";
      inp.value = (this.pendingAngle * 180 / Math.PI).toFixed(1);
      inp.step = "5";
      inp.style.width = "90px";
    }) as HTMLInputElement;

    fontSel.addEventListener("change", () => {
      this.pendingFontId = fontSel.value;
    });

    // Footer
    const ftr = document.createElement("div");
    ftr.className = "tp-dialog-footer";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => this.cancel(ctx));

    const stampBtn = document.createElement("button");
    stampBtn.className = "btn tp-apply-btn";
    stampBtn.textContent = "Stamp (click canvas)";
    stampBtn.addEventListener("click", () => {
      const text = textInp.value.trim();
      if (!text) { textInp.focus(); return; }
      if (!fontSel.value) { alert("Please select or load a font first."); return; }
      this.pendingText = text;
      this.pendingFontId = fontSel.value;
      this.pendingSizeMM = Math.max(0.5, parseFloat(sizeInp.value) || 10);
      this.pendingAngle = (parseFloat(angleInp.value) || 0) * Math.PI / 180;
      this.closeDialog();
      ctx.requestRender();
    });

    ftr.appendChild(cancelBtn);
    ftr.appendChild(stampBtn);
    dialog.appendChild(ftr);
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    setTimeout(() => textInp.focus(), 0);
  }
}

function addField(
  parent: HTMLElement,
  label: string,
  configure: (inp: HTMLInputElement) => void,
): HTMLInputElement {
  const row = document.createElement("div");
  row.className = "tp-field";
  const lbl = document.createElement("label");
  lbl.textContent = label;
  const inp = document.createElement("input");
  configure(inp);
  row.appendChild(lbl);
  row.appendChild(inp);
  parent.appendChild(row);
  return inp;
}
