import { Vec2 } from "../core/vec2";
import { LineEntity } from "../model/entities";
import { Tool, ToolContext, ToolPointerEvent, ToolOverlay } from "./tool";
import { ICONS } from "./icons";
import { nextId } from "../model/ids";

// Import hershey fonts directly from the JSON
import hersheyFonts from "hersheytext/hersheytext.min.json";

export class TextTool implements Tool {
  readonly id = "text";
  readonly label = "Text (T)";
  readonly icon = ICONS.text;

  private pendingText = "";
  private pendingFont = "futural";
  private pendingHeight = 10;
  private previewLines: { a: Vec2; b: Vec2 }[] = [];
  private hoverPos: Vec2 | null = null;
  private backdrop: HTMLElement | null = null;

  onActivate(ctx: ToolContext): void {
    this.hoverPos = null;
    this.previewLines = [];
    this.openTextDialog(ctx);
  }

  onDeactivate(_ctx: ToolContext): void {
    if (this.backdrop) {
      this.backdrop.remove();
      this.backdrop = null;
    }
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    if (!this.pendingText) return;
    this.hoverPos = e.world;
    this.updatePreview();
    ctx.requestRender();
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0 || !this.pendingText || !this.hoverPos || this.previewLines.length === 0) return;

    ctx.pushHistory();

    const entities: LineEntity[] = [];
    for (const line of this.previewLines) {
      entities.push(new LineEntity({ ...line.a }, { ...line.b }));
    }

    const gId = nextId("grp");
    ctx.doc.groups.push({ id: gId, entityIds: entities.map(e => e.id) });
    ctx.doc.entities.push(...entities);

    ctx.doc.emitChange();
    this.pendingText = "";
    this.previewLines = [];
    ctx.requestRender();
    
    // Automatically switch back to select tool after placing
    // (Handled by app or user, we can just clear state for now)
  }

  cancel(ctx: ToolContext): void {
    this.pendingText = "";
    this.previewLines = [];
    if (this.backdrop) {
      this.backdrop.remove();
      this.backdrop = null;
    }
    ctx.requestRender();
  }

  getOverlay(): ToolOverlay {
    if (this.previewLines.length === 0) return { previews: [], selectionRect: null };
    return {
      previews: this.previewLines.map(l => ({ kind: "line", a: l.a, b: l.b })),
      selectionRect: null,
    };
  }

  private updatePreview() {
    if (!this.hoverPos || !this.pendingText) {
      this.previewLines = [];
      return;
    }

    this.previewLines = this.parseText(this.pendingText, this.pendingFont, this.pendingHeight, this.hoverPos);
  }

  private parseText(text: string, fontName: string, height: number, pos: Vec2): { a: Vec2; b: Vec2 }[] {
    const font = (hersheyFonts as any)[fontName];
    if (!font) return [];

    const lines: { a: Vec2; b: Vec2 }[] = [];
    
    // Hershey units-per-em is typically 10 for standard height.
    const fontHeight = 10;
    const scale = height / fontHeight;
    const charSpacing = 2 * scale; // Add a bit of space between chars

    let cursorX = pos.x;
    let cursorY = pos.y; // Bottom left anchor

    for (const charStr of text) {
      const charCode = charStr.charCodeAt(0) - 33; // Hershey fonts are indexed from ascii 33
      let charData = null;
      let charWidth = 10; // Default space width
      
      if (charStr === " ") {
        cursorX += charWidth * scale + charSpacing;
        continue;
      }

      if (charCode >= 0 && charCode < font.chars.length) {
        charData = font.chars[charCode];
      }

      if (!charData) {
        cursorX += charWidth * scale + charSpacing;
        continue;
      }

      charWidth = parseInt(charData.o, 10) || 10;
      const d = charData.d as string;

      if (d) {
        // Parse "M5,1 L5,15 4,21" style SVG
        const tokens = d.replace(/([ML])/g, ' $1 ').replace(/,/g, ' ').trim().split(/\s+/);
        let currentLine: Vec2[] = [];
        let cmd = "M";

        for (let i = 0; i < tokens.length; ) {
          const t = tokens[i];
          if (t === "M" || t === "L") {
            cmd = t;
            i++;
          } else {
            const x = parseFloat(tokens[i]);
            const y = parseFloat(tokens[i+1]);
            i += 2;

            if (!isNaN(x) && !isNaN(y)) {
              // Y is inverted in SVG compared to CAD
              const pt = { 
                x: cursorX + x * scale, 
                y: cursorY - y * scale + height // Add height so origin is bottom-left
              };

              if (cmd === "M") {
                if (currentLine.length > 1) {
                  for (let j = 0; j < currentLine.length - 1; j++) {
                    lines.push({ a: currentLine[j], b: currentLine[j+1] });
                  }
                }
                currentLine = [pt];
                cmd = "L"; // implicit L
              } else if (cmd === "L") {
                currentLine.push(pt);
              }
            }
          }
        }
        if (currentLine.length > 1) {
          for (let j = 0; j < currentLine.length - 1; j++) {
            lines.push({ a: currentLine[j], b: currentLine[j+1] });
          }
        }
      }

      cursorX += charWidth * scale + charSpacing;
    }

    return lines;
  }

  // --- UI Dialog ---
  private openTextDialog(ctx: ToolContext) {
    if (this.backdrop) this.backdrop.remove();

    const backdrop = document.createElement("div");
    backdrop.className = "tp-backdrop";
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) this.cancel(ctx); });
    this.backdrop = backdrop;

    const dialog = document.createElement("div");
    dialog.className = "tp-dialog";
    dialog.style.width = "300px";
    dialog.addEventListener("click", (e) => e.stopPropagation());

    const hdr = document.createElement("div");
    hdr.className = "tp-dialog-header";
    const h3 = document.createElement("h3");
    h3.textContent = "Create Engraving Text";
    hdr.appendChild(h3);
    dialog.appendChild(hdr);

    const body = document.createElement("div");
    body.className = "tp-dialog-body";
    dialog.appendChild(body);

    // Text input
    const textGroup = document.createElement("div");
    textGroup.className = "tp-field";
    const textLbl = document.createElement("label");
    textLbl.textContent = "Text";
    const textInp = document.createElement("input");
    textInp.type = "text";
    textInp.className = "dim";
    textInp.value = this.pendingText || "RapidCAM";
    textInp.style.width = "150px";
    textGroup.appendChild(textLbl);
    textGroup.appendChild(textInp);
    body.appendChild(textGroup);

    // Height input
    const heightGroup = document.createElement("div");
    heightGroup.className = "tp-field";
    const heightLbl = document.createElement("label");
    heightLbl.textContent = "Height (mm)";
    const heightInp = document.createElement("input");
    heightInp.type = "number";
    heightInp.className = "dim";
    heightInp.value = this.pendingHeight.toString();
    heightInp.step = "any";
    heightInp.style.width = "90px";
    heightGroup.appendChild(heightLbl);
    heightGroup.appendChild(heightInp);
    body.appendChild(heightGroup);

    // Font select
    const fontGroup = document.createElement("div");
    fontGroup.className = "tp-field";
    const fontLbl = document.createElement("label");
    fontLbl.textContent = "Font";
    const fontSelect = document.createElement("select");
    fontSelect.className = "dim";
    fontSelect.style.width = "150px";
    
    // Populate font list
    const fonts = Object.keys(hersheyFonts).sort();
    for (const f of fonts) {
      const opt = document.createElement("option");
      opt.value = f;
      opt.textContent = f;
      if (f === this.pendingFont) opt.selected = true;
      fontSelect.appendChild(opt);
    }
    fontGroup.appendChild(fontLbl);
    fontGroup.appendChild(fontSelect);
    body.appendChild(fontGroup);

    // Footer
    const ftr = document.createElement("div");
    ftr.className = "tp-dialog-footer";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => this.cancel(ctx));

    const applyBtn = document.createElement("button");
    applyBtn.className = "btn tp-apply-btn";
    applyBtn.textContent = "Stamp";
    applyBtn.addEventListener("click", () => {
      this.pendingText = textInp.value;
      this.pendingHeight = parseFloat(heightInp.value) || 10;
      this.pendingFont = fontSelect.value;
      this.updatePreview();
      ctx.requestRender();
      backdrop.remove();
      this.backdrop = null;
    });

    ftr.appendChild(cancelBtn);
    ftr.appendChild(applyBtn);
    dialog.appendChild(ftr);

    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    
    setTimeout(() => textInp.focus(), 0);
  }
}
