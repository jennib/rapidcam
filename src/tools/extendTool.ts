/**
 * Extend tool: click the end of a line or arc you want to lengthen; it grows in
 * its own direction until it meets the nearest other entity. The companion to
 * Trim. Hover shows a preview of the resulting entity. Key: E.
 */

import { Vec2 } from "../core/vec2";
import { Entity, LineEntity, ArcEntity, TextEntity, PointEntity } from "../model/entities";
import { CADDocument } from "../model/document";
import { Tool, ToolContext, ToolOverlay, ToolPointerEvent } from "./tool";
import { distToSegment, distToArc } from "../core/geom";
import { lineExtension, arcExtension } from "./extend";
import { PreviewShape } from "../view/overlay";
import { ICONS } from "./icons";

const HIT_PX = 12;

type Hit =
  | { kind: "line"; ent: LineEntity; end: "a" | "b"; target: Vec2 }
  | { kind: "arc"; ent: ArcEntity; end: "start" | "end"; angle: number };

/** Entities that can serve as extension boundaries (everything but self/construction/markers). */
function targets(doc: CADDocument, selfId: string): Entity[] {
  return doc.entities.filter((e) =>
    e.id !== selfId && !e.isConstruction && !(e instanceof TextEntity) && !(e instanceof PointEntity));
}

export class ExtendTool implements Tool {
  readonly id = "extend";
  readonly label = "Extend";
  readonly icon = ICONS.extend;

  private hover: PreviewShape | null = null;

  private hit(worldPos: Vec2, doc: CADDocument, scale: number): Hit | null {
    const thresh = HIT_PX / scale;
    let best: { ent: Entity; d: number } | null = null;
    for (const ent of doc.entities) {
      if (ent.isConstruction) continue;
      let d: number;
      if (ent instanceof LineEntity) d = distToSegment(worldPos, ent.a, ent.b);
      else if (ent instanceof ArcEntity) d = distToArc(worldPos, ent.center, ent.radius, ent.startAngle, ent.endAngle);
      else continue; // only lines and arcs can be extended
      if (d < thresh && (!best || d < best.d)) best = { ent, d };
    }
    if (!best) return null;

    if (best.ent instanceof LineEntity) {
      const ext = lineExtension(best.ent, worldPos, targets(doc, best.ent.id));
      return ext ? { kind: "line", ent: best.ent, end: ext.end, target: ext.target } : null;
    }
    const arc = best.ent as ArcEntity;
    const ext = arcExtension(arc, worldPos, targets(doc, arc.id));
    return ext ? { kind: "arc", ent: arc, end: ext.end, angle: ext.angle } : null;
  }

  private previewFor(h: Hit): PreviewShape {
    if (h.kind === "line") {
      const a = h.end === "a" ? h.target : h.ent.a;
      const b = h.end === "b" ? h.target : h.ent.b;
      return { kind: "line", a, b };
    }
    const startAngle = h.end === "start" ? h.angle : h.ent.startAngle;
    const endAngle = h.end === "end" ? h.angle : h.ent.endAngle;
    return { kind: "arc", center: h.ent.center, radius: h.ent.radius, startAngle, endAngle };
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    const h = this.hit(e.worldRaw, ctx.doc, ctx.view.scale);
    this.hover = h ? this.previewFor(h) : null;
    ctx.requestRender();
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    const h = this.hit(e.worldRaw, ctx.doc, ctx.view.scale);
    if (!h) return;
    ctx.pushHistory();
    if (h.kind === "line") {
      if (h.end === "a") h.ent.a = { ...h.target };
      else h.ent.b = { ...h.target };
    } else {
      if (h.end === "start") h.ent.startAngle = h.angle;
      else h.ent.endAngle = h.angle;
    }
    ctx.solve();
    ctx.doc.emitChange();
    this.hover = null;
  }

  cancel(ctx: ToolContext): void {
    this.hover = null;
    ctx.requestRender();
  }

  getOverlay(): ToolOverlay {
    if (!this.hover) return { previews: [], selectionRect: null };
    return { previews: [this.hover], selectionRect: null };
  }
}
