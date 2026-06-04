import { Vec2, dist } from "../core/vec2";
import { applyScale, selectionBounds } from "../core/transform";
import { Entity } from "../model/entities";
import { DocSnapshot } from "../model/document";
import { Tool, ToolContext, ToolPointerEvent, ToolOverlay } from "./tool";
import { TransformBox, TransformHandle } from "../view/overlay";
import { ICONS } from "./icons";

export class ScaleTool implements Tool {
  readonly id = "scale";
  readonly label = "Scale (S)";
  readonly icon = ICONS.scale;

  private mode: "idle" | "maybeSelect" | "dragScale" | "marquee" = "idle";
  private downScreen: Vec2 = { x: 0, y: 0 };
  private dragStartWorld: Vec2 = { x: 0, y: 0 };
  private dragSnapshot: DocSnapshot | null = null;
  private originalBounds: { min: Vec2; max: Vec2 } | null = null;
  
  private marqueeStart: Vec2 = { x: 0, y: 0 };
  private marqueeEnd: Vec2 = { x: 0, y: 0 };
  private currentTransformBox: TransformBox | null = null;

  private updateTransformBox(ctx: ToolContext): void {
    const sel = ctx.doc.selected;
    if (sel.length === 0) {
      this.currentTransformBox = null;
      return;
    }
    
    // Special case for a single line: no box, just handles at endpoints
    if (sel.length === 1 && sel[0].type === "line") {
      const line = sel[0] as any;
      const b = selectionBounds(sel)!;
      this.currentTransformBox = {
        bounds: b,
        hideBox: true,
        handles: [
          { type: "scale-arrow", id: "scale-a", pos: line.a },
          { type: "scale-arrow", id: "scale-b", pos: line.b }
        ]
      };
      return;
    }

    // Special case for a drawn rectangle (4 lines forming a closed quad)
    const rectPoly = this.getRectanglePolygon(sel);
    if (rectPoly) {
      const b = selectionBounds(sel)!;
      this.currentTransformBox = {
        bounds: b,
        hideBox: true,
        polygon: rectPoly,
        handles: [
          { type: "scale-arrow", id: "scale-0", pos: rectPoly[0] },
          { type: "scale-arrow", id: "scale-1", pos: rectPoly[1] },
          { type: "scale-arrow", id: "scale-2", pos: rectPoly[2] },
          { type: "scale-arrow", id: "scale-3", pos: rectPoly[3] },
        ]
      };
      return;
    }

    const b = selectionBounds(sel);
    if (!b) {
      this.currentTransformBox = null;
      return;
    }
    const pad = 10 / ctx.view.scale; // 10px padding
    b.min.x -= pad; b.min.y -= pad;
    b.max.x += pad; b.max.y += pad;

    const handles: TransformHandle[] = [
      { type: "scale-arrow", id: "scale-nw", pos: { x: b.min.x, y: b.max.y } },
      { type: "scale-arrow", id: "scale-ne", pos: { x: b.max.x, y: b.max.y } },
      { type: "scale-arrow", id: "scale-sw", pos: { x: b.min.x, y: b.min.y } },
      { type: "scale-arrow", id: "scale-se", pos: { x: b.max.x, y: b.min.y } },
    ];
    this.currentTransformBox = { bounds: b, handles };
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    this.downScreen = e.screen;
    this.dragStartWorld = e.worldRaw;

    this.updateTransformBox(ctx);

    if (ctx.doc.selected.length > 0) {
      const tb = this.currentTransformBox;
      if (tb) {
        let hit: string | null = null;
        let hitDist = Infinity;
        for (const h of tb.handles) {
          const d = dist(e.screen, ctx.view.worldToScreen(h.pos));
          if (d < 12 && d < hitDist) {
            hit = h.id;
            hitDist = d;
          }
        }
        if (hit) {
          this.mode = "dragScale";
          ctx.pushHistory();
          this.dragSnapshot = ctx.doc.snapshot();
          this.originalBounds = tb.bounds;
          return;
        }
      }
    }

    let hitEntId: string | null = null;
    let entDist = Infinity;
    for (const ent of ctx.doc.entities) {
      const d = ent.distanceTo(e.worldRaw);
      const px = d * ctx.view.scale;
      if (px < 10 && px < entDist) {
        hitEntId = ent.id;
        entDist = px;
      }
    }

    if (hitEntId) {
      const ent = ctx.doc.entities.find((x) => x.id === hitEntId)!;
      const group = ctx.doc.groupOf(ent.id);

      if (e.shiftKey) {
        if (group) {
          const groupSelected = group.entityIds.every(id => ctx.doc.entities.find(e => e.id === id)?.selected);
          for (const id of group.entityIds) {
            const ge = ctx.doc.entities.find(x => x.id === id);
            if (ge) ge.selected = !groupSelected;
          }
        } else {
          ent.selected = !ent.selected;
        }
      } else {
        if (!ent.selected) {
          ctx.doc.clearSelection();
          if (group) {
            for (const id of group.entityIds) {
              const ge = ctx.doc.entities.find(x => x.id === id);
              if (ge) ge.selected = true;
            }
          } else {
            ent.selected = true;
          }
        }
      }
      ctx.doc.emitChange();
      this.mode = "maybeSelect";
      return;
    }

    if (!e.shiftKey) ctx.doc.clearSelection();
    this.mode = "marquee";
    this.marqueeStart = e.worldRaw;
    this.marqueeEnd = e.worldRaw;
    ctx.requestRender();
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    if (this.mode === "maybeSelect" && dist(e.screen, this.downScreen) > 4) {
      this.mode = "idle";
    }

    if (this.mode === "marquee") {
      this.marqueeEnd = e.worldRaw;
      ctx.requestRender();
    } else if (this.mode === "dragScale" && this.dragSnapshot && this.originalBounds) {
      ctx.doc.restore(this.dragSnapshot);
      const ob = this.originalBounds;
      const cx = (ob.min.x + ob.max.x) / 2;
      const cy = (ob.min.y + ob.max.y) / 2;
      
      const startDist = dist(this.dragStartWorld, { x: cx, y: cy });
      const currentDist = dist(e.worldRaw, { x: cx, y: cy });
      
      const scale = startDist > 1e-4 ? currentDist / startDist : 1;
      
      applyScale(ctx.doc.selected, cx, cy, scale, scale);
      ctx.solve();
      ctx.requestRender();
    }
    this.updateTransformBox(ctx);
  }

  onPointerUp(_e: ToolPointerEvent, ctx: ToolContext): void {
    if (this.mode === "marquee") {
      const x0 = Math.min(this.marqueeStart.x, this.marqueeEnd.x);
      const y0 = Math.min(this.marqueeStart.y, this.marqueeEnd.y);
      const x1 = Math.max(this.marqueeStart.x, this.marqueeEnd.x);
      const y1 = Math.max(this.marqueeStart.y, this.marqueeEnd.y);
      const rect = { min: { x: x0, y: y0 }, max: { x: x1, y: y1 } };
      
      for (const ent of ctx.doc.entities) {
        const eb = ent.bounds();
        if (eb.min.x >= rect.min.x && eb.max.x <= rect.max.x && eb.min.y >= rect.min.y && eb.max.y <= rect.max.y) {
          const group = ctx.doc.groupOf(ent.id);
          if (group) {
            for (const id of group.entityIds) {
              const ge = ctx.doc.entities.find(x => x.id === id);
              if (ge) ge.selected = true;
            }
          } else {
            ent.selected = true;
          }
        }
      }
    } else if (this.mode === "dragScale") {
      ctx.doc.emitChange();
    }
    
    this.mode = "idle";
    this.dragSnapshot = null;
    this.updateTransformBox(ctx);
    ctx.requestRender();
  }

  getOverlay(): ToolOverlay {
    return {
      previews: [],
      selectionRect: this.mode === "marquee" ? { a: this.marqueeStart, b: this.marqueeEnd } : null,
      transformBox: this.currentTransformBox,
    };
  }

  private getRectanglePolygon(sel: Entity[]): Vec2[] | null {
    if (sel.length !== 4) return null;
    const lines = sel.filter(e => e.type === "line") as any[];
    if (lines.length !== 4) return null;

    const pts: Vec2[] = [];
    for (const l of lines) {
      pts.push(l.a);
      pts.push(l.b);
    }

    const unique: Vec2[] = [];
    for (const p of pts) {
      if (!unique.find(u => dist(u, p) < 1e-4)) {
        unique.push(p);
      }
    }
    
    if (unique.length !== 4) return null;

    const cx = unique.reduce((sum, p) => sum + p.x, 0) / 4;
    const cy = unique.reduce((sum, p) => sum + p.y, 0) / 4;
    
    unique.sort((a, b) => {
      const angleA = Math.atan2(a.y - cy, a.x - cx);
      const angleB = Math.atan2(b.y - cy, b.x - cx);
      return angleA - angleB;
    });

    const padded = unique.map(p => {
      const dir = { x: p.x - cx, y: p.y - cy };
      const len = Math.hypot(dir.x, dir.y);
      if (len < 1e-4) return p;
      return p;
    });

    return padded;
  }
}
