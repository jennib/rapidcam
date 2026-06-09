/**
 * Fillet tool: click a corner where two lines meet (or a polyline / polygon
 * vertex), type a radius, get a smooth arc.
 *
 * For line-line corners an ArcEntity is inserted and the lines are trimmed.
 * For polyline / polygon vertices the corner point is replaced in-place with
 * tessellated arc points (~2 ° per step) so the result stays a single
 * offsettable PolylineEntity.
 */

import { Vec2, dist } from "../core/vec2";
import { LineEntity, ArcEntity, PolylineEntity } from "../model/entities";
import { CADDocument } from "../model/document";
import { Tool, ToolContext, ToolOverlay, ToolPointerEvent } from "./tool";
import { parseLength } from "../core/units";
import { TAU } from "../core/geom";
import { ICONS } from "./icons";

const CORNER_EPS = 1e-4;
const HIT_PX    = 16;

// ---------------------------------------------------------------------------
// Corner types
// ---------------------------------------------------------------------------

interface LineCorner {
  kind: "line";
  line1: LineEntity; key1: "a" | "b";
  line2: LineEntity; key2: "a" | "b";
  pos: Vec2;
}

interface PolyCorner {
  kind: "poly";
  entity: PolylineEntity;
  index: number;
  pos: Vec2;
}

type Corner = LineCorner | PolyCorner;

// ---------------------------------------------------------------------------
// Corner detection
// ---------------------------------------------------------------------------

function findCorner(worldPos: Vec2, doc: CADDocument, scale: number): Corner | null {
  const thresh = HIT_PX / scale;
  let best: { corner: Corner; d: number } | null = null;

  // Line-line corners
  let nearestPt: { line: LineEntity; key: "a" | "b"; pos: Vec2; d: number } | null = null;
  for (const ent of doc.entities) {
    if (!(ent instanceof LineEntity) || ent.isConstruction) continue;
    for (const key of ["a", "b"] as const) {
      const d = dist(worldPos, ent[key]);
      if (d < thresh && (!nearestPt || d < nearestPt.d))
        nearestPt = { line: ent, key, pos: ent[key], d };
    }
  }
  if (nearestPt) {
    for (const ent of doc.entities) {
      if (!(ent instanceof LineEntity) || ent.isConstruction || ent.id === nearestPt.line.id) continue;
      for (const key of ["a", "b"] as const) {
        if (dist(ent[key], nearestPt.pos) < CORNER_EPS) {
          if (!best || nearestPt.d < best.d)
            best = { corner: { kind: "line", line1: nearestPt.line, key1: nearestPt.key, line2: ent, key2: key, pos: nearestPt.pos }, d: nearestPt.d };
        }
      }
    }
  }

  // Polyline vertices (all vertices of closed polylines; interior vertices of open ones)
  for (const ent of doc.entities) {
    if (!(ent instanceof PolylineEntity) || ent.isConstruction) continue;
    const n = ent.points.length;
    for (let i = 0; i < n; i++) {
      if (!ent.closed && (i === 0 || i === n - 1)) continue;
      const d = dist(worldPos, ent.points[i]);
      if (d < thresh && (!best || d < best.d))
        best = { corner: { kind: "poly", entity: ent, index: i, pos: ent.points[i] }, d };
    }
  }

  return best?.corner ?? null;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function applyFillet(corner: Corner, radius: number, doc: CADDocument): boolean {
  return corner.kind === "line"
    ? applyLineFillet(corner, radius, doc)
    : applyPolyFillet(corner, radius);
}

function applyLineFillet(corner: LineCorner, radius: number, doc: CADDocument): boolean {
  const { line1, key1, line2, key2, pos: P } = corner;

  const other1 = key1 === "a" ? line1.b : line1.a;
  const other2 = key2 === "a" ? line2.b : line2.a;
  const len1 = dist(P, other1);
  const len2 = dist(P, other2);
  if (len1 < CORNER_EPS || len2 < CORNER_EPS) return false;

  const d1: Vec2 = { x: (other1.x - P.x) / len1, y: (other1.y - P.y) / len1 };
  const d2: Vec2 = { x: (other2.x - P.x) / len2, y: (other2.y - P.y) / len2 };

  const cosA = d1.x * d2.x + d1.y * d2.y;
  const angle = Math.acos(Math.max(-1, Math.min(1, cosA)));
  if (angle < 1e-4 || Math.abs(angle - Math.PI) < 1e-4) return false;

  const tangentLen = radius / Math.tan(angle / 2);
  if (tangentLen >= len1 - CORNER_EPS || tangentLen >= len2 - CORNER_EPS) return false;

  const T1: Vec2 = { x: P.x + tangentLen * d1.x, y: P.y + tangentLen * d1.y };
  const T2: Vec2 = { x: P.x + tangentLen * d2.x, y: P.y + tangentLen * d2.y };

  const bx = d1.x + d2.x, by = d1.y + d2.y;
  const bl = Math.sqrt(bx * bx + by * by);
  if (bl < 1e-9) return false;
  const arcDist = radius / Math.sin(angle / 2);
  const C: Vec2 = { x: P.x + (bx / bl) * arcDist, y: P.y + (by / bl) * arcDist };

  const a1 = Math.atan2(T1.y - C.y, T1.x - C.x);
  const a2 = Math.atan2(T2.y - C.y, T2.x - C.x);

  const crossVal = (T1.x - C.x) * (T2.y - C.y) - (T1.y - C.y) * (T2.x - C.x);
  const startAngle = crossVal >= 0 ? a1 : a2;
  const endAngle   = crossVal >= 0 ? a2 : a1;
  const arcStartKey: "start" | "end" = crossVal >= 0 ? "start" : "end";
  const arcEndKey:   "start" | "end" = crossVal >= 0 ? "end"   : "start";

  if (key1 === "a") line1.a = T1; else line1.b = T1;
  if (key2 === "a") line2.a = T2; else line2.b = T2;

  doc.constraints = doc.constraints.filter(c => {
    if (c.type !== "coincident" || c.points.length !== 2) return true;
    const has1 = c.points.some(p => p.entityId === line1.id && p.key === key1);
    const has2 = c.points.some(p => p.entityId === line2.id && p.key === key2);
    return !(has1 && has2);
  });

  const arc = new ArcEntity(C, radius, startAngle, endAngle);
  doc.add(arc);
  doc.addConstraint({ id: `fillet-c1-${arc.id}`, type: "coincident", points: [
    { entityId: line1.id, key: key1 }, { entityId: arc.id, key: arcStartKey },
  ], entities: [], params: [] });
  doc.addConstraint({ id: `fillet-c2-${arc.id}`, type: "coincident", points: [
    { entityId: line2.id, key: key2 }, { entityId: arc.id, key: arcEndKey },
  ], entities: [], params: [] });

  return true;
}

function applyPolyFillet(corner: PolyCorner, radius: number): boolean {
  const { entity: pl, index: i } = corner;
  const n = pl.points.length;

  if (!pl.closed && (i === 0 || i === n - 1)) return false;

  const P    = pl.points[i];
  const prev = pl.points[(i - 1 + n) % n];
  const next = pl.points[(i + 1) % n];

  const lenPrev = dist(P, prev);
  const lenNext = dist(P, next);
  if (lenPrev < CORNER_EPS || lenNext < CORNER_EPS) return false;

  const dPrev: Vec2 = { x: (prev.x - P.x) / lenPrev, y: (prev.y - P.y) / lenPrev };
  const dNext: Vec2 = { x: (next.x - P.x) / lenNext, y: (next.y - P.y) / lenNext };

  const cosA = dPrev.x * dNext.x + dPrev.y * dNext.y;
  const angle = Math.acos(Math.max(-1, Math.min(1, cosA)));
  if (angle < 1e-4 || Math.abs(angle - Math.PI) < 1e-4) return false;

  const tangentLen = radius / Math.tan(angle / 2);
  if (tangentLen >= lenPrev - CORNER_EPS || tangentLen >= lenNext - CORNER_EPS) return false;

  const T1: Vec2 = { x: P.x + tangentLen * dPrev.x, y: P.y + tangentLen * dPrev.y };
  const T2: Vec2 = { x: P.x + tangentLen * dNext.x, y: P.y + tangentLen * dNext.y };

  // Arc centre on the angle bisector, inside the corner.
  const bx = dPrev.x + dNext.x, by = dPrev.y + dNext.y;
  const bl = Math.sqrt(bx * bx + by * by);
  if (bl < 1e-9) return false;
  const arcDist = radius / Math.sin(angle / 2);
  const C: Vec2 = { x: P.x + (bx / bl) * arcDist, y: P.y + (by / bl) * arcDist };

  // Tessellate the short arc from T1 to T2 (~2° per step).
  const a1 = Math.atan2(T1.y - C.y, T1.x - C.x);
  const a2 = Math.atan2(T2.y - C.y, T2.x - C.x);
  let span = ((a2 - a1) % TAU + TAU) % TAU;
  if (span > Math.PI) span -= TAU; // take the short arc, possibly CW
  const steps = Math.max(2, Math.ceil(Math.abs(span) / (Math.PI / 90)));
  const arcPts: Vec2[] = [];
  for (let k = 0; k <= steps; k++) {
    const a = a1 + (span * k) / steps;
    arcPts.push({ x: C.x + radius * Math.cos(a), y: C.y + radius * Math.sin(a) });
  }

  // Replace the corner vertex with the tessellated arc.
  pl.points.splice(i, 1, ...arcPts);
  return true;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export class FilletTool implements Tool {
  readonly id    = "fillet";
  readonly label = "Fillet (F)";
  readonly icon  = ICONS.fillet;

  private hoverCorner: Corner | null = null;

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    const c = findCorner(e.worldRaw, ctx.doc, ctx.view.scale);
    if (c?.pos !== this.hoverCorner?.pos) {
      this.hoverCorner = c;
      ctx.requestRender();
    }
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    const corner = findCorner(e.worldRaw, ctx.doc, ctx.view.scale);
    if (!corner) return;

    ctx.openValueEditor(
      corner.pos,
      `fillet radius (${ctx.doc.displayUnit})`,
      (raw) => {
        const r = parseLength(raw, ctx.doc.displayUnit);
        if (r === null || r <= 0) return false;
        ctx.pushHistory();
        const ok = applyFillet(corner, r, ctx.doc);
        if (!ok) return false;
        ctx.solve();
        ctx.doc.emitChange();
      },
      () => {},
    );
  }

  cancel(ctx: ToolContext): void {
    this.hoverCorner = null;
    ctx.requestRender();
  }

  getOverlay(): ToolOverlay {
    if (!this.hoverCorner) return { previews: [], selectionRect: null };
    return {
      previews: [{ kind: "point", pos: this.hoverCorner.pos }],
      selectionRect: null,
    };
  }
}
