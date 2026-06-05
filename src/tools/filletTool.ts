/**
 * Fillet tool: click a corner where two lines meet, type a radius, get a smooth arc.
 *
 * On click the tool finds the nearest shared endpoint of two line entities, opens a
 * floating value editor pre-hinting the last used radius, and on Enter trims both
 * lines back to their tangent points and inserts an ArcEntity between them.
 */

import { Vec2, dist } from "../core/vec2";
import { LineEntity, ArcEntity } from "../model/entities";
import { CADDocument } from "../model/document";
import { Tool, ToolContext, ToolOverlay, ToolPointerEvent } from "./tool";
import { parseLength } from "../core/units";
import { ICONS } from "./icons";

const CORNER_EPS = 1e-4;  // world-space: lines are "coincident" when endpoints this close
const HIT_PX    = 16;     // screen pixels to search for a corner

interface Corner {
  line1: LineEntity; key1: "a" | "b";
  line2: LineEntity; key2: "a" | "b";
  pos: Vec2;
}

function findCorner(worldPos: Vec2, doc: CADDocument, scale: number): Corner | null {
  const worldThresh = HIT_PX / scale;

  // Find the nearest line endpoint to the cursor.
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

  // Find a second line whose endpoint coincides with the nearest one.
  for (const ent of doc.entities) {
    if (!(ent instanceof LineEntity) || ent.isConstruction || ent.id === nearest.line.id) continue;
    for (const key of ["a", "b"] as const) {
      if (dist(ent[key], nearest.pos) < CORNER_EPS)
        return { line1: nearest.line, key1: nearest.key, line2: ent, key2: key, pos: nearest.pos };
    }
  }
  return null;
}

function applyFillet(corner: Corner, radius: number, doc: CADDocument): boolean {
  const { line1, key1, line2, key2, pos: P } = corner;

  const other1 = key1 === "a" ? line1.b : line1.a;
  const other2 = key2 === "a" ? line2.b : line2.a;
  const len1 = dist(P, other1);
  const len2 = dist(P, other2);
  if (len1 < CORNER_EPS || len2 < CORNER_EPS) return false;

  // Unit vectors pointing away from the corner along each line.
  const d1: Vec2 = { x: (other1.x - P.x) / len1, y: (other1.y - P.y) / len1 };
  const d2: Vec2 = { x: (other2.x - P.x) / len2, y: (other2.y - P.y) / len2 };

  const cosA = d1.x * d2.x + d1.y * d2.y;
  const angle = Math.acos(Math.max(-1, Math.min(1, cosA)));
  if (angle < 1e-4 || Math.abs(angle - Math.PI) < 1e-4) return false; // parallel

  const tangentLen = radius / Math.tan(angle / 2);
  if (tangentLen >= len1 - CORNER_EPS || tangentLen >= len2 - CORNER_EPS) return false; // radius too large

  // Tangent points on each line.
  const T1: Vec2 = { x: P.x + tangentLen * d1.x, y: P.y + tangentLen * d1.y };
  const T2: Vec2 = { x: P.x + tangentLen * d2.x, y: P.y + tangentLen * d2.y };

  // Arc centre lies along the angle bisector at distance r / sin(angle/2).
  const bx = d1.x + d2.x, by = d1.y + d2.y;
  const bl = Math.sqrt(bx * bx + by * by);
  if (bl < 1e-9) return false;
  const arcDist = radius / Math.sin(angle / 2);
  const C: Vec2 = { x: P.x + (bx / bl) * arcDist, y: P.y + (by / bl) * arcDist };

  // Angles from centre to tangent points.
  const a1 = Math.atan2(T1.y - C.y, T1.x - C.x);
  const a2 = Math.atan2(T2.y - C.y, T2.x - C.x);

  // Pick the CCW (short) arc: if T2 is CCW from T1, go T1→T2; otherwise go T2→T1.
  const crossVal = (T1.x - C.x) * (T2.y - C.y) - (T1.y - C.y) * (T2.x - C.x);
  const startAngle = crossVal >= 0 ? a1 : a2;
  const endAngle   = crossVal >= 0 ? a2 : a1;
  const arcStartKey: "start" | "end" = crossVal >= 0 ? "start" : "end";
  const arcEndKey:   "start" | "end" = crossVal >= 0 ? "end"   : "start";

  // Trim the lines to the tangent points.
  if (key1 === "a") line1.a = T1; else line1.b = T1;
  if (key2 === "a") line2.a = T2; else line2.b = T2;

  // Remove the coincident constraint that was joining the two corner endpoints.
  doc.constraints = doc.constraints.filter(c => {
    if (c.type !== "coincident" || c.points.length !== 2) return true;
    const has1 = c.points.some(p => p.entityId === line1.id && p.key === key1);
    const has2 = c.points.some(p => p.entityId === line2.id && p.key === key2);
    return !(has1 && has2);
  });

  // Insert the fillet arc.
  const arc = new ArcEntity(C, radius, startAngle, endAngle);
  doc.add(arc);

  // Parametric links: keep the arc tangent-point-coincident with each line.
  doc.addConstraint({ id: `fillet-c1-${arc.id}`, type: "coincident", points: [
    { entityId: line1.id, key: key1 },
    { entityId: arc.id,   key: arcStartKey },
  ], entities: [], params: [] });
  doc.addConstraint({ id: `fillet-c2-${arc.id}`, type: "coincident", points: [
    { entityId: line2.id, key: key2 },
    { entityId: arc.id,   key: arcEndKey },
  ], entities: [], params: [] });

  return true;
}

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
