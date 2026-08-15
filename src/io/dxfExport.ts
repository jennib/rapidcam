/**
 * DXF export — converts the current document to an ASCII DXF string.
 *
 * Coordinate system: the document is Y-up millimetres and so is DXF — no axis
 * flip, and the HEADER declares $INSUNITS = 4 (mm) so importers scale
 * correctly. The file is a minimal AC1015 (2000-format) DXF: HEADER + ENTITIES
 * only, which the common CNC/laser ecosystem readers (LightBurn, QCAD,
 * LibreCAD, ezdxf-based tools — and our own importer) all accept.
 *
 * Mapping:
 *   LineEntity     → LINE            CircleEntity → CIRCLE
 *   ArcEntity      → ARC (CCW °)     PointEntity  → POINT
 *   RectEntity     → closed LWPOLYLINE
 *   PolylineEntity → LWPOLYLINE
 *   BezierEntity   → SPLINE (a cubic Bézier is a degree-3 clamped NURBS)
 *   TextEntity     → outline LWPOLYLINEs (exact shapes; falls back to a DXF
 *                    TEXT entity when the font can't be resolved)
 *   Images         → skipped (reported in warnings)
 *
 * Construction entities and invisible layers are skipped — they are drafting
 * aids, not geometry.
 */

import type { CADDocument } from "../model/document";
import { ORIGIN_ENTITY_ID } from "../model/document";
import {
  LineEntity,
  CircleEntity,
  RectEntity,
  PolylineEntity,
  ArcEntity,
  BezierEntity,
  TextEntity,
  PointEntity,
  RasterImageEntity,
} from "../model/entities";
import { TAU } from "../core/geom";
import { textToContours } from "../cam/textOutlines";
import { isFontResolvable } from "../core/fontManager";

export interface DxfExportResult {
  dxf: string;
  warnings: string[];
}

/** Format a coordinate: up to 6 decimals, no trailing zeros. */
function nv(v: number): string {
  return parseFloat(v.toFixed(6)).toString();
}

/** Radians → DXF degrees in [0, 360). */
function degNorm(rad: number): number {
  return ((((rad * 180) / Math.PI) % 360) + 360) % 360;
}

export function exportDxf(doc: CADDocument): DxfExportResult {
  const warnings: string[] = [];
  const out: (string | number)[] = [];
  const tag = (code: number, value: string | number) => {
    out.push(code, value);
  };

  // --- header ---------------------------------------------------------------
  tag(0, "SECTION");
  tag(2, "HEADER");
  tag(9, "$ACADVER");
  tag(1, "AC1015");
  tag(9, "$INSUNITS");
  tag(70, 4); // millimetres
  tag(0, "ENDSEC");

  // --- entities ---------------------------------------------------------------
  tag(0, "SECTION");
  tag(2, "ENTITIES");

  const layerName = new Map(doc.layers.map((l) => [l.id, l.name || l.id]));
  const visible = new Set(doc.layers.filter((l) => l.visible).map((l) => l.id));
  let skippedImages = 0;

  // `bulge` (group 42) belongs to the vertex the curved segment STARTS at:
  // tan(θ/4) of the segment's included angle, positive CCW. It is how a
  // polyline carries an arc, and what lets a rounded rectangle export as one
  // closed profile rather than as a tessellated approximation of itself.
  const lwpolyline = (
    pts: { x: number; y: number; bulge?: number }[],
    closed: boolean,
    layer: string,
  ) => {
    tag(0, "LWPOLYLINE");
    tag(8, layer);
    tag(90, pts.length);
    tag(70, closed ? 1 : 0);
    for (const p of pts) {
      tag(10, nv(p.x));
      tag(20, nv(p.y));
      if (p.bulge) tag(42, nv(p.bulge));
    }
  };

  for (const e of doc.entities) {
    if (e.isConstruction) continue;
    if (e.id === ORIGIN_ENTITY_ID) continue; // drafting datum, not part geometry
    if (!visible.has(e.layerId || "layer-0")) continue;
    const layer = layerName.get(e.layerId || "layer-0") ?? "0";

    if (e instanceof LineEntity) {
      tag(0, "LINE");
      tag(8, layer);
      tag(10, nv(e.a.x));
      tag(20, nv(e.a.y));
      tag(11, nv(e.b.x));
      tag(21, nv(e.b.y));
    } else if (e instanceof CircleEntity) {
      tag(0, "CIRCLE");
      tag(8, layer);
      tag(10, nv(e.center.x));
      tag(20, nv(e.center.y));
      tag(40, nv(e.radius));
    } else if (e instanceof ArcEntity) {
      // Both conventions are CCW from start to end — only rad→deg conversion.
      tag(0, "ARC");
      tag(8, layer);
      tag(10, nv(e.center.x));
      tag(20, nv(e.center.y));
      tag(40, nv(e.radius));
      tag(50, nv(degNorm(e.startAngle)));
      tag(51, nv(degNorm(e.endAngle)));
    } else if (e instanceof PointEntity) {
      tag(0, "POINT");
      tag(8, layer);
      tag(10, nv(e.pos.x));
      tag(20, nv(e.pos.y));
    } else if (e instanceof RectEntity) {
      if (e.hasShapedCorners()) {
        // One vertex per outline part, each carrying the bulge of the segment
        // leaving it — so the corners arrive in CAD as true arcs.
        lwpolyline(
          e.outlineParts().map((p) => {
            if (p.kind === "line") return { x: p.a.x, y: p.a.y };
            const span = ((((p.endAngle - p.startAngle) % TAU) + TAU) % TAU) - (p.ccw ? 0 : TAU);
            return {
              x: p.center.x + p.radius * Math.cos(p.startAngle),
              y: p.center.y + p.radius * Math.sin(p.startAngle),
              bulge: Math.tan(span / 4),
            };
          }),
          true,
          layer,
        );
      } else {
        const { minPt, maxPt } = e;
        lwpolyline(
          [
            { x: minPt.x, y: minPt.y },
            { x: maxPt.x, y: minPt.y },
            { x: maxPt.x, y: maxPt.y },
            { x: minPt.x, y: maxPt.y },
          ],
          true,
          layer,
        );
      }
    } else if (e instanceof PolylineEntity) {
      if (e.points.length >= 2) lwpolyline(e.outlinePoints(), e.closed, layer);
    } else if (e instanceof BezierEntity) {
      // A cubic Bézier is exactly a degree-3 NURBS with clamped knots.
      tag(0, "SPLINE");
      tag(8, layer);
      tag(70, 8); // planar
      tag(71, 3);
      tag(72, 8);
      tag(73, 4);
      tag(74, 0);
      for (const k of [0, 0, 0, 0, 1, 1, 1, 1]) tag(40, k);
      for (const p of [e.p0, e.p1, e.p2, e.p3]) {
        tag(10, nv(p.x));
        tag(20, nv(p.y));
      }
    } else if (e instanceof TextEntity) {
      if (!e.text) continue;
      if (isFontResolvable(e.fontId)) {
        // Outline polylines: exact shapes on any receiving system (the font
        // itself can't travel inside a DXF).
        for (const c of textToContours(e)) {
          if (c.points.length >= 2) lwpolyline(c.points, c.closed, layer);
        }
      } else {
        // No font to outline with — emit a DXF TEXT entity so the content at
        // least survives (the receiving app renders it in its own font).
        tag(0, "TEXT");
        tag(8, layer);
        tag(10, nv(e.position.x));
        tag(20, nv(e.position.y));
        tag(40, nv(e.sizeMM));
        tag(50, nv(degNorm(e.angle)));
        tag(1, e.text);
        warnings.push(
          `text "${e.text}" exported as a TEXT entity (font not available for outlining)`,
        );
      }
    } else if (e instanceof RasterImageEntity) {
      skippedImages++;
    }
  }

  tag(0, "ENDSEC");
  tag(0, "EOF");

  if (skippedImages > 0) {
    warnings.push(
      `${skippedImages} image${skippedImages > 1 ? "s" : ""} skipped — DXF has no raster mapping`,
    );
  }
  return { dxf: `${out.join("\n")}\n`, warnings };
}
