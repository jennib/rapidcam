/**
 * Trim tool: click the portion of a line, circle, or arc you want removed; it
 * snaps to the nearest intersections with other entities and snips that
 * segment away.
 *
 * Hover shows a preview (accent-coloured) of the segment that would be removed.
 * Click applies the trim.
 *
 * Lines:
 *   • Click is before all intersections  → shorten from endpoint a
 *   • Click is after  all intersections  → shorten from endpoint b
 *   • Click is between two intersections → split the line, removing the middle piece
 * Circles: removing the clicked span between two intersections converts the
 *   circle into an arc covering the rest.
 * Arcs: shortened from either end, or split into two arcs, like lines.
 *
 * Lines, circles, and arcs all act as cutting geometry for each other.
 */

import { Vec2 } from "../core/vec2";
import { LineEntity, CircleEntity, ArcEntity, Entity } from "../model/entities";
import { CADDocument } from "../model/document";
import { Tool, ToolContext, ToolOverlay, ToolPointerEvent } from "./tool";
import {
  segSegIntersect, segCircleIntersect, circleCircleIntersect,
  closestPointOnSegment, distToSegment, distToCircle, distToArc,
  angleInArc, TAU,
} from "../core/geom";
import { PreviewShape } from "../view/overlay";
import { ICONS } from "./icons";

const HIT_PX  = 12;
const EPS     = 1e-9;
const EPS_ANG = 1e-7;

const normAngle = (a: number): number => ((a % TAU) + TAU) % TAU;
const angleOf = (p: Vec2, c: Vec2): number => Math.atan2(p.y - c.y, p.x - c.x);

/** Points where `cutter` crosses the full circle (center, r). */
function circleCutterPoints(center: Vec2, r: number, cutter: Entity): Vec2[] {
  if (cutter instanceof LineEntity)
    return segCircleIntersect(cutter.a, cutter.b, center, r).map(h => h.point);
  if (cutter instanceof CircleEntity)
    return circleCircleIntersect(center, r, cutter.center, cutter.radius);
  if (cutter instanceof ArcEntity)
    return circleCircleIntersect(center, r, cutter.center, cutter.radius)
      .filter(p => angleInArc(angleOf(p, cutter.center), cutter.startAngle, cutter.endAngle));
  return [];
}

// --- line target -----------------------------------------------------------

interface LineIx { point: Vec2; t: number }

function lineIntersections(line: LineEntity, doc: CADDocument): LineIx[] {
  const result: LineIx[] = [];
  for (const ent of doc.entities) {
    if (ent.id === line.id || ent.isConstruction) continue;
    if (ent instanceof LineEntity) {
      const ix = segSegIntersect(line.a, line.b, ent.a, ent.b);
      if (ix) result.push({ point: ix.point, t: ix.ta });
    } else if (ent instanceof CircleEntity) {
      for (const h of segCircleIntersect(line.a, line.b, ent.center, ent.radius))
        result.push({ point: h.point, t: h.t });
    } else if (ent instanceof ArcEntity) {
      for (const h of segCircleIntersect(line.a, line.b, ent.center, ent.radius))
        if (angleInArc(h.theta, ent.startAngle, ent.endAngle))
          result.push({ point: h.point, t: h.t });
    }
  }
  // Only intersections that fall strictly inside the clicked line (not at endpoints).
  const inside = result.filter(x => x.t > EPS && x.t < 1 - EPS).sort((a, b) => a.t - b.t);
  // Deduplicate overlapping intersections.
  return inside.filter((x, i) => i === 0 || x.t - inside[i - 1].t > EPS);
}

/** Work out which segment of `line` the given parameter falls in and return its endpoints. */
function segmentAt(line: LineEntity, clickT: number, ixs: LineIx[]): { a: Vec2; b: Vec2 } {
  const lo = ixs.filter(x => x.t <= clickT);
  const hi = ixs.filter(x => x.t >  clickT);
  return {
    a: lo.length ? lo[lo.length - 1].point : line.a,
    b: hi.length ? hi[0].point             : line.b,
  };
}

function removeCoincidentAt(doc: CADDocument, entityId: string, key: string): void {
  doc.constraints = doc.constraints.filter(c =>
    c.type !== "coincident" || !c.points.some(p => p.entityId === entityId && p.key === key),
  );
}

function applyLineTrim(line: LineEntity, clickT: number, ixs: LineIx[], doc: CADDocument): void {
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
    line2.layerId = line.layerId;

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
    doc.add(line2);
  }
}

// --- circle target ---------------------------------------------------------

/** Intersection angles (normalized to [0, 2π)) where other entities cross the circle. */
function circleIntersections(circle: CircleEntity, doc: CADDocument): number[] {
  const thetas: number[] = [];
  for (const ent of doc.entities) {
    if (ent.id === circle.id || ent.isConstruction) continue;
    for (const p of circleCutterPoints(circle.center, circle.radius, ent))
      thetas.push(normAngle(angleOf(p, circle.center)));
  }
  thetas.sort((a, b) => a - b);
  // Deduplicate, including the cyclic wrap between last and first.
  const out = thetas.filter((t, i) => i === 0 || t - thetas[i - 1] > EPS_ANG);
  if (out.length > 1 && out[0] + TAU - out[out.length - 1] < EPS_ANG) out.pop();
  return out;
}

/** The CCW span (start→end) of the circle containing the click, bounded by intersections. */
function circleRemovedSpan(clickTheta: number, thetas: number[]): { start: number; end: number } {
  let i = thetas.findIndex(t => t > clickTheta);
  if (i < 0) i = 0; // click is past the last intersection → wraps around to the first
  return {
    start: thetas[(i - 1 + thetas.length) % thetas.length],
    end:   thetas[i],
  };
}

function applyCircleTrim(circle: CircleEntity, clickTheta: number, thetas: number[], doc: CADDocument): void {
  const { start, end } = circleRemovedSpan(clickTheta, thetas);
  // Keep the complement of the removed span as an arc.
  const arc = new ArcEntity(circle.center, circle.radius, end, start);
  arc.isConstruction = circle.isConstruction;
  arc.layerId = circle.layerId;
  doc.remove(circle); // also prunes constraints/dimensions that referenced the circle
  doc.add(arc);
}

// --- arc target ------------------------------------------------------------

interface ArcIx { off: number; theta: number } // off = CCW offset from startAngle

function arcIntersections(arc: ArcEntity, doc: CADDocument): ArcIx[] {
  const span = normAngle(arc.endAngle - arc.startAngle);
  const result: ArcIx[] = [];
  for (const ent of doc.entities) {
    if (ent.id === arc.id || ent.isConstruction) continue;
    for (const p of circleCutterPoints(arc.center, arc.radius, ent)) {
      const theta = angleOf(p, arc.center);
      const off = normAngle(theta - arc.startAngle);
      // Only intersections strictly inside the arc span (not at endpoints).
      if (off > EPS_ANG && off < span - EPS_ANG) result.push({ off, theta });
    }
  }
  result.sort((a, b) => a.off - b.off);
  return result.filter((x, i) => i === 0 || x.off - result[i - 1].off > EPS_ANG);
}

function applyArcTrim(arc: ArcEntity, clickOff: number, ixs: ArcIx[], doc: CADDocument): void {
  const loIxs = ixs.filter(x => x.off <= clickOff);
  const hiIxs = ixs.filter(x => x.off >  clickOff);
  const P1 = loIxs.length ? loIxs[loIxs.length - 1] : null;
  const P2 = hiIxs.length ? hiIxs[0]                : null;

  if (!P1 && P2) {
    // Trim from the start endpoint → advance startAngle to P2.
    arc.startAngle = P2.theta;
    removeCoincidentAt(doc, arc.id, "start");
  } else if (P1 && !P2) {
    // Trim from the end endpoint → pull endAngle back to P1.
    arc.endAngle = P1.theta;
    removeCoincidentAt(doc, arc.id, "end");
  } else if (P1 && P2) {
    // Split: keep start→P1 as the original entity, add a new arc P2→end.
    const arc2 = new ArcEntity(arc.center, arc.radius, P2.theta, arc.endAngle);
    arc2.isConstruction = arc.isConstruction;
    arc2.layerId = arc.layerId;

    // Remap constraints at the end point to the new entity.
    for (const c of doc.constraints) {
      for (const p of c.points ?? []) {
        if (p.entityId === arc.id && p.key === "end") p.entityId = arc2.id;
      }
    }
    // Remove body constraints on the original arc (tangent, equal, etc.).
    doc.constraints = doc.constraints.filter(c =>
      !c.entities?.includes(arc.id),
    );

    arc.endAngle = P1.theta;
    doc.add(arc2);
  }
}

// ---------------------------------------------------------------------------

type Hit =
  | { kind: "line";   ent: LineEntity;   clickT: number;     ixs: LineIx[] }
  | { kind: "circle"; ent: CircleEntity; clickTheta: number; thetas: number[] }
  | { kind: "arc";    ent: ArcEntity;    clickOff: number;   ixs: ArcIx[] };

export class TrimTool implements Tool {
  readonly id    = "trim";
  readonly label = "Trim (T)";
  readonly icon  = ICONS.trim;

  private hover: PreviewShape | null = null;

  private hit(worldPos: Vec2, doc: CADDocument, scale: number): Hit | null {
    const worldThresh = HIT_PX / scale;
    let best: { ent: LineEntity | CircleEntity | ArcEntity; d: number } | null = null;
    for (const ent of doc.entities) {
      if (ent.isConstruction) continue;
      let d: number;
      if (ent instanceof LineEntity)        d = distToSegment(worldPos, ent.a, ent.b);
      else if (ent instanceof CircleEntity) d = distToCircle(worldPos, ent.center, ent.radius);
      else if (ent instanceof ArcEntity)    d = distToArc(worldPos, ent.center, ent.radius, ent.startAngle, ent.endAngle);
      else continue;
      if (d < worldThresh && (!best || d < best.d)) best = { ent, d };
    }
    if (!best) return null;
    const ent = best.ent;

    if (ent instanceof LineEntity) {
      const ixs = lineIntersections(ent, doc);
      if (ixs.length === 0) return null;
      return { kind: "line", ent, clickT: closestPointOnSegment(worldPos, ent.a, ent.b).t, ixs };
    }
    if (ent instanceof CircleEntity) {
      const thetas = circleIntersections(ent, doc);
      // A single cut can't remove a span of a full circle.
      if (thetas.length < 2) return null;
      return { kind: "circle", ent, clickTheta: normAngle(angleOf(worldPos, ent.center)), thetas };
    }
    const ixs = arcIntersections(ent, doc);
    if (ixs.length === 0) return null;
    const span = normAngle(ent.endAngle - ent.startAngle);
    const clickOff = normAngle(angleOf(worldPos, ent.center) - ent.startAngle);
    if (clickOff <= 0 || clickOff >= span) return null; // hit the endpoint cap, not the body
    return { kind: "arc", ent, clickOff, ixs };
  }

  private previewFor(h: Hit): PreviewShape {
    if (h.kind === "line") {
      const seg = segmentAt(h.ent, h.clickT, h.ixs);
      return { kind: "line", a: seg.a, b: seg.b };
    }
    if (h.kind === "circle") {
      const { start, end } = circleRemovedSpan(h.clickTheta, h.thetas);
      return { kind: "arc", center: h.ent.center, radius: h.ent.radius, startAngle: start, endAngle: end };
    }
    const lo = h.ixs.filter(x => x.off <= h.clickOff);
    const hi = h.ixs.filter(x => x.off >  h.clickOff);
    return {
      kind: "arc",
      center: h.ent.center,
      radius: h.ent.radius,
      startAngle: lo.length ? lo[lo.length - 1].theta : h.ent.startAngle,
      endAngle:   hi.length ? hi[0].theta             : h.ent.endAngle,
    };
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
    if (h.kind === "line")        applyLineTrim(h.ent, h.clickT, h.ixs, ctx.doc);
    else if (h.kind === "circle") applyCircleTrim(h.ent, h.clickTheta, h.thetas, ctx.doc);
    else                          applyArcTrim(h.ent, h.clickOff, h.ixs, ctx.doc);
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
