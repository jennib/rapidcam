/**
 * Stock height-map rasterizer.
 *
 * Mirrors the same entity-walk logic as gcode.ts (profilePolygon, engravePoints,
 * etc.) but instead of emitting G-code it stamps filled discs into a Float32Array
 * height field.  Each cell stores the current surface height above the table (mm).
 * Uncut cells start at stockThickness; each depth pass drives cells down.
 */

import type { Vec2 } from "../core/vec2";
import type { CADDocument } from "../model/document";
import {
  LineEntity, CircleEntity, RectEntity,
  PolylineEntity, ArcEntity, BezierEntity,
} from "../model/entities";
import type { CAMOperation } from "./types";
import { depthPasses } from "./postprocessors/base";
import { offsetPolygon } from "./offset";
import { flattenBezier } from "../core/geom";

/** Grid cells per millimetre. 2 = 0.5 mm/cell, sufficient for tool-diameter features. */
const RES = 2;

export interface HeightMap {
  /** Surface height above table at each cell (mm).  0 = through-cut, stockT = uncut. */
  data: Float32Array;
  gridW: number;
  gridH: number;
  stockW: number; // doc canvas width  (mm)
  stockH: number; // doc canvas height (mm, the "depth" axis in 3-D)
  stockT: number; // stock thickness   (mm)
}

export function rasterizeStock(ops: CAMOperation[], doc: CADDocument): HeightMap {
  const stockW = doc.canvas.width;
  const stockH = doc.canvas.height;
  const stockT = doc.stockThickness;
  const gridW  = Math.ceil(stockW * RES);
  const gridH  = Math.ceil(stockH * RES);
  const data   = new Float32Array(gridW * gridH).fill(stockT);

  const entityMap = new Map(doc.entities.map(e => [e.id, e]));
  for (const op of ops) rasterizeOp(op, entityMap, data, gridW, gridH, stockT);

  return { data, gridW, gridH, stockW, stockH, stockT };
}

// ---------------------------------------------------------------------------
// Per-operation dispatch (mirrors toolpathBody in gcode.ts)

function rasterizeOp(
  op: CAMOperation,
  entityMap: Map<string, unknown>,
  data: Float32Array,
  gridW: number,
  gridH: number,
  stockT: number,
): void {
  const lineSegIds = new Set<string>();

  // Chain any selected line segments into a closed polygon for profile ops.
  if (op.type === "profile") {
    const lineEnts = op.entityIds
      .map(id => entityMap.get(id))
      .filter((e): e is LineEntity => e instanceof LineEntity && !e.isConstruction);
    if (lineEnts.length >= 3) {
      const polygon = chainLines(lineEnts);
      if (polygon) rasProfilePolygon(polygon, op, data, gridW, gridH, stockT);
      lineEnts.forEach(e => lineSegIds.add(e.id));
    }
  }

  for (const id of op.entityIds) {
    if (lineSegIds.has(id)) continue;
    const ent = entityMap.get(id) as any;
    if (!ent || ent.isConstruction) continue;

    if (op.type === "drill") {
      if (ent instanceof CircleEntity) {
        for (const z of depthPasses(op))
          stampDisc(data, gridW, gridH,
            ent.center.x * RES, ent.center.y * RES,
            (op.diameter / 2) * RES, stockT + z);
      }
    } else if (op.type === "engrave") {
      if (ent instanceof LineEntity)
        sweepPolyline(op, data, gridW, gridH, stockT, [ent.a, ent.b], false);
      else if (ent instanceof CircleEntity)
        sweepCircle(op, data, gridW, gridH, stockT,
          ent.center.x, ent.center.y, ent.radius);
      else if (ent instanceof RectEntity)
        sweepPolyline(op, data, gridW, gridH, stockT, [...ent.corners()], true);
      else if (ent instanceof PolylineEntity)
        sweepPolyline(op, data, gridW, gridH, stockT, ent.points, ent.closed);
      else if (ent instanceof ArcEntity)
        sweepArc(op, data, gridW, gridH, stockT,
          ent.center.x, ent.center.y, ent.radius, ent.startAngle, ent.endAngle);
      else if (ent instanceof BezierEntity)
        sweepPolyline(op, data, gridW, gridH, stockT,
          flattenBezier(ent.p0, ent.p1, ent.p2, ent.p3, 0.05), false);
    } else { // profile
      if (ent instanceof CircleEntity)
        rasProfileCircle(ent.center.x, ent.center.y, ent.radius,
          op, data, gridW, gridH, stockT);
      else if (ent instanceof RectEntity)
        rasProfilePolygon([...ent.corners()], op, data, gridW, gridH, stockT);
      else if (ent instanceof PolylineEntity && ent.closed)
        rasProfilePolygon(ent.points, op, data, gridW, gridH, stockT);
    }
  }
}

// ---------------------------------------------------------------------------
// Primitive stamping

/** Set all cells within rCell of (cx, cy) to min(current, depth). */
function stampDisc(
  data: Float32Array, w: number, h: number,
  cx: number, cy: number, rCell: number, depth: number,
): void {
  const x0 = Math.max(0, Math.floor(cx - rCell));
  const x1 = Math.min(w - 1, Math.ceil(cx + rCell));
  const y0 = Math.max(0, Math.floor(cy - rCell));
  const y1 = Math.min(h - 1, Math.ceil(cy + rCell));
  const r2 = rCell * rCell;
  for (let y = y0; y <= y1; y++) {
    const base = y * w;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2) {
        if (depth < data[base + x]) data[base + x] = depth;
      }
    }
  }
}

/** Stamp discs along a segment from p0 to p1, spaced at half the tool radius. */
function walkSegment(
  data: Float32Array, w: number, h: number,
  p0: Vec2, p1: Vec2, toolRmm: number, depth: number,
): void {
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const lenMM = Math.sqrt(dx * dx + dy * dy);
  const rCell = toolRmm * RES;
  if (lenMM < 1e-9) { stampDisc(data, w, h, p0.x * RES, p0.y * RES, rCell, depth); return; }
  const steps = Math.max(1, Math.ceil(lenMM / (toolRmm * 0.5)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    stampDisc(data, w, h, (p0.x + t * dx) * RES, (p0.y + t * dy) * RES, rCell, depth);
  }
}

// ---------------------------------------------------------------------------
// Sweep helpers — these handle depth passes internally, mirroring gcode.ts

function sweepPolyline(
  op: CAMOperation, data: Float32Array, gridW: number, gridH: number, stockT: number,
  pts: Vec2[], closed: boolean,
): void {
  if (pts.length < 2) return;
  const r = op.diameter / 2;
  const n = pts.length;
  const segs = closed ? n : n - 1;
  for (const z of depthPasses(op)) {
    const depth = stockT + z;
    for (let i = 0; i < segs; i++)
      walkSegment(data, gridW, gridH, pts[i], pts[(i + 1) % n], r, depth);
  }
}

function sweepCircle(
  op: CAMOperation, data: Float32Array, gridW: number, gridH: number, stockT: number,
  cx: number, cy: number, radius: number,
): void {
  if (radius <= 0) return;
  const r = op.diameter / 2;
  const steps = Math.max(32, Math.ceil(2 * Math.PI * radius / (r * 0.5)));
  for (const z of depthPasses(op)) {
    const depth = stockT + z;
    const rCell = r * RES;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * 2 * Math.PI;
      stampDisc(data, gridW, gridH,
        (cx + radius * Math.cos(a)) * RES,
        (cy + radius * Math.sin(a)) * RES,
        rCell, depth);
    }
  }
}

function sweepArc(
  op: CAMOperation, data: Float32Array, gridW: number, gridH: number, stockT: number,
  cx: number, cy: number, radius: number, startAngle: number, endAngle: number,
): void {
  if (radius <= 0) return;
  const r = op.diameter / 2;
  let span = ((endAngle - startAngle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  if (span < 1e-9) span = 2 * Math.PI;
  const steps = Math.max(4, Math.ceil(radius * span / (r * 0.5)));
  for (const z of depthPasses(op)) {
    const depth = stockT + z;
    const rCell = r * RES;
    for (let i = 0; i <= steps; i++) {
      const a = startAngle + (i / steps) * span;
      stampDisc(data, gridW, gridH,
        (cx + radius * Math.cos(a)) * RES,
        (cy + radius * Math.sin(a)) * RES,
        rCell, depth);
    }
  }
}

// ---------------------------------------------------------------------------
// Profile helpers (offset then sweep)

function rasProfilePolygon(
  verts: Vec2[], op: CAMOperation,
  data: Float32Array, gridW: number, gridH: number, stockT: number,
): void {
  const toolR = op.diameter / 2;
  const paths = offsetPolygon(verts, op.side === "outside" ? toolR : -toolR);
  for (const path of paths) {
    if (path.length >= 2) sweepPolyline(op, data, gridW, gridH, stockT, path, true);
  }
}

function rasProfileCircle(
  cx: number, cy: number, r: number, op: CAMOperation,
  data: Float32Array, gridW: number, gridH: number, stockT: number,
): void {
  const toolR = op.diameter / 2;
  const cutR = op.side === "outside" ? r + toolR : r - toolR;
  if (cutR <= 0) return;
  sweepCircle(op, data, gridW, gridH, stockT, cx, cy, cutR);
}

// ---------------------------------------------------------------------------
// Chain line segments into a closed polygon (same logic as gcode.ts)

function chainLines(segs: LineEntity[]): Vec2[] | null {
  if (segs.length < 3) return null;
  const EPS = 1e-4;
  const used = new Set<string>();
  const chain: Vec2[] = [{ ...segs[0].a }, { ...segs[0].b }];
  used.add(segs[0].id);
  while (used.size < segs.length) {
    const tail = chain[chain.length - 1];
    let found = false;
    for (const seg of segs) {
      if (used.has(seg.id)) continue;
      const da = Math.hypot(seg.a.x - tail.x, seg.a.y - tail.y);
      const db = Math.hypot(seg.b.x - tail.x, seg.b.y - tail.y);
      if (da < EPS) { chain.push({ ...seg.b }); used.add(seg.id); found = true; break; }
      if (db < EPS) { chain.push({ ...seg.a }); used.add(seg.id); found = true; break; }
    }
    if (!found) return null;
  }
  const head = chain[0], tail = chain[chain.length - 1];
  if (Math.hypot(tail.x - head.x, tail.y - head.y) > EPS) return null;
  chain.pop();
  return chain;
}
