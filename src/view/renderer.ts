/** Canvas renderer. Draws grid, work-area, geometry, and transient overlays. */

import { Vec2 } from "../core/vec2";
import { Unit, fromMM } from "../core/units";
import { CADDocument, resolveOrigin } from "../model/document";
import {
  Entity,
  LineEntity,
  CircleEntity,
  RectEntity,
  PolylineEntity,
  ArcEntity,
  BezierEntity,
} from "../model/entities";
import { constraintAnchor, CONSTRAINT_GLYPH, Geo } from "../model/constraints";
import { dimensionLayout } from "../model/dimensions";
import { Viewport } from "./viewport";
import { computeGrid } from "./grid";
import { COLORS } from "./colors";
import { Overlay, PreviewShape } from "./overlay";

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
  }

  /** Resize the backing store to the host element; returns CSS pixel size. */
  resize(): { width: number; height: number } {
    const host = this.canvas.parentElement!;
    const rect = host.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    return { width: rect.width, height: rect.height };
  }

  render(doc: CADDocument, view: Viewport, overlay: Overlay): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, view.width, view.height);

    this.drawGrid(doc, view);
    this.drawWorkArea(doc, view);
    this.drawOrigin(doc, view);
    this.drawEntities(doc, view, overlay);
    this.drawDimensions(doc, view);
    this.drawConstraints(doc, view);
    this.drawSelectedPoints(doc, view);
    this.drawSelectionRect(view, overlay);
    this.drawPreviews(view, overlay.previews);
    this.drawSnap(view, overlay);
    this.drawTransformBox(view, overlay);
  }

  // --- grid ----------------------------------------------------------------
  private drawGrid(doc: CADDocument, view: Viewport): void {
    const ctx = this.ctx;
    const unit = doc.displayUnit;
    const spec = computeGrid(view.scale, unit);
    const vb = view.visibleWorldBounds();

    const drawLines = (stepMM: number, color: string, lineWidth: number) => {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      // vertical lines (constant world x)
      const x0 = Math.floor(vb.min.x / stepMM) * stepMM;
      for (let x = x0; x <= vb.max.x; x += stepMM) {
        const sx = Math.round(view.worldToScreen({ x, y: 0 }).x) + 0.5;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, view.height);
      }
      // horizontal lines (constant world y)
      const y0 = Math.floor(vb.min.y / stepMM) * stepMM;
      for (let y = y0; y <= vb.max.y; y += stepMM) {
        const sy = Math.round(view.worldToScreen({ x: 0, y }).y) + 0.5;
        ctx.moveTo(0, sy);
        ctx.lineTo(view.width, sy);
      }
      ctx.stroke();
    };

    // Only draw minor lines when they aren't too dense to be useful.
    if (view.toScreenLen(spec.minorMM) >= 6) {
      drawLines(spec.minorMM, COLORS.gridMinor, 1);
    }
    drawLines(spec.majorMM, COLORS.gridMajor, 1);

    this.drawAxes(view);
    this.drawGridLabels(view, spec.majorMM, unit, spec.labelDecimals);
  }

  private drawAxes(view: Viewport): void {
    const ctx = this.ctx;
    const origin = view.worldToScreen({ x: 0, y: 0 });
    ctx.lineWidth = 1.2;
    // Y axis (world x = 0) — vertical green line
    if (origin.x >= 0 && origin.x <= view.width) {
      const sx = Math.round(origin.x) + 0.5;
      ctx.strokeStyle = COLORS.axisY;
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, view.height);
      ctx.stroke();
    }
    // X axis (world y = 0) — horizontal red line
    if (origin.y >= 0 && origin.y <= view.height) {
      const sy = Math.round(origin.y) + 0.5;
      ctx.strokeStyle = COLORS.axisX;
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(view.width, sy);
      ctx.stroke();
    }
  }

  private drawGridLabels(view: Viewport, majorMM: number, unit: Unit, decimals: number): void {
    const ctx = this.ctx;
    const vb = view.visibleWorldBounds();
    ctx.fillStyle = COLORS.gridLabel;
    ctx.font = "10px ui-monospace, monospace";

    const fmt = (mm: number) => fromMM(mm, unit).toFixed(decimals);

    // X labels along the bottom edge
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    const bottomY = view.height - 3;
    const x0 = Math.floor(vb.min.x / majorMM) * majorMM;
    for (let x = x0; x <= vb.max.x; x += majorMM) {
      const sx = view.worldToScreen({ x, y: 0 }).x;
      if (sx < 14 || sx > view.width - 4) continue;
      ctx.fillText(fmt(x), sx, bottomY);
    }

    // Y labels along the left edge
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const y0 = Math.floor(vb.min.y / majorMM) * majorMM;
    for (let y = y0; y <= vb.max.y; y += majorMM) {
      const sy = view.worldToScreen({ x: 0, y }).y;
      if (sy < 8 || sy > view.height - 14) continue;
      ctx.fillText(fmt(y), 4, sy);
    }
  }

  // --- work area -----------------------------------------------------------
  private drawWorkArea(doc: CADDocument, view: Viewport): void {
    const ctx = this.ctx;
    const a = view.worldToScreen({ x: 0, y: 0 });
    const b = view.worldToScreen({ x: doc.canvas.width, y: doc.canvas.height });
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);

    ctx.save();
    ctx.fillStyle = COLORS.workArea;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = COLORS.workAreaBorder;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
    ctx.restore();
  }

  // --- origin marker -------------------------------------------------------
  private drawOrigin(doc: CADDocument, view: Viewport): void {
    const ctx = this.ctx;
    const { ox, oy } = resolveOrigin(doc);
    const o = view.worldToScreen({ x: ox, y: oy });
    const arm = 22; // screen px

    ctx.save();
    ctx.lineWidth = 1.5;

    // X arm → red
    ctx.strokeStyle = "#e05555";
    ctx.fillStyle = "#e05555";
    ctx.beginPath();
    ctx.moveTo(o.x, o.y);
    ctx.lineTo(o.x + arm, o.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(o.x + arm, o.y);
    ctx.lineTo(o.x + arm - 6, o.y - 3.5);
    ctx.lineTo(o.x + arm - 6, o.y + 3.5);
    ctx.closePath();
    ctx.fill();

    // Y arm ↑ green
    ctx.strokeStyle = "#4fc87a";
    ctx.fillStyle = "#4fc87a";
    ctx.beginPath();
    ctx.moveTo(o.x, o.y);
    ctx.lineTo(o.x, o.y - arm);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(o.x, o.y - arm);
    ctx.lineTo(o.x - 3.5, o.y - arm + 6);
    ctx.lineTo(o.x + 3.5, o.y - arm + 6);
    ctx.closePath();
    ctx.fill();

    // Centre dot
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(o.x, o.y, 2.5, 0, Math.PI * 2);
    ctx.stroke();

    // Axis labels
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillStyle = "#e05555";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("X", o.x + arm + 4, o.y);
    ctx.fillStyle = "#4fc87a";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText("Y", o.x, o.y - arm - 3);

    ctx.restore();
  }

  // --- entities ------------------------------------------------------------
  private drawEntities(doc: CADDocument, view: Viewport, overlay: Overlay): void {
    const vb = view.visibleWorldBounds();
    for (const e of doc.entities) {
      const b = e.bounds();
      if (b.max.x < vb.min.x || b.min.x > vb.max.x ||
          b.max.y < vb.min.y || b.min.y > vb.max.y) continue;
      const isHover = overlay.hover === e.id;
      const color = e.selected
        ? COLORS.entitySelected
        : isHover
          ? COLORS.entityHover
          : e.isConstruction
            ? COLORS.entityConstruction
            : COLORS.entity;
      const width = e.selected ? 2 : 1.5;
      this.ctx.save();
      if (e.isConstruction) {
        this.ctx.setLineDash([5, 5]);
      }
      this.drawEntity(e, view, color, width);
      this.ctx.restore();
      if (e.selected && !doc.groupOf(e.id)) this.drawHandles(e, view);
    }
  }

  private drawEntity(e: Entity, view: Viewport, color: string, width: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    switch (e.type) {
      case "line": {
        const l = e as LineEntity;
        this.moveTo(l.a, view);
        this.lineTo(l.b, view);
        break;
      }
      case "circle": {
        const c = e as CircleEntity;
        const s = view.worldToScreen(c.center);
        ctx.arc(s.x, s.y, view.toScreenLen(c.radius), 0, Math.PI * 2);
        break;
      }
      case "rectangle": {
        const r = e as RectEntity;
        const c = r.corners().map((p) => view.worldToScreen(p));
        ctx.moveTo(c[0].x, c[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y);
        ctx.closePath();
        break;
      }
      case "polyline": {
        const pl = e as PolylineEntity;
        if (pl.points.length > 0) {
          this.moveTo(pl.points[0], view);
          for (let i = 1; i < pl.points.length; i++) this.lineTo(pl.points[i], view);
          if (pl.closed) ctx.closePath();
        }
        break;
      }
      case "arc": {
        const arc = e as ArcEntity;
        const sc = view.worldToScreen(arc.center);
        const sr = view.toScreenLen(arc.radius);
        // World CCW arc → canvas anticlockwise=true, angles negated (Y-flip).
        ctx.arc(sc.x, sc.y, sr, -arc.startAngle, -arc.endAngle, true);
        break;
      }
      case "bezier": {
        const bz = e as BezierEntity;
        const s0 = view.worldToScreen(bz.p0);
        const s1 = view.worldToScreen(bz.p1);
        const s2 = view.worldToScreen(bz.p2);
        const s3 = view.worldToScreen(bz.p3);
        ctx.moveTo(s0.x, s0.y);
        ctx.bezierCurveTo(s1.x, s1.y, s2.x, s2.y, s3.x, s3.y);
        break;
      }
    }
    ctx.stroke();
  }

  private drawHandles(e: Entity, view: Viewport): void {
    if (e.type === "bezier") { this.drawBezierHandles(e as BezierEntity, view); return; }
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.entitySelected;
    for (const sp of e.snapPoints()) {
      if (sp.kind === "midpoint" || sp.kind === "quadrant") continue;
      const s = view.worldToScreen(sp.pos);
      ctx.fillRect(s.x - 2.5, s.y - 2.5, 5, 5);
    }
  }

  private drawBezierHandles(e: BezierEntity, view: Viewport): void {
    const ctx = this.ctx;
    const s0 = view.worldToScreen(e.p0), s1 = view.worldToScreen(e.p1);
    const s2 = view.worldToScreen(e.p2), s3 = view.worldToScreen(e.p3);

    // Control arms (dashed, half-opacity)
    ctx.save();
    ctx.strokeStyle = COLORS.entitySelected;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(s0.x, s0.y); ctx.lineTo(s1.x, s1.y);
    ctx.moveTo(s3.x, s3.y); ctx.lineTo(s2.x, s2.y);
    ctx.stroke();
    ctx.restore();

    // Endpoint squares (p0, p3)
    ctx.fillStyle = COLORS.entitySelected;
    for (const s of [s0, s3]) ctx.fillRect(s.x - 2.5, s.y - 2.5, 5, 5);

    // Control handle circles (p1, p2)
    ctx.strokeStyle = COLORS.entitySelected;
    ctx.lineWidth = 1.5;
    for (const s of [s1, s2]) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, 3.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // --- dimensions ----------------------------------------------------------
  private drawDimensions(doc: CADDocument, view: Viewport): void {
    if (doc.dimensions.length === 0) return;
    const ctx = this.ctx;
    const byId = new Map(doc.entities.map((e) => [e.id, e]));
    const geo: Geo = (id) => byId.get(id);
    const unit = doc.displayUnit;

    for (const dim of doc.dimensions) {
      const layout = dimensionLayout(dim, geo, unit);
      if (!layout) continue;

      const isSelected = dim.id === doc.selectedDimensionId;
      ctx.strokeStyle = isSelected ? COLORS.entitySelected : COLORS.dimension;
      ctx.fillStyle = isSelected ? COLORS.entitySelected : COLORS.dimension;
      ctx.lineWidth = isSelected ? 1.5 : 1;
      ctx.beginPath();
      for (const [a, b] of layout.segments) {
        const sa = view.worldToScreen(a);
        const sb = view.worldToScreen(b);
        ctx.moveTo(sa.x, sa.y);
        ctx.lineTo(sb.x, sb.y);
      }
      ctx.stroke();

      if (layout.arc) {
        const { center, radius, startDir, endDir, ccw } = layout.arc;
        const sc = view.worldToScreen(center);
        const sr = view.toScreenLen(radius);
        ctx.beginPath();
        ctx.arc(sc.x, sc.y, sr,
          -Math.atan2(startDir.y, startDir.x),
          -Math.atan2(endDir.y, endDir.x),
          ccw);
        ctx.stroke();
      }
      for (const ar of layout.arrows) this.drawArrowHead(ar.tip, ar.dir, view);
      this.drawDimText(view.worldToScreen(layout.textPos), layout.label, dim.driving, isSelected);
    }
  }

  private drawArrowHead(tipWorld: Vec2, dirWorld: Vec2, view: Viewport): void {
    const ctx = this.ctx;
    const a = view.worldToScreen(tipWorld);
    const b = view.worldToScreen({ x: tipWorld.x + dirWorld.x, y: tipWorld.y + dirWorld.y });
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    const L = 9;
    const W = 3.2;
    const bx = a.x - dx * L;
    const by = a.y - dy * L;
    const px = -dy;
    const py = dx;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(bx + px * W, by + py * W);
    ctx.lineTo(bx - px * W, by - py * W);
    ctx.closePath();
    ctx.fill();
  }

  private drawDimText(pos: Vec2, label: string, driving: boolean, isSelected = false): void {
    const ctx = this.ctx;
    ctx.font = "11px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const w = ctx.measureText(label).width;
    const padX = 4;
    const h = 15;
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(pos.x - w / 2 - padX, pos.y - h / 2, w + padX * 2, h);
    ctx.fillStyle = isSelected
      ? COLORS.entitySelected
      : driving
        ? COLORS.dimensionText
        : COLORS.dimensionTextRef;
    ctx.fillText(label, pos.x, pos.y + 0.5);
  }

  // --- constraints ---------------------------------------------------------
  private drawConstraints(doc: CADDocument, view: Viewport): void {
    if (doc.constraints.length === 0) return;
    const ctx = this.ctx;
    const byId = new Map(doc.entities.map((e) => [e.id, e]));
    const geo: Geo = (id) => byId.get(id);
    const stack = new Map<string, number>(); // spread multiple badges at one anchor

    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (const c of doc.constraints) {
      const anchor = constraintAnchor(c, geo);
      if (!anchor) continue;
      const s = view.worldToScreen(anchor);
      const cellKey = `${Math.round(s.x / 16)},${Math.round(s.y / 16)}`;
      const n = stack.get(cellKey) ?? 0;
      stack.set(cellKey, n + 1);

      const bx = s.x + 10 + n * 16;
      const by = s.y - 10;
      const r = 7;

      const isSelected = c.id === doc.selectedConstraintId;
      ctx.fillStyle = isSelected ? COLORS.entitySelected : COLORS.constraintBadgeBg;
      ctx.strokeStyle = isSelected ? COLORS.selectedPointRing : COLORS.constraintBadgeBorder;
      ctx.lineWidth = 1;
      roundRect(ctx, bx - r, by - r, r * 2, r * 2, 3);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = isSelected ? "#ffffff" : COLORS.constraintGlyph;
      ctx.fillText(CONSTRAINT_GLYPH[c.type], bx, by + 0.5);
    }
  }

  private drawSelectedPoints(doc: CADDocument, view: Viewport): void {
    if (doc.selectedPoints.length === 0) return;
    const ctx = this.ctx;
    const byId = new Map(doc.entities.map((e) => [e.id, e]));
    for (const ref of doc.selectedPoints) {
      const ent = byId.get(ref.entityId);
      if (!ent) continue;
      let pos: Vec2;
      try {
        pos = ent.getPoint(ref.key);
      } catch {
        continue;
      }
      const s = view.worldToScreen(pos);
      ctx.fillStyle = COLORS.selectedPoint;
      ctx.strokeStyle = COLORS.selectedPointRing;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.rect(s.x - 4, s.y - 4, 8, 8);
      ctx.fill();
      ctx.stroke();
    }
  }

  // --- overlays ------------------------------------------------------------
  private drawPreviews(view: Viewport, previews: PreviewShape[]): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = COLORS.preview;
    ctx.lineWidth = 1.5;
    for (const p of previews) {
      ctx.beginPath();
      switch (p.kind) {
        case "line":
          this.moveTo(p.a, view);
          this.lineTo(p.b, view);
          ctx.stroke();
          break;
        case "circle": {
          const s = view.worldToScreen(p.center);
          ctx.arc(s.x, s.y, view.toScreenLen(p.radius), 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case "arc": {
          const sc = view.worldToScreen(p.center);
          const sr = view.toScreenLen(p.radius);
          ctx.arc(sc.x, sc.y, sr, -p.startAngle, -p.endAngle, true);
          ctx.stroke();
          break;
        }
        case "bezier": {
          const s0 = view.worldToScreen(p.p0), s1 = view.worldToScreen(p.p1);
          const s2 = view.worldToScreen(p.p2), s3 = view.worldToScreen(p.p3);
          ctx.moveTo(s0.x, s0.y);
          ctx.bezierCurveTo(s1.x, s1.y, s2.x, s2.y, s3.x, s3.y);
          ctx.stroke();
          break;
        }
        case "rect": {
          const a = view.worldToScreen(p.p0);
          const b = view.worldToScreen(p.p1);
          ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
          break;
        }
        case "polyline":
          if (p.points.length > 0) {
            this.moveTo(p.points[0], view);
            for (let i = 1; i < p.points.length; i++) this.lineTo(p.points[i], view);
            if (p.closed) ctx.closePath();
            ctx.stroke();
          }
          break;
        case "point": {
          ctx.setLineDash([]);
          const s = view.worldToScreen(p.pos);
          ctx.fillStyle = COLORS.previewPoint;
          ctx.beginPath();
          ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
          ctx.fill();
          ctx.setLineDash([5, 4]);
          break;
        }
      }
    }
    ctx.restore();
  }

  private drawSnap(view: Viewport, overlay: Overlay): void {
    if (!overlay.snap) return;
    const ctx = this.ctx;
    const s = view.worldToScreen(overlay.snap.pos);
    ctx.save();
    ctx.strokeStyle = COLORS.snapMarker;
    ctx.lineWidth = 1.5;
    const r = 5;
    // Marker shape hints at the snap kind.
    switch (overlay.snap.kind) {
      case "center":
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case "midpoint":
        ctx.beginPath();
        ctx.moveTo(s.x, s.y - r);
        ctx.lineTo(s.x + r, s.y + r);
        ctx.lineTo(s.x - r, s.y + r);
        ctx.closePath();
        ctx.stroke();
        break;
      default: // endpoint / vertex / quadrant → square
        ctx.strokeRect(s.x - r, s.y - r, r * 2, r * 2);
        break;
    }
    ctx.restore();
  }

  private drawSelectionRect(view: Viewport, overlay: Overlay): void {
    if (!overlay.selectionRect) return;
    const ctx = this.ctx;
    const a = view.worldToScreen(overlay.selectionRect.a);
    const b = view.worldToScreen(overlay.selectionRect.b);
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    ctx.save();
    ctx.fillStyle = COLORS.selectionRect;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = COLORS.selectionRectBorder;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    ctx.restore();
  }

  private drawTransformBox(view: Viewport, overlay: Overlay): void {
    if (!overlay.transformBox) return;
    const ctx = this.ctx;
    const { bounds, handles } = overlay.transformBox;

    const min = view.worldToScreen(bounds.min);
    const max = view.worldToScreen(bounds.max);

    // In world coords, Y is up. In screen coords, Y is down.
    // So min is bottom-left (max Y in screen), max is top-right (min Y in screen).
    const x = min.x;
    const y = max.y;
    const w = max.x - min.x;
    const h = min.y - max.y;

    ctx.save();
    ctx.strokeStyle = COLORS.selectionRectBorder;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 5]);
    if (!overlay.transformBox.hideBox) {
      ctx.strokeRect(x, y, w, h);
    }

    // Draw rotation stem line if rotate handle exists
    const rotHandle = handles.find(h => h.type === "rotate");
    if (rotHandle) {
      const topCenterX = x + w / 2;
      const topCenterY = y;
      const rotS = view.worldToScreen(rotHandle.pos);
      ctx.beginPath();
      ctx.moveTo(topCenterX, topCenterY);
      ctx.lineTo(rotS.x, rotS.y);
      ctx.stroke();
    }

    ctx.setLineDash([]);
    const hw = 4;
    for (const hnd of handles) {
      const s = view.worldToScreen(hnd.pos);
      if (hnd.type === "scale") {
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = COLORS.selectionRectBorder;
        ctx.lineWidth = 1.5;
        ctx.fillRect(s.x - hw, s.y - hw, hw * 2, hw * 2);
        ctx.strokeRect(s.x - hw, s.y - hw, hw * 2, hw * 2);
      } else if (hnd.type === "rotate") {
        ctx.fillStyle = "#4fc87a";
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(s.x, s.y, hw + 1.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // --- path helpers --------------------------------------------------------
  private moveTo(p: Vec2, view: Viewport): void {
    const s = view.worldToScreen(p);
    this.ctx.moveTo(s.x, s.y);
  }
  private lineTo(p: Vec2, view: Viewport): void {
    const s = view.worldToScreen(p);
    this.ctx.lineTo(s.x, s.y);
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
