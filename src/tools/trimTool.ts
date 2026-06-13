/**
 * Trim tool: click the portion of an entity you want removed; it snaps to the
 * nearest intersections with other entities and snips that segment away.
 *
 * Hover shows a preview (accent-coloured) of the piece that would be removed.
 * Click applies the trim.
 *
 * Lines:
 *   • Click is before all intersections  → shorten from endpoint a
 *   • Click is after  all intersections  → shorten from endpoint b
 *   • Click is between two intersections → split the line, removing the middle piece
 * Circles: removing the clicked span between two intersections converts the
 *   circle into an arc covering the rest.
 * Arcs: shortened from either end, or split into two arcs, like lines.
 * Polylines: shortened, split in two, or (when closed) opened up, walking the
 *   path to the nearest intersections.
 * Rectangles: converted to an equivalent closed polyline, then trimmed.
 * Entities with no intersections at all are erased whole (standard CAD trim
 *   behaviour — the hover preview highlights the entire entity).
 *
 * Everything acts as cutting geometry for everything else; beziers are
 * flattened for intersection purposes. Beziers themselves can only be erased
 * whole, not partially trimmed.
 */

import { Vec2 } from "../core/vec2";
import {
  LineEntity, CircleEntity, ArcEntity, PolylineEntity, RectEntity, BezierEntity,
  TextEntity, PointEntity, Entity,
} from "../model/entities";
import { CADDocument } from "../model/document";
import { Tool, ToolContext, ToolOverlay, ToolPointerEvent } from "./tool";
import {
  segSegIntersect, segCircleIntersect, circleCircleIntersect,
  closestPointOnSegment, distToSegment, distToCircle, distToArc,
  angleInArc, flattenBezier, TAU,
} from "../core/geom";
import { PreviewShape } from "../view/overlay";
import { ICONS } from "./icons";

const HIT_PX  = 12;
const EPS     = 1e-9;
const EPS_ANG = 1e-7;
const EPS_LEN = 1e-6;
const BEZ_TOL = 0.05;

const normAngle = (a: number): number => ((a % TAU) + TAU) % TAU;
const angleOf = (p: Vec2, c: Vec2): number => Math.atan2(p.y - c.y, p.x - c.x);

interface Seg { a: Vec2; b: Vec2 }

/**
 * An entity as straight segments for intersection purposes. Exact for lines,
 * polylines and rectangles; beziers are flattened. Circles/arcs are handled
 * exactly by the callers and return [] here.
 */
function entitySegments(ent: Entity): Seg[] {
  if (ent instanceof LineEntity) return [{ a: ent.a, b: ent.b }];
  if (ent instanceof PolylineEntity) {
    const n = ent.points.length;
    const m = ent.closed ? n : n - 1;
    const segs: Seg[] = [];
    for (let i = 0; i < m; i++)
      segs.push({ a: ent.points[i], b: ent.points[(i + 1) % n] });
    return segs;
  }
  if (ent instanceof RectEntity) {
    const c = ent.corners();
    return [0, 1, 2, 3].map((i) => ({ a: c[i], b: c[(i + 1) % 4] }));
  }
  if (ent instanceof BezierEntity) {
    const pts = flattenBezier(ent.p0, ent.p1, ent.p2, ent.p3, BEZ_TOL);
    const segs: Seg[] = [];
    for (let i = 0; i + 1 < pts.length; i++) segs.push({ a: pts[i], b: pts[i + 1] });
    return segs;
  }
  return [];
}

/** Points where `cutter` crosses the full circle (center, r). */
function circleCutterPoints(center: Vec2, r: number, cutter: Entity): Vec2[] {
  if (cutter instanceof CircleEntity)
    return circleCircleIntersect(center, r, cutter.center, cutter.radius);
  if (cutter instanceof ArcEntity)
    return circleCircleIntersect(center, r, cutter.center, cutter.radius)
      .filter(p => angleInArc(angleOf(p, cutter.center), cutter.startAngle, cutter.endAngle));
  const pts: Vec2[] = [];
  for (const s of entitySegments(cutter))
    for (const h of segCircleIntersect(s.a, s.b, center, r)) pts.push(h.point);
  return pts;
}

/** Points (with param t) where `cutter` crosses segment a→b. */
function segCutterHits(a: Vec2, b: Vec2, cutter: Entity): { point: Vec2; t: number }[] {
  if (cutter instanceof CircleEntity)
    return segCircleIntersect(a, b, cutter.center, cutter.radius)
      .map(h => ({ point: h.point, t: h.t }));
  if (cutter instanceof ArcEntity)
    return segCircleIntersect(a, b, cutter.center, cutter.radius)
      .filter(h => angleInArc(h.theta, cutter.startAngle, cutter.endAngle))
      .map(h => ({ point: h.point, t: h.t }));
  const hits: { point: Vec2; t: number }[] = [];
  for (const s of entitySegments(cutter)) {
    const ix = segSegIntersect(a, b, s.a, s.b);
    if (ix) hits.push({ point: ix.point, t: ix.ta });
  }
  return hits;
}

// --- line target -----------------------------------------------------------

interface LineIx { point: Vec2; t: number }

function lineIntersections(line: LineEntity, doc: CADDocument): LineIx[] {
  const result: LineIx[] = [];
  for (const ent of doc.entities) {
    if (ent.id === line.id || ent.isConstruction) continue;
    for (const h of segCutterHits(line.a, line.b, ent))
      result.push({ point: h.point, t: h.t });
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

// --- polyline target ---------------------------------------------------------

/** Cumulative arc length at each vertex; cum.length = segment count + 1. */
function pathCum(points: Vec2[], closed: boolean): number[] {
  const cum = [0];
  const m = closed ? points.length : points.length - 1;
  for (let i = 0; i < m; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    cum.push(cum[i] + Math.hypot(b.x - a.x, b.y - a.y));
  }
  return cum;
}

function segIndexAt(cum: number[], s: number): number {
  let k = 0;
  while (k < cum.length - 2 && s >= cum[k + 1]) k++;
  return k;
}

function pointAtS(points: Vec2[], cum: number[], s: number): Vec2 {
  const k = segIndexAt(cum, s);
  const a = points[k], b = points[(k + 1) % points.length];
  const len = cum[k + 1] - cum[k];
  const t = len > EPS ? (s - cum[k]) / len : 0;
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

/** Arc-length positions where other entities cross the polyline path. */
function polylinePathIntersections(points: Vec2[], closed: boolean, selfId: string, doc: CADDocument): number[] {
  const cum = pathCum(points, closed);
  const total = cum[cum.length - 1];
  const m = cum.length - 1;
  const out: number[] = [];
  for (const ent of doc.entities) {
    if (ent.id === selfId || ent.isConstruction) continue;
    for (let i = 0; i < m; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      for (const h of segCutterHits(a, b, ent))
        out.push(cum[i] + h.t * (cum[i + 1] - cum[i]));
    }
  }
  let vals = out;
  if (!closed) vals = vals.filter(s => s > EPS_LEN && s < total - EPS_LEN);
  vals.sort((x, y) => x - y);
  const dedup = vals.filter((s, i) => i === 0 || s - vals[i - 1] > EPS_LEN);
  if (closed && dedup.length > 1 && dedup[0] + total - dedup[dedup.length - 1] < EPS_LEN) dedup.pop();
  return dedup;
}

/** Walk the closed path CCW from sFrom to sTo, collecting passed vertices. */
function walkClosed(points: Vec2[], cum: number[], sFrom: number, sTo: number): Vec2[] {
  const n = points.length;
  const kFrom = segIndexAt(cum, sFrom);
  const kTo = segIndexAt(cum, sTo);
  const out = [pointAtS(points, cum, sFrom)];
  if (kFrom === kTo && sTo > sFrom) {
    out.push(pointAtS(points, cum, sTo));
    return out;
  }
  let idx = (kFrom + 1) % n;
  for (let guard = 0; guard <= n; guard++) {
    out.push({ ...points[idx] });
    if (idx === kTo) break;
    idx = (idx + 1) % n;
  }
  out.push(pointAtS(points, cum, sTo));
  return out;
}

/** The piece of an open path between sFrom and sTo (inclusive of passed vertices). */
function openPiece(points: Vec2[], cum: number[], sFrom: number, sTo: number): Vec2[] {
  const kFrom = segIndexAt(cum, sFrom);
  const kTo = segIndexAt(cum, sTo);
  return [
    pointAtS(points, cum, sFrom),
    ...points.slice(kFrom + 1, kTo + 1).map(p => ({ ...p })),
    pointAtS(points, cum, sTo),
  ];
}

/** Drop consecutive duplicate vertices (within EPS_LEN). */
function cleanPath(pts: Vec2[]): Vec2[] {
  return pts.filter((p, i) =>
    i === 0 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > EPS_LEN);
}

interface PolyHit {
  points: Vec2[];
  closed: boolean;
  sClick: number;
  crossings: number[];
}

function polylineRemovedPiece(h: PolyHit): Vec2[] {
  const cum = pathCum(h.points, h.closed);
  const total = cum[cum.length - 1];
  if (h.closed) {
    const { start, end } = circleRemovedSpan(h.sClick, h.crossings); // same cyclic logic, s for θ
    return cleanPath(walkClosed(h.points, cum, start, end));
  }
  const lo = [...h.crossings].reverse().find(s => s <= h.sClick);
  const hi = h.crossings.find(s => s > h.sClick);
  return cleanPath(openPiece(h.points, cum, lo ?? 0, hi ?? total));
}

function applyPolylineTrim(target: PolylineEntity | RectEntity, h: PolyHit, doc: CADDocument): void {
  const cum = pathCum(h.points, h.closed);
  const total = cum[cum.length - 1];
  const mk = (pts: Vec2[]): PolylineEntity | LineEntity | null => {
    const clean = cleanPath(pts);
    if (clean.length < 2) return null;
    const e = clean.length === 2
      ? new LineEntity(clean[0], clean[1])
      : new PolylineEntity(clean, false);
    e.isConstruction = target.isConstruction;
    e.layerId = target.layerId;
    return e;
  };

  const pieces: (PolylineEntity | LineEntity)[] = [];
  if (h.closed) {
    const { start, end } = circleRemovedSpan(h.sClick, h.crossings);
    const kept = mk(walkClosed(h.points, cum, end, start));
    if (kept) pieces.push(kept);
  } else {
    const lo = [...h.crossings].reverse().find(s => s <= h.sClick);
    const hi = h.crossings.find(s => s > h.sClick);
    if (lo !== undefined) {
      const p = mk(openPiece(h.points, cum, 0, lo));
      if (p) pieces.push(p);
    }
    if (hi !== undefined) {
      const p = mk(openPiece(h.points, cum, hi, total));
      if (p) pieces.push(p);
    }
  }
  doc.remove(target); // prunes constraints/dimensions referencing it
  for (const p of pieces) doc.add(p);
}

// ---------------------------------------------------------------------------

type Hit =
  | { kind: "line";   ent: LineEntity;   clickT: number;     ixs: LineIx[] }
  | { kind: "circle"; ent: CircleEntity; clickTheta: number; thetas: number[] }
  | { kind: "arc";    ent: ArcEntity;    clickOff: number;   ixs: ArcIx[] }
  | { kind: "poly";   ent: PolylineEntity | RectEntity; poly: PolyHit }
  | { kind: "erase";  ent: Entity };

/** Whole-entity preview for the erase case. */
function erasePreview(ent: Entity): PreviewShape | null {
  if (ent instanceof LineEntity)   return { kind: "line", a: ent.a, b: ent.b };
  if (ent instanceof CircleEntity) return { kind: "circle", center: ent.center, radius: ent.radius };
  if (ent instanceof ArcEntity)
    return { kind: "arc", center: ent.center, radius: ent.radius, startAngle: ent.startAngle, endAngle: ent.endAngle };
  if (ent instanceof PolylineEntity) return { kind: "polyline", points: ent.points, closed: ent.closed };
  if (ent instanceof RectEntity)   return { kind: "rect", p0: ent.minPt, p1: ent.maxPt };
  if (ent instanceof BezierEntity) return { kind: "bezier", p0: ent.p0, p1: ent.p1, p2: ent.p2, p3: ent.p3 };
  return null;
}

export class TrimTool implements Tool {
  readonly id    = "trim";
  readonly label = "Trim (T)";
  readonly icon  = ICONS.trim;

  private hover: PreviewShape | null = null;

  private hit(worldPos: Vec2, doc: CADDocument, scale: number): Hit | null {
    const worldThresh = HIT_PX / scale;
    let best: { ent: Entity; d: number } | null = null;
    for (const ent of doc.entities) {
      if (ent.isConstruction || ent instanceof TextEntity || ent instanceof PointEntity) continue;
      let d: number;
      if (ent instanceof CircleEntity)   d = distToCircle(worldPos, ent.center, ent.radius);
      else if (ent instanceof ArcEntity) d = distToArc(worldPos, ent.center, ent.radius, ent.startAngle, ent.endAngle);
      else {
        const segs = entitySegments(ent);
        if (segs.length === 0) continue;
        d = Infinity;
        for (const s of segs) d = Math.min(d, distToSegment(worldPos, s.a, s.b));
      }
      if (d < worldThresh && (!best || d < best.d)) best = { ent, d };
    }
    if (!best) return null;
    const ent = best.ent;

    if (ent instanceof LineEntity) {
      const ixs = lineIntersections(ent, doc);
      if (ixs.length === 0) return { kind: "erase", ent };
      return { kind: "line", ent, clickT: closestPointOnSegment(worldPos, ent.a, ent.b).t, ixs };
    }
    if (ent instanceof CircleEntity) {
      const thetas = circleIntersections(ent, doc);
      if (thetas.length === 0) return { kind: "erase", ent };
      // A single cut can't remove a span of a full circle.
      if (thetas.length < 2) return null;
      return { kind: "circle", ent, clickTheta: normAngle(angleOf(worldPos, ent.center)), thetas };
    }
    if (ent instanceof ArcEntity) {
      const ixs = arcIntersections(ent, doc);
      if (ixs.length === 0) return { kind: "erase", ent };
      const span = normAngle(ent.endAngle - ent.startAngle);
      const clickOff = normAngle(angleOf(worldPos, ent.center) - ent.startAngle);
      if (clickOff <= 0 || clickOff >= span) return null; // hit the endpoint cap, not the body
      return { kind: "arc", ent, clickOff, ixs };
    }
    if (ent instanceof PolylineEntity || ent instanceof RectEntity) {
      const points = ent instanceof RectEntity ? ent.corners().map(p => ({ ...p })) : ent.points;
      const closed = ent instanceof RectEntity ? true : ent.closed;
      const crossings = polylinePathIntersections(points, closed, ent.id, doc);
      if (crossings.length === 0) return { kind: "erase", ent };
      // A single cut can't remove a span of a closed loop.
      if (closed && crossings.length < 2) return null;
      // Locate the click along the path.
      const cum = pathCum(points, closed);
      const m = cum.length - 1;
      let bestS = 0, bestD = Infinity;
      for (let i = 0; i < m; i++) {
        const a = points[i], b = points[(i + 1) % points.length];
        const cp = closestPointOnSegment(worldPos, a, b);
        const d = Math.hypot(worldPos.x - cp.point.x, worldPos.y - cp.point.y);
        if (d < bestD) { bestD = d; bestS = cum[i] + cp.t * (cum[i + 1] - cum[i]); }
      }
      return { kind: "poly", ent, poly: { points, closed, sClick: bestS, crossings } };
    }
    if (ent instanceof BezierEntity) {
      // Beziers can only be erased whole; if anything crosses it, leave it alone.
      for (const other of doc.entities) {
        if (other.id === ent.id || other.isConstruction) continue;
        for (const s of entitySegments(ent))
          if (segCutterHits(s.a, s.b, other).length > 0) return null;
      }
      return { kind: "erase", ent };
    }
    return null;
  }

  private previewFor(h: Hit): PreviewShape | null {
    if (h.kind === "erase") return erasePreview(h.ent);
    if (h.kind === "line") {
      const seg = segmentAt(h.ent, h.clickT, h.ixs);
      return { kind: "line", a: seg.a, b: seg.b };
    }
    if (h.kind === "circle") {
      const { start, end } = circleRemovedSpan(h.clickTheta, h.thetas);
      return { kind: "arc", center: h.ent.center, radius: h.ent.radius, startAngle: start, endAngle: end };
    }
    if (h.kind === "poly") {
      const piece = polylineRemovedPiece(h.poly);
      if (piece.length < 2) return null;
      return { kind: "polyline", points: piece, closed: false };
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
    if (h.kind === "erase")       ctx.doc.remove(h.ent);
    else if (h.kind === "line")   applyLineTrim(h.ent, h.clickT, h.ixs, ctx.doc);
    else if (h.kind === "circle") applyCircleTrim(h.ent, h.clickTheta, h.thetas, ctx.doc);
    else if (h.kind === "poly")   applyPolylineTrim(h.ent, h.poly, ctx.doc);
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
