/**
 * Chamfer tool: click a corner where two lines meet (or a polyline / polygon
 * vertex), type a distance, get a straight bevel.
 */

import { Vec2, dist } from "../core/vec2";
import { LineEntity, PolylineEntity } from "../model/entities";
import { CADDocument } from "../model/document";
import { Tool, ToolContext, ToolOverlay, ToolPointerEvent } from "./tool";
import { parseLength } from "../core/units";
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

function applyChamfer(corner: Corner, distance: number, doc: CADDocument): boolean {
  return corner.kind === "line"
    ? applyLineChamfer(corner, distance, doc)
    : applyPolyChamfer(corner, distance);
}

function applyLineChamfer(corner: LineCorner, distance: number, doc: CADDocument): boolean {
  const { line1, key1, line2, key2, pos: P } = corner;

  const other1 = key1 === "a" ? line1.b : line1.a;
  const other2 = key2 === "a" ? line2.b : line2.a;
  const len1 = dist(P, other1);
  const len2 = dist(P, other2);
  if (len1 < CORNER_EPS || len2 < CORNER_EPS) return false;

  const d1: Vec2 = { x: (other1.x - P.x) / len1, y: (other1.y - P.y) / len1 };
  const d2: Vec2 = { x: (other2.x - P.x) / len2, y: (other2.y - P.y) / len2 };

  const angle = Math.acos(Math.max(-1, Math.min(1, d1.x * d2.x + d1.y * d2.y)));
  if (angle < 1e-4 || Math.abs(angle - Math.PI) < 1e-4) return false;
  if (distance >= len1 - CORNER_EPS || distance >= len2 - CORNER_EPS) return false;

  const T1: Vec2 = { x: P.x + distance * d1.x, y: P.y + distance * d1.y };
  const T2: Vec2 = { x: P.x + distance * d2.x, y: P.y + distance * d2.y };

  if (key1 === "a") line1.a = T1; else line1.b = T1;
  if (key2 === "a") line2.a = T2; else line2.b = T2;

  doc.constraints = doc.constraints.filter((c) => {
    if (c.type !== "coincident" || c.points.length !== 2) return true;
    const has1 = c.points.some((p) => p.entityId === line1.id && p.key === key1);
    const has2 = c.points.some((p) => p.entityId === line2.id && p.key === key2);
    return !(has1 && has2);
  });

  const chamfer = new LineEntity(T1, T2);
  doc.add(chamfer);
  doc.addConstraint({ id: `chamfer-c1-${chamfer.id}`, type: "coincident", points: [
    { entityId: line1.id, key: key1 }, { entityId: chamfer.id, key: "a" },
  ], entities: [], params: [] });
  doc.addConstraint({ id: `chamfer-c2-${chamfer.id}`, type: "coincident", points: [
    { entityId: line2.id, key: key2 }, { entityId: chamfer.id, key: "b" },
  ], entities: [], params: [] });

  return true;
}

function applyPolyChamfer(corner: PolyCorner, distance: number): boolean {
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

  const angle = Math.acos(Math.max(-1, Math.min(1, dPrev.x * dNext.x + dPrev.y * dNext.y)));
  if (angle < 1e-4 || Math.abs(angle - Math.PI) < 1e-4) return false;
  if (distance >= lenPrev - CORNER_EPS || distance >= lenNext - CORNER_EPS) return false;

  const T1: Vec2 = { x: P.x + distance * dPrev.x, y: P.y + distance * dPrev.y };
  const T2: Vec2 = { x: P.x + distance * dNext.x, y: P.y + distance * dNext.y };

  // Replace the corner vertex with the two bevel endpoints.
  pl.points.splice(i, 1, T1, T2);
  return true;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export class ChamferTool implements Tool {
  readonly id    = "chamfer";
  readonly label = "Chamfer";
  readonly icon  = ICONS.chamfer;

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
      `chamfer distance (${ctx.doc.displayUnit})`,
      (raw) => {
        const d = parseLength(raw, ctx.doc.displayUnit);
        if (d === null || d <= 0) return false;
        ctx.pushHistory();
        const ok = applyChamfer(corner, d, ctx.doc);
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
