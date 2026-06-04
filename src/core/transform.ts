import { Entity, LineEntity, CircleEntity, RectEntity, PolylineEntity, ArcEntity, BezierEntity } from "../model/entities";
import type { Bounds } from "../model/entities";
import type { Vec2 } from "./vec2";

export function selectionBounds(entities: Entity[]): Bounds | null {
  if (entities.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of entities) {
    const b = e.bounds();
    if (b.min.x < minX) minX = b.min.x;
    if (b.min.y < minY) minY = b.min.y;
    if (b.max.x > maxX) maxX = b.max.x;
    if (b.max.y > maxY) maxY = b.max.y;
  }
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

export function applyScale(entities: Entity[], cx: number, cy: number, sx: number, sy: number): void {
  const scalePt = (p: Vec2) => {
    p.x = cx + (p.x - cx) * sx;
    p.y = cy + (p.y - cy) * sy;
  };

  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    if (e instanceof LineEntity) {
      scalePt(e.a); scalePt(e.b);
    } else if (e instanceof PolylineEntity) {
      for (const p of e.points) scalePt(p);
    } else if (e instanceof BezierEntity) {
      scalePt(e.p0); scalePt(e.p1); scalePt(e.p2); scalePt(e.p3);
    } else if (e instanceof CircleEntity) {
      if (Math.abs(sx - sy) > 1e-6) {
        console.warn("[transform] Non-uniform scale applied to CircleEntity — will result in distortion (ellipse not supported)");
      }
      scalePt(e.center);
      e.radius *= Math.abs(sx);
    } else if (e instanceof ArcEntity) {
      if (Math.abs(sx - sy) > 1e-6) {
        console.warn("[transform] Non-uniform scale applied to ArcEntity — will result in distortion (ellipse not supported)");
      }
      scalePt(e.center);
      e.radius *= Math.abs(sx);
      // If scale is negative, it implies a flip.
      // We assume sx, sy are positive for normal scale ops.
      // Flips should be done via applyFlipH / applyFlipV explicitly.
    } else if (e instanceof RectEntity) {
      scalePt(e.p0); scalePt(e.p1);
      const minX = Math.min(e.p0.x, e.p1.x), maxX = Math.max(e.p0.x, e.p1.x);
      const minY = Math.min(e.p0.y, e.p1.y), maxY = Math.max(e.p0.y, e.p1.y);
      e.p0 = { x: minX, y: minY };
      e.p1 = { x: maxX, y: maxY };
    }
  }
}

export function applyRotate(entities: Entity[], cx: number, cy: number, angle: number, onReplace?: (oldE: Entity, newE: Entity) => void): void {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const rotPt = (p: Vec2) => {
    const dx = p.x - cx, dy = p.y - cy;
    p.x = cx + dx * cos - dy * sin;
    p.y = cy + dx * sin + dy * cos;
  };
  
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    if (e instanceof LineEntity) {
      rotPt(e.a); rotPt(e.b);
    } else if (e instanceof PolylineEntity) {
      for (const p of e.points) rotPt(p);
    } else if (e instanceof BezierEntity) {
      rotPt(e.p0); rotPt(e.p1); rotPt(e.p2); rotPt(e.p3);
    } else if (e instanceof CircleEntity) {
      rotPt(e.center);
    } else if (e instanceof ArcEntity) {
      rotPt(e.center);
      e.startAngle += angle;
      e.endAngle += angle;
    } else if (e instanceof RectEntity) {
      const rem = Math.abs(angle % (Math.PI / 2));
      if (rem < 1e-6 || Math.abs(rem - Math.PI / 2) < 1e-6) {
        rotPt(e.p0); rotPt(e.p1);
        const minX = Math.min(e.p0.x, e.p1.x), maxX = Math.max(e.p0.x, e.p1.x);
        const minY = Math.min(e.p0.y, e.p1.y), maxY = Math.max(e.p0.y, e.p1.y);
        e.p0 = { x: minX, y: minY };
        e.p1 = { x: maxX, y: maxY };
      } else {
        // Convert rotated rectangle into a PolylineEntity
        const corners = e.corners();
        corners.forEach(rotPt);
        const poly = new PolylineEntity(corners, true, e.id);
        poly.selected = e.selected;
        poly.isConstruction = e.isConstruction;
        entities[i] = poly;
        if (onReplace) onReplace(e, poly);
      }
    }
  }
}

function normalizeAngle(a: number): number {
  while (a <= -Math.PI) a += Math.PI * 2;
  while (a > Math.PI) a -= Math.PI * 2;
  return a;
}

export function applyFlipH(entities: Entity[], cx: number): void {
  const flipPt = (p: Vec2) => { p.x = cx - (p.x - cx); };
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    if (e instanceof LineEntity) {
      flipPt(e.a); flipPt(e.b);
    } else if (e instanceof PolylineEntity) {
      for (const p of e.points) flipPt(p);
      e.points.reverse(); // Maintain winding order
    } else if (e instanceof BezierEntity) {
      flipPt(e.p0); flipPt(e.p1); flipPt(e.p2); flipPt(e.p3);
    } else if (e instanceof CircleEntity) {
      flipPt(e.center);
    } else if (e instanceof ArcEntity) {
      flipPt(e.center);
      const start = Math.PI - e.endAngle;
      const end = Math.PI - e.startAngle;
      e.startAngle = normalizeAngle(start);
      e.endAngle = normalizeAngle(end);
    } else if (e instanceof RectEntity) {
      flipPt(e.p0); flipPt(e.p1);
      const minX = Math.min(e.p0.x, e.p1.x), maxX = Math.max(e.p0.x, e.p1.x);
      e.p0.x = minX; e.p1.x = maxX;
    }
  }
}

export function applyFlipV(entities: Entity[], cy: number): void {
  const flipPt = (p: Vec2) => { p.y = cy - (p.y - cy); };
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    if (e instanceof LineEntity) {
      flipPt(e.a); flipPt(e.b);
    } else if (e instanceof PolylineEntity) {
      for (const p of e.points) flipPt(p);
      e.points.reverse(); // Maintain winding order
    } else if (e instanceof BezierEntity) {
      flipPt(e.p0); flipPt(e.p1); flipPt(e.p2); flipPt(e.p3);
    } else if (e instanceof CircleEntity) {
      flipPt(e.center);
    } else if (e instanceof ArcEntity) {
      flipPt(e.center);
      const start = -e.endAngle;
      const end = -e.startAngle;
      e.startAngle = normalizeAngle(start);
      e.endAngle = normalizeAngle(end);
    } else if (e instanceof RectEntity) {
      flipPt(e.p0); flipPt(e.p1);
      const minY = Math.min(e.p0.y, e.p1.y), maxY = Math.max(e.p0.y, e.p1.y);
      e.p0.y = minY; e.p1.y = maxY;
    }
  }
}
