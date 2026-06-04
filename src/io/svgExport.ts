/**
 * SVG export — converts the current document to an SVG string.
 *
 * Coordinate system:
 *   The document stores geometry in Y-up millimetres. SVG uses Y-down.
 *   Every Y value is flipped: Y_svg = canvasHeight − Y_cam.
 *   This applies to all points, including Bezier control handles.
 *
 * The exported SVG uses mm as its unit, so 1 SVG user unit = 1 mm.
 * Opening the file in a browser or Inkscape will render it at the correct
 * physical size.
 */

import type { CADDocument } from "../model/document";
import {
  LineEntity, CircleEntity, RectEntity,
  PolylineEntity, ArcEntity, BezierEntity,
} from "../model/entities";

const TAU = Math.PI * 2;

/** Format a number to ≤3 decimal places, no trailing zeros. */
function sv(v: number): string {
  return parseFloat(v.toFixed(3)).toString();
}

/** Flip Y from CAM world (Y-up) to SVG canvas (Y-down). */
function fy(y: number, H: number): number {
  return H - y;
}

/** Convert a list of Vec2 points to the SVG `points` attribute format. */
function ptList(pts: { x: number; y: number }[], H: number): string {
  return pts.map(p => `${sv(p.x)},${sv(fy(p.y, H))}`).join(" ");
}

/**
 * Build the SVG path `d` attribute for an arc entity.
 *
 * Our world: Y-up, CCW arcs (positive angle direction).
 * SVG:       Y-down. After flipping Y, a Y-up CCW arc traces the same path
 * on screen going counterclockwise — which in SVG is sweep-flag=0
 * (negative-angle direction).
 *
 * large-arc-flag: 1 when the arc spans more than 180°.
 */
function arcPath(
  cx: number, cy: number, r: number,
  startAngle: number, endAngle: number,
  H: number,
): string {
  const span = ((endAngle - startAngle) % TAU + TAU) % TAU;

  const sx = cx + r * Math.cos(startAngle);
  const sy = fy(cy + r * Math.sin(startAngle), H);
  const ex = cx + r * Math.cos(endAngle);
  const ey = fy(cy + r * Math.sin(endAngle), H);

  const largeArc = span > Math.PI ? 1 : 0;
  const sweep = 0; // Y-up CCW → Y-down CCW → sweep-flag=0

  return `M ${sv(sx)} ${sv(sy)} A ${sv(r)} ${sv(r)} 0 ${largeArc} ${sweep} ${sv(ex)} ${sv(ey)}`;
}

/**
 * Export the document as an SVG string.
 * Construction entities are skipped — they are drafting aids, not geometry.
 */
export function exportSvg(doc: CADDocument): string {
  const W = doc.canvas.width;
  const H = doc.canvas.height;

  const lines: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg"`,
    `     width="${sv(W)}mm" height="${sv(H)}mm"`,
    `     viewBox="0 0 ${sv(W)} ${sv(H)}">`,
    `  <g stroke="black" stroke-width="0.5" fill="none">`,
  ];

  for (const e of doc.entities) {
    if (e.isConstruction) continue;

    if (e instanceof LineEntity) {
      lines.push(
        `    <line x1="${sv(e.a.x)}" y1="${sv(fy(e.a.y, H))}"` +
        ` x2="${sv(e.b.x)}" y2="${sv(fy(e.b.y, H))}" />`,
      );

    } else if (e instanceof CircleEntity) {
      lines.push(
        `    <circle cx="${sv(e.center.x)}" cy="${sv(fy(e.center.y, H))}"` +
        ` r="${sv(e.radius)}" />`,
      );

    } else if (e instanceof RectEntity) {
      // In Y-up, minPt is bottom-left and maxPt is top-right.
      // In SVG (Y-down), the rect's top edge corresponds to maxPt.y in Y-up.
      lines.push(
        `    <rect x="${sv(e.minPt.x)}" y="${sv(fy(e.maxPt.y, H))}"` +
        ` width="${sv(e.width)}" height="${sv(e.height)}" />`,
      );

    } else if (e instanceof PolylineEntity) {
      if (e.points.length < 2) continue;
      const pts = ptList(e.points, H);
      if (e.closed) {
        lines.push(`    <polygon points="${pts}" />`);
      } else {
        lines.push(`    <polyline points="${pts}" />`);
      }

    } else if (e instanceof ArcEntity) {
      lines.push(
        `    <path d="${arcPath(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle, H)}" />`,
      );

    } else if (e instanceof BezierEntity) {
      const x0 = sv(e.p0.x), y0 = sv(fy(e.p0.y, H));
      const x1 = sv(e.p1.x), y1 = sv(fy(e.p1.y, H));
      const x2 = sv(e.p2.x), y2 = sv(fy(e.p2.y, H));
      const x3 = sv(e.p3.x), y3 = sv(fy(e.p3.y, H));
      lines.push(`    <path d="M ${x0} ${y0} C ${x1} ${y1} ${x2} ${y2} ${x3} ${y3}" />`);
    }
  }

  lines.push("  </g>");
  lines.push("</svg>");

  return lines.join("\n");
}
