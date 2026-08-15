/**
 * Map a probe sketch's entities to overlay {@link PreviewShape}s so the
 * generator dialog can ghost its output on the canvas while the user types —
 * without committing anything to the document. Pure: reads the sketch, applies
 * `offset` arithmetically (probe entities are never translated), and returns
 * plain shape descriptors for the renderer's existing preview channel.
 */

import {
  ArcEntity,
  BezierEntity,
  CircleEntity,
  LineEntity,
  PointEntity,
  PolylineEntity,
  RectEntity,
} from "../model/entities";
import type { PreviewShape } from "../view/overlay";
import type { Pt, Sketch } from "./sketch";

export function sketchPreviews(sketch: Sketch, offset: Pt): PreviewShape[] {
  const add = (p: Pt): Pt => ({ x: p.x + offset.x, y: p.y + offset.y });
  const shapes: PreviewShape[] = [];
  for (const e of sketch.entities) {
    if (e instanceof LineEntity) {
      shapes.push({ kind: "line", a: add(e.a), b: add(e.b) });
    } else if (e instanceof CircleEntity) {
      shapes.push({ kind: "circle", center: add(e.center), radius: e.radius });
    } else if (e instanceof ArcEntity) {
      shapes.push({
        kind: "arc",
        center: add(e.center),
        radius: e.radius,
        startAngle: e.startAngle,
        endAngle: e.endAngle,
      });
    } else if (e instanceof BezierEntity) {
      shapes.push({ kind: "bezier", p0: add(e.p0), p1: add(e.p1), p2: add(e.p2), p3: add(e.p3) });
    } else if (e instanceof RectEntity) {
      const b = e.bounds();
      shapes.push({ kind: "rect", p0: add(b.min), p1: add(b.max) });
    } else if (e instanceof PolylineEntity) {
      shapes.push({ kind: "polyline", points: e.outlinePoints().map(add), closed: e.closed });
    } else if (e instanceof PointEntity) {
      shapes.push({ kind: "point", pos: add(e.getPoint("p")) });
    }
    // Text/Image entities can't be emitted by generators (v1 scope); anything
    // unrecognized is simply not previewed rather than guessed at.
  }
  return shapes;
}
