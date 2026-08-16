import {
  type Entity,
  LineEntity,
  CircleEntity,
  RectEntity,
  PolylineEntity,
  ArcEntity,
  BezierEntity,
  RasterImageEntity,
  TextEntity,
} from "../model/entities";
import type { Bounds } from "../model/entities";
import { type Vec2, dist } from "./vec2";

export function selectionBounds(entities: Entity[]): Bounds | null {
  if (entities.length === 0) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const e of entities) {
    const b = e.bounds();
    if (b.min.x < minX) minX = b.min.x;
    if (b.min.y < minY) minY = b.min.y;
    if (b.max.x > maxX) maxX = b.max.x;
    if (b.max.y > maxY) maxY = b.max.y;
  }
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

/**
 * Scale `entities` about (cx, cy).
 *
 * Returns how many of them could only take a UNIFORM scale — circles, arcs and
 * text, none of which have an elliptical/stretched form in this model, so a
 * non-uniform request scales them by `sx` on both axes. Callers are expected to
 * tell the user; see SelectTool's scale drag and the properties bar's W/H fields.
 *
 * This used to `console.warn` per entity instead, from inside the loop. That is
 * a signal no user ever sees, and it made the interactive scale drag hundreds of
 * times more expensive than the arithmetic it was guarding: one drag over 500
 * circles emitted 500 warnings PER POINTER MOVE, and in a dev build Vite's
 * console hook made that a quarter of the frame. Report it once, as data.
 */
export function applyScale(
  entities: Entity[],
  cx: number,
  cy: number,
  sx: number,
  sy: number,
): { uniformOnly: number } {
  const scalePt = (p: Vec2) => {
    p.x = cx + (p.x - cx) * sx;
    p.y = cy + (p.y - cy) * sy;
  };
  const nonUniform = Math.abs(sx - sy) > 1e-6;
  let uniformOnly = 0;

  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    if (e instanceof LineEntity) {
      scalePt(e.a);
      scalePt(e.b);
    } else if (e instanceof PolylineEntity) {
      // Corner sizes are lengths and scale with the shape, as a rectangle's do.
      // They need no reordering under flip or rotate — they are keyed by vertex
      // id, so they are already attached to the vertex that moved.
      if (nonUniform && e.hasShapedCorners()) uniformOnly++;
      for (const [id, v] of e.cornerRadii) e.cornerRadii.set(id, v * Math.abs(sx));
      for (const p of e.points) scalePt(p);
    } else if (e instanceof BezierEntity) {
      scalePt(e.p0);
      scalePt(e.p1);
      scalePt(e.p2);
      scalePt(e.p3);
    } else if (e instanceof CircleEntity) {
      if (nonUniform) uniformOnly++;
      scalePt(e.center);
      e.radius *= Math.abs(sx);
    } else if (e instanceof ArcEntity) {
      if (nonUniform) uniformOnly++;
      scalePt(e.center);
      e.radius *= Math.abs(sx);
      // If scale is negative, it implies a flip.
      // We assume sx, sy are positive for normal scale ops.
      // Flips should be done via applyFlipH / applyFlipV explicitly.
    } else if (e instanceof RectEntity) {
      // A corner radius is a length and scales with the shape, exactly like the
      // circle radius and text size above. Leaving it behind would shrink a
      // rounded rectangle's corners relative to its sides every time the W/H
      // fields or a scale drag ran — and only the drawing would say so.
      // A corner is round, never elliptical, so a non-uniform scale can only
      // take one factor; report it alongside circles/arcs/text.
      if (nonUniform && e.hasShapedCorners()) uniformOnly++;
      e.cornerRadii = e.cornerRadii.map((r) => r * Math.abs(sx)) as [
        number,
        number,
        number,
        number,
      ];
      scalePt(e.p0);
      scalePt(e.p1);
      const minX = Math.min(e.p0.x, e.p1.x),
        maxX = Math.max(e.p0.x, e.p1.x);
      const minY = Math.min(e.p0.y, e.p1.y),
        maxY = Math.max(e.p0.y, e.p1.y);
      e.p0 = { x: minX, y: minY };
      e.p1 = { x: maxX, y: maxY };
    } else if (e instanceof RasterImageEntity) {
      scalePt(e.position);
      e.widthMM *= Math.abs(sx);
      e.heightMM *= Math.abs(sy);
    } else if (e instanceof TextEntity) {
      if (nonUniform) uniformOnly++;
      scalePt(e.position);
      e.sizeMM *= Math.abs(sx);
    }
  }
  return { uniformOnly };
}

export function applyRotate(
  entities: Entity[],
  cx: number,
  cy: number,
  angle: number,
  onReplace?: (oldE: Entity, newE: Entity) => void,
): void {
  const cos = Math.cos(angle),
    sin = Math.sin(angle);
  const rotPt = (p: Vec2) => {
    const dx = p.x - cx,
      dy = p.y - cy;
    p.x = cx + dx * cos - dy * sin;
    p.y = cy + dx * sin + dy * cos;
  };

  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    if (e instanceof LineEntity) {
      rotPt(e.a);
      rotPt(e.b);
    } else if (e instanceof PolylineEntity) {
      for (const p of e.points) rotPt(p);
    } else if (e instanceof BezierEntity) {
      rotPt(e.p0);
      rotPt(e.p1);
      rotPt(e.p2);
      rotPt(e.p3);
    } else if (e instanceof CircleEntity) {
      rotPt(e.center);
    } else if (e instanceof RasterImageEntity) {
      // Rigid-rotate the image: spin its anchor about the pivot and add the angle
      // to its own orientation. The raster/relief generators sweep in the image's
      // local frame and lift each point through this angle, so the engrave follows.
      rotPt(e.position);
      e.angle = normalizeAngle(e.angle + angle);
    } else if (e instanceof TextEntity) {
      // Rigid-rotate like an image: spin the baseline anchor, add to orientation.
      rotPt(e.position);
      e.angle = normalizeAngle(e.angle + angle);
    } else if (e instanceof ArcEntity) {
      rotPt(e.center);
      // Normalised, as the flip paths below already do. A bare `+=` accumulated
      // forever: twenty 60-degree rotations left an arc storing 20.9 radians —
      // 3.3 turns — and the properties panel then reported a start angle of
      // 1200 degrees for an arc sitting at 120.
      //
      // Safe for the span, which is what every consumer actually reads: the span
      // is `(end - start) mod 2pi`, and shifting either angle by a whole number
      // of turns leaves that untouched, so start and end can be normalised
      // independently without changing the arc.
      e.startAngle = normalizeAngle(e.startAngle + angle);
      e.endAngle = normalizeAngle(e.endAngle + angle);
    } else if (e instanceof RectEntity) {
      const rem = Math.abs(angle % (Math.PI / 2));
      if (rem < 1e-6 || Math.abs(rem - Math.PI / 2) < 1e-6) {
        // The rectangle stays axis-aligned, so its corners swap places rather
        // than move — the treatments have to follow them round.
        e.rotateCorners(angle / (Math.PI / 2));
        rotPt(e.p0);
        rotPt(e.p1);
        const minX = Math.min(e.p0.x, e.p1.x),
          maxX = Math.max(e.p0.x, e.p1.x);
        const minY = Math.min(e.p0.y, e.p1.y),
          maxY = Math.max(e.p0.y, e.p1.y);
        e.p0 = { x: minX, y: minY };
        e.p1 = { x: maxX, y: maxY };
      } else {
        // Convert rotated rectangle into a PolylineEntity.
        // outlinePoints so a rounded rectangle rotates into a rounded polyline
        // rather than losing its corners on the way through.
        const corners = e.outlinePoints();
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

/** Returns the 4 corners (CCW-sorted) if `sel` is exactly 4 connected lines forming a closed quad; otherwise null. */
export function getRectanglePolygon(sel: Entity[]): Vec2[] | null {
  if (sel.length !== 4) return null;
  const lines = sel.filter((e) => e.type === "line") as LineEntity[];
  if (lines.length !== 4) return null;

  const pts: Vec2[] = [];
  for (const l of lines) {
    pts.push(l.a);
    pts.push(l.b);
  }

  const unique: Vec2[] = [];
  for (const p of pts) {
    if (!unique.find((u) => dist(u, p) < 1e-4)) unique.push(p);
  }
  if (unique.length !== 4) return null;

  const cx = unique.reduce((s, p) => s + p.x, 0) / 4;
  const cy = unique.reduce((s, p) => s + p.y, 0) / 4;
  unique.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  return unique;
}

export function applyFlipH(entities: Entity[], cx: number): void {
  const flipPt = (p: Vec2) => {
    p.x = cx - (p.x - cx);
  };
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    if (e instanceof LineEntity) {
      flipPt(e.a);
      flipPt(e.b);
    } else if (e instanceof PolylineEntity) {
      for (const p of e.points) flipPt(p);
      e.reverse(); // Maintain winding order — ids in step, see PolylineEntity.reverse
    } else if (e instanceof BezierEntity) {
      flipPt(e.p0);
      flipPt(e.p1);
      flipPt(e.p2);
      flipPt(e.p3);
    } else if (e instanceof CircleEntity) {
      flipPt(e.center);
    } else if (e instanceof ArcEntity) {
      flipPt(e.center);
      const start = Math.PI - e.endAngle;
      const end = Math.PI - e.startAngle;
      e.startAngle = normalizeAngle(start);
      e.endAngle = normalizeAngle(end);
    } else if (e instanceof RectEntity) {
      e.mirrorCornersX();
      flipPt(e.p0);
      flipPt(e.p1);
      const minX = Math.min(e.p0.x, e.p1.x),
        maxX = Math.max(e.p0.x, e.p1.x);
      e.p0.x = minX;
      e.p1.x = maxX;
    } else if (e instanceof RasterImageEntity) {
      // Mirror the image content (flipX) and reflect its centre about cx. The
      // 2·offX term reflects the footprint's centre, so a lone image flips in
      // place while a multi-selection also lands in the mirrored slot.
      const offX = (e.widthMM / 2) * Math.cos(e.angle) - (e.heightMM / 2) * Math.sin(e.angle);
      e.position.x = 2 * cx - e.position.x - 2 * offX;
      e.flipX = !e.flipX;
    } else if (e instanceof TextEntity) {
      // AutoCAD MIRRTEXT=0 convention: text stays readable (glyphs are never
      // mirrored — mirrored engraving is a CAM-side concern, see cam/flip.ts);
      // its footprint moves to the mirrored slot so it tracks the selection.
      const b = e.bounds();
      e.position.x += 2 * cx - (b.min.x + b.max.x);
    }
  }
}

export function applyFlipV(entities: Entity[], cy: number): void {
  const flipPt = (p: Vec2) => {
    p.y = cy - (p.y - cy);
  };
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    if (e instanceof LineEntity) {
      flipPt(e.a);
      flipPt(e.b);
    } else if (e instanceof PolylineEntity) {
      for (const p of e.points) flipPt(p);
      e.reverse(); // Maintain winding order — ids in step, see PolylineEntity.reverse
    } else if (e instanceof BezierEntity) {
      flipPt(e.p0);
      flipPt(e.p1);
      flipPt(e.p2);
      flipPt(e.p3);
    } else if (e instanceof CircleEntity) {
      flipPt(e.center);
    } else if (e instanceof ArcEntity) {
      flipPt(e.center);
      const start = -e.endAngle;
      const end = -e.startAngle;
      e.startAngle = normalizeAngle(start);
      e.endAngle = normalizeAngle(end);
    } else if (e instanceof RectEntity) {
      e.mirrorCornersY();
      flipPt(e.p0);
      flipPt(e.p1);
      const minY = Math.min(e.p0.y, e.p1.y),
        maxY = Math.max(e.p0.y, e.p1.y);
      e.p0.y = minY;
      e.p1.y = maxY;
    } else if (e instanceof RasterImageEntity) {
      const offY = (e.widthMM / 2) * Math.sin(e.angle) + (e.heightMM / 2) * Math.cos(e.angle);
      e.position.y = 2 * cy - e.position.y - 2 * offY;
      e.flipY = !e.flipY;
    } else if (e instanceof TextEntity) {
      // MIRRTEXT=0: keep readable, reflect the footprint (see applyFlipH).
      const b = e.bounds();
      e.position.y += 2 * cy - (b.min.y + b.max.y);
    }
  }
}
