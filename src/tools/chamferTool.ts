/**
 * Chamfer tool: click a corner where two lines meet, type a distance, get a
 * straight bevel. Mirror of the fillet tool — same corner detection, but
 * inserts a LineEntity instead of an ArcEntity.
 */

import { Vec2, dist } from "../core/vec2";
import { LineEntity } from "../model/entities";
import { CADDocument } from "../model/document";
import { Tool, ToolContext, ToolOverlay, ToolPointerEvent } from "./tool";
import { parseLength } from "../core/units";
import { ICONS } from "./icons";

const CORNER_EPS = 1e-4;
const HIT_PX    = 16;

interface Corner {
  line1: LineEntity; key1: "a" | "b";
  line2: LineEntity; key2: "a" | "b";
  pos: Vec2;
}

function findCorner(worldPos: Vec2, doc: CADDocument, scale: number): Corner | null {
  const worldThresh = HIT_PX / scale;

  let nearest: { line: LineEntity; key: "a" | "b"; pos: Vec2; d: number } | null = null;
  for (const ent of doc.entities) {
    if (!(ent instanceof LineEntity) || ent.isConstruction) continue;
    for (const key of ["a", "b"] as const) {
      const p = ent[key];
      const d = dist(worldPos, p);
      if (d < worldThresh && (!nearest || d < nearest.d))
        nearest = { line: ent, key, pos: p, d };
    }
  }
  if (!nearest) return null;

  for (const ent of doc.entities) {
    if (!(ent instanceof LineEntity) || ent.isConstruction || ent.id === nearest.line.id) continue;
    for (const key of ["a", "b"] as const) {
      if (dist(ent[key], nearest.pos) < CORNER_EPS)
        return { line1: nearest.line, key1: nearest.key, line2: ent, key2: key, pos: nearest.pos };
    }
  }
  return null;
}

function applyChamfer(corner: Corner, distance: number, doc: CADDocument): boolean {
  const { line1, key1, line2, key2, pos: P } = corner;

  const other1 = key1 === "a" ? line1.b : line1.a;
  const other2 = key2 === "a" ? line2.b : line2.a;
  const len1 = dist(P, other1);
  const len2 = dist(P, other2);
  if (len1 < CORNER_EPS || len2 < CORNER_EPS) return false;

  const d1: Vec2 = { x: (other1.x - P.x) / len1, y: (other1.y - P.y) / len1 };
  const d2: Vec2 = { x: (other2.x - P.x) / len2, y: (other2.y - P.y) / len2 };

  const angle = Math.acos(Math.max(-1, Math.min(1, d1.x * d2.x + d1.y * d2.y)));
  if (angle < 1e-4 || Math.abs(angle - Math.PI) < 1e-4) return false; // parallel lines

  if (distance >= len1 - CORNER_EPS || distance >= len2 - CORNER_EPS) return false;

  const T1: Vec2 = { x: P.x + distance * d1.x, y: P.y + distance * d1.y };
  const T2: Vec2 = { x: P.x + distance * d2.x, y: P.y + distance * d2.y };

  // Trim the source lines to the chamfer points
  if (key1 === "a") line1.a = T1; else line1.b = T1;
  if (key2 === "a") line2.a = T2; else line2.b = T2;

  // Remove the coincident constraint at the original corner
  doc.constraints = doc.constraints.filter((c) => {
    if (c.type !== "coincident" || c.points.length !== 2) return true;
    const has1 = c.points.some((p) => p.entityId === line1.id && p.key === key1);
    const has2 = c.points.some((p) => p.entityId === line2.id && p.key === key2);
    return !(has1 && has2);
  });

  // Insert the chamfer line
  const chamfer = new LineEntity(T1, T2);
  doc.add(chamfer);

  doc.addConstraint({ id: `chamfer-c1-${chamfer.id}`, type: "coincident", points: [
    { entityId: line1.id, key: key1 },
    { entityId: chamfer.id, key: "a" },
  ], entities: [], params: [] });
  doc.addConstraint({ id: `chamfer-c2-${chamfer.id}`, type: "coincident", points: [
    { entityId: line2.id, key: key2 },
    { entityId: chamfer.id, key: "b" },
  ], entities: [], params: [] });

  return true;
}

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
