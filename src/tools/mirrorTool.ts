/**
 * Mirror tool: click two points to define a mirror axis; creates reflected copies
 * of all currently selected entities across that axis.
 *
 * Arcs are reflected correctly (centre + direction reversal).
 * RectEntity (axis-aligned) is converted to a closed PolylineEntity after
 * reflection since the result is not axis-aligned.
 */

import { Vec2, dot, sub } from "../core/vec2";
import {
  Entity, LineEntity, CircleEntity, ArcEntity,
  PolylineEntity, BezierEntity, RectEntity,
} from "../model/entities";
import { Tool, ToolContext, ToolOverlay, ToolPointerEvent } from "./tool";
import { ICONS } from "./icons";

// ---------------------------------------------------------------------------
// Reflection math

function reflectPt(P: Vec2, A: Vec2, d: Vec2): Vec2 {
  const v = sub(P, A);
  const proj2 = 2 * dot(v, d);
  return { x: P.x + proj2 * d.x - 2 * v.x, y: P.y + proj2 * d.y - 2 * v.y };
}

function reflectAngle(theta: number, axisAngle: number): number {
  return 2 * axisAngle - theta;
}

function mirrorEntity(ent: Entity, A: Vec2, B: Vec2): Entity | null {
  const rx = B.x - A.x, ry = B.y - A.y;
  const len = Math.sqrt(rx * rx + ry * ry);
  if (len < 1e-9) return null;
  const d: Vec2 = { x: rx / len, y: ry / len };
  const axisAngle = Math.atan2(ry, rx);
  const r = (p: Vec2) => reflectPt(p, A, d);

  if (ent instanceof LineEntity) {
    const e = new LineEntity(r(ent.a), r(ent.b));
    e.isConstruction = ent.isConstruction;
    return e;
  }
  if (ent instanceof CircleEntity) {
    const e = new CircleEntity(r(ent.center), ent.radius);
    e.isConstruction = ent.isConstruction;
    return e;
  }
  if (ent instanceof ArcEntity) {
    // Reflect centre; swap + reflect angles to reverse arc direction.
    const e = new ArcEntity(
      r(ent.center), ent.radius,
      reflectAngle(ent.endAngle,   axisAngle),
      reflectAngle(ent.startAngle, axisAngle),
    );
    e.isConstruction = ent.isConstruction;
    return e;
  }
  if (ent instanceof PolylineEntity) {
    // Reverse winding so orientation is consistent after reflection.
    const pts = [...ent.points].reverse().map(r);
    const e = new PolylineEntity(pts, ent.closed);
    e.isConstruction = ent.isConstruction;
    return e;
  }
  if (ent instanceof BezierEntity) {
    const e = new BezierEntity(r(ent.p0), r(ent.p1), r(ent.p2), r(ent.p3));
    e.isConstruction = ent.isConstruction;
    return e;
  }
  if (ent instanceof RectEntity) {
    // RectEntity is axis-aligned; reflected result is a closed polyline.
    const pts = [...ent.corners()].reverse().map(r);
    const e = new PolylineEntity(pts, true);
    e.isConstruction = ent.isConstruction;
    return e;
  }
  return null;
}

// ---------------------------------------------------------------------------

export class MirrorTool implements Tool {
  readonly id    = "mirror";
  readonly label = "Mirror";
  readonly icon  = ICONS.mirror;

  private axisStart: Vec2 | null = null;
  private cursor: Vec2 = { x: 0, y: 0 };

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    if (!this.axisStart) {
      this.axisStart = { ...e.world };
    } else {
      const A = this.axisStart;
      const B = e.world;
      const dx = B.x - A.x, dy = B.y - A.y;
      if (dx * dx + dy * dy > 1e-10 && ctx.doc.selected.length > 0) {
        ctx.pushHistory();
        for (const ent of ctx.doc.selected) {
          const m = mirrorEntity(ent, A, B);
          if (m) ctx.doc.add(m);
        }
        ctx.doc.emitChange();
      }
      this.axisStart = null;
      ctx.requestRender();
    }
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    this.cursor = { ...e.world };
    if (this.axisStart) ctx.requestRender();
  }

  cancel(ctx: ToolContext): void {
    this.axisStart = null;
    ctx.requestRender();
  }

  getOverlay(): ToolOverlay {
    if (!this.axisStart) return { previews: [], selectionRect: null };
    return {
      previews: [{ kind: "line", a: this.axisStart, b: this.cursor }],
      selectionRect: null,
    };
  }
}
