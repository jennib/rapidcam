/**
 * Trim tool: click the portion of a line you want removed; it snaps to the nearest
 * intersecting lines and snips that segment away.
 *
 * Hover shows a preview (accent-coloured line) of the segment that would be removed.
 * Click applies the trim. Handles three cases:
 *   • Click is before all intersections  → shorten from endpoint a
 *   • Click is after  all intersections  → shorten from endpoint b
 *   • Click is between two intersections → split the line, removing the middle piece
 */

import { Vec2, dist } from "../core/vec2";
import { LineEntity } from "../model/entities";
import { CADDocument } from "../model/document";
import { Tool, ToolContext, ToolOverlay, ToolPointerEvent } from "./tool";
import { segSegIntersect, closestPointOnSegment } from "../core/geom";
import { ICONS } from "./icons";

const HIT_PX = 12;
const EPS    = 1e-9;

interface Intersection { point: Vec2; t: number }

function lineIntersections(line: LineEntity, doc: CADDocument): Intersection[] {
  const result: Intersection[] = [];
  for (const ent of doc.entities) {
    if (ent.id === line.id || ent.isConstruction) continue;
    if (!(ent instanceof LineEntity)) continue;
    const ix = segSegIntersect(line.a, line.b, ent.a, ent.b);
    // Only intersections that fall strictly inside the clicked line (not at endpoints).
    if (ix && ix.ta > EPS && ix.ta < 1 - EPS)
      result.push({ point: ix.point, t: ix.ta });
  }
  result.sort((a, b) => a.t - b.t);
  // Deduplicate overlapping intersections.
  return result.filter((x, i) => i === 0 || x.t - result[i - 1].t > EPS);
}

/** Work out which segment of `line` the given parameter falls in and return its endpoints. */
function segmentAt(line: LineEntity, clickT: number, ixs: Intersection[]): { a: Vec2; b: Vec2 } {
  const lo = ixs.filter(x => x.t <= clickT);
  const hi = ixs.filter(x => x.t >  clickT);
  return {
    a: lo.length ? lo[lo.length - 1].point : line.a,
    b: hi.length ? hi[0].point             : line.b,
  };
}

function removeCoincidentAt(doc: CADDocument, entityId: string, key: "a" | "b"): void {
  doc.constraints = doc.constraints.filter(c =>
    c.type !== "coincident" || !c.points.some(p => p.entityId === entityId && p.key === key),
  );
}

function applyTrim(line: LineEntity, clickT: number, ixs: Intersection[], doc: CADDocument): void {
  const loIxs = ixs.filter(x => x.t <= clickT);
  const hiIxs = ixs.filter(x => x.t >  clickT);
  const P1 = loIxs.length ? loIxs[loIxs.length - 1].point : null;
  const P2 = hiIxs.length ? hiIxs[0].point                : null;

  if (!P1 && P2) {
    // Trim from endpoint a → move a to P2.
    line.a = { ...P2 };
    removeCoincidentAt(doc, line.id, "a");
  } else if (P1 && !P2) {
    // Trim from endpoint b → move b to P1.
    line.b = { ...P1 };
    removeCoincidentAt(doc, line.id, "b");
  } else if (P1 && P2) {
    // Split: keep a→P1 as the original entity, add a new entity P2→b.
    const oldB = { ...line.b };

    // Remap constraints at endpoint b to the new entity.
    const line2 = new LineEntity({ ...P2 }, oldB);
    line2.isConstruction = line.isConstruction;

    for (const c of doc.constraints) {
      for (const p of c.points ?? []) {
        if (p.entityId === line.id && p.key === "b") p.entityId = line2.id;
      }
    }
    // Remove body constraints on the original line (parallel, equal, collinear, etc.).
    doc.constraints = doc.constraints.filter(c =>
      !c.entities?.includes(line.id),
    );

    line.b = { ...P1 };
    doc.entities.push(line2);
  }
}

// ---------------------------------------------------------------------------

export class TrimTool implements Tool {
  readonly id    = "trim";
  readonly label = "Trim (T)";
  readonly icon  = ICONS.trim;

  private hover: { seg: { a: Vec2; b: Vec2 } } | null = null;

  private hit(worldPos: Vec2, doc: CADDocument, scale: number) {
    const worldThresh = HIT_PX / scale;
    let best: { line: LineEntity; t: number; d: number } | null = null;
    for (const ent of doc.entities) {
      if (!(ent instanceof LineEntity) || ent.isConstruction) continue;
      const cl = closestPointOnSegment(worldPos, ent.a, ent.b);
      const d = dist(worldPos, cl.point);
      if (d < worldThresh && (!best || d < best.d))
        best = { line: ent, t: cl.t, d };
    }
    if (!best) return null;
    const ixs = lineIntersections(best.line, doc);
    if (ixs.length === 0) return null;
    return { line: best.line, clickT: best.t, ixs };
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    const h = this.hit(e.worldRaw, ctx.doc, ctx.view.scale);
    this.hover = h ? { seg: segmentAt(h.line, h.clickT, h.ixs) } : null;
    ctx.requestRender();
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    const h = this.hit(e.worldRaw, ctx.doc, ctx.view.scale);
    if (!h) return;
    ctx.pushHistory();
    applyTrim(h.line, h.clickT, h.ixs, ctx.doc);
    ctx.solve();
    ctx.doc.emitChange();
  }

  cancel(ctx: ToolContext): void {
    this.hover = null;
    ctx.requestRender();
  }

  getOverlay(): ToolOverlay {
    if (!this.hover) return { previews: [], selectionRect: null };
    return {
      previews: [{ kind: "line", a: this.hover.seg.a, b: this.hover.seg.b }],
      selectionRect: null,
    };
  }
}
