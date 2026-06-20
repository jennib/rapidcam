/**
 * Stock height-map rasterizer.
 *
 * Mirrors the same entity-walk logic as gcode.ts (profilePolygon, engravePoints,
 * etc.) but instead of emitting G-code it stamps filled shapes into a Float32Array
 * height field.  Each cell stores the current surface height above the table (mm).
 * Uncut cells start at stockThickness; each depth pass drives cells down.
 *
 * Tool geometry is respected:
 *   end-mill  — flat disc (original behaviour)
 *   ball-nose — hemispherical stamp: h(d) = depth + R − √(R²−d²)
 *   v-bit     — V-cone stamp: h(d) = depth + d / tan(halfAngle)
 *   drill     — V-cone stamp using tip angle; natural cylindrical bore via acc. passes
 */

import type { Vec2 } from "../core/vec2";
import type { CADDocument } from "../model/document";
import {
  LineEntity, CircleEntity, RectEntity,
  PolylineEntity, ArcEntity, BezierEntity, TextEntity,
} from "../model/entities";
import { textToContours } from "./textOutlines";
import { type CAMOperation, chamferDepth } from "./types";
import { depthPasses } from "./postprocessors/base";
import { offsetPolygon, signedArea, startAtLongestEdgeMid } from "./offset";
import { pathLengths, computeTabRegions, splitPathForTabs } from "./tabs";
import { rasterRows, rasterRowsWithIslands } from "./pocket";
import { chainLinesIntoPolygons, collectClosedLoops } from "./loops";
import { resolveRegion } from "./regions";
import type { Entity } from "../model/entities";
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
  if (op.type === "chamfer") {
    rasChamfer(op, entityMap, data, gridW, gridH, stockT);
    return;
  }

  const stamp  = makeStampFn(op, data, gridW, gridH, stockT);
  const stepR  = effectiveToolR(op);
  const lineSegIds = new Set<string>();

  // Region pockets (mirrors gcode.ts): resolve each parametric region from live
  // geometry and pocket it with enclosed loops as islands.
  if (op.type === "pocket" && op.regions && op.regions.length > 0) {
    const loops = collectClosedLoops(entityMap.values() as Iterable<Entity>);
    for (const ref of op.regions) {
      const region = resolveRegion(ref, loops);
      if (region)
        rasPocketPolygon(region.outer, region.holes, op, data, gridW, gridH, stockT, stamp, stepR);
    }
    return;
  }

  // Collect island polygons for pocket operations.
  const islandSet = new Set(op.islandIds ?? []);
  const islands: Vec2[][] = [];
  if (op.type === "pocket" && islandSet.size > 0) {
    for (const id of islandSet) {
      const e = entityMap.get(id) as any;
      if (!e || e.isConstruction) continue;
      if (e instanceof CircleEntity) {
        const nSegs = Math.max(64, Math.ceil(2 * Math.PI * e.radius / 0.5));
        islands.push(Array.from({ length: nSegs }, (_: unknown, i: number) => {
          const a = (i / nSegs) * 2 * Math.PI;
          return { x: e.center.x + e.radius * Math.cos(a), y: e.center.y + e.radius * Math.sin(a) };
        }));
      } else if (e instanceof RectEntity) {
        islands.push([...e.corners()]);
      } else if (e instanceof PolylineEntity && e.closed) {
        islands.push(e.points);
      }
    }
    // Also chain any line segments in the island set into closed polygons.
    const islandLineEnts = [...islandSet]
      .map(id => entityMap.get(id))
      .filter((e): e is LineEntity => e instanceof LineEntity && !e.isConstruction);
    for (const { verts } of chainLinesIntoPolygons(islandLineEnts).polygons)
      islands.push(verts);
  }

  // Chain any selected line segments into closed polygons for profile/pocket ops.
  if (op.type === "profile" || op.type === "pocket") {
    const lineEnts = op.entityIds
      .filter(id => !islandSet.has(id))
      .map(id => entityMap.get(id))
      .filter((e): e is LineEntity => e instanceof LineEntity && !e.isConstruction);
    if (lineEnts.length > 0) {
      for (const { verts } of chainLinesIntoPolygons(lineEnts).polygons) {
        if (op.type === "pocket") rasPocketPolygon(verts, islands, op, data, gridW, gridH, stockT, stamp, stepR);
        else rasProfilePolygon(verts, op, data, gridW, gridH, stockT, stamp, stepR);
      }
      lineEnts.forEach(e => lineSegIds.add(e.id));
    }
  }

  for (const id of op.entityIds) {
    if (lineSegIds.has(id) || islandSet.has(id)) continue;
    const ent = entityMap.get(id) as any;
    if (!ent || ent.isConstruction) continue;

    // Expand TextEntity to glyph contours and re-dispatch
    if (ent instanceof TextEntity) {
      const contours = textToContours(ent);
      for (const c of contours) {
        if (op.type === "engrave")
          sweepPolyline(op, data, gridW, gridH, stockT, c.points, c.closed, stamp, stepR);
        else if (op.type === "pocket" && c.closed)
          rasPocketPolygon(c.points, islands, op, data, gridW, gridH, stockT, stamp, stepR);
        else if (op.type === "profile" && c.closed)
          rasProfilePolygon(c.points, op, data, gridW, gridH, stockT, stamp, stepR);
      }
      continue;
    }

    if (op.type === "drill") {
      if (ent instanceof CircleEntity) {
        const cx = ent.center.x * RES;
        const cy = ent.center.y * RES;
        for (const z of depthPasses(op))
          stamp(cx, cy, stockT + z);
      }
    } else if (op.type === "engrave") {
      if (ent instanceof LineEntity)
        sweepPolyline(op, data, gridW, gridH, stockT, [ent.a, ent.b], false, stamp, stepR);
      else if (ent instanceof CircleEntity)
        sweepCircle(op, data, gridW, gridH, stockT,
          ent.center.x, ent.center.y, ent.radius, stamp, stepR);
      else if (ent instanceof RectEntity)
        sweepPolyline(op, data, gridW, gridH, stockT, [...ent.corners()], true, stamp, stepR);
      else if (ent instanceof PolylineEntity)
        sweepPolyline(op, data, gridW, gridH, stockT, ent.points, ent.closed, stamp, stepR);
      else if (ent instanceof ArcEntity)
        sweepArc(op, data, gridW, gridH, stockT,
          ent.center.x, ent.center.y, ent.radius, ent.startAngle, ent.endAngle, stamp, stepR);
      else if (ent instanceof BezierEntity)
        sweepPolyline(op, data, gridW, gridH, stockT,
          flattenBezier(ent.p0, ent.p1, ent.p2, ent.p3, 0.05), false, stamp, stepR);
    } else if (op.type === "pocket") {
      if (ent instanceof CircleEntity)
        rasPocketCircle(ent.center.x, ent.center.y, ent.radius,
          islands, op, data, gridW, gridH, stockT, stamp, stepR);
      else if (ent instanceof RectEntity)
        rasPocketPolygon([...ent.corners()], islands, op, data, gridW, gridH, stockT, stamp, stepR);
      else if (ent instanceof PolylineEntity && ent.closed)
        rasPocketPolygon(ent.points, islands, op, data, gridW, gridH, stockT, stamp, stepR);
    } else { // profile
      if (ent instanceof CircleEntity)
        rasProfileCircle(ent.center.x, ent.center.y, ent.radius,
          op, data, gridW, gridH, stockT, stamp, stepR);
      else if (ent instanceof RectEntity)
        rasProfilePolygon([...ent.corners()], op, data, gridW, gridH, stockT, stamp, stepR);
      else if (ent instanceof PolylineEntity && ent.closed)
        rasProfilePolygon(ent.points, op, data, gridW, gridH, stockT, stamp, stepR);
    }
  }
}

/**
 * Chamfer preview: walk the (optionally offset) contour with the V-cone stamp at
 * the derived depth — mirrors the chamfer G-code so the 3D preview matches.
 */
function rasChamfer(
  op: CAMOperation,
  entityMap: Map<string, unknown>,
  data: Float32Array, gridW: number, gridH: number, stockT: number,
): void {
  if (op.toolType !== "v-bit" || (op.chamferWidth ?? 0) <= 0) return;
  const cop = { ...op, depth: chamferDepth(op) };
  const stamp = makeStampFn(cop, data, gridW, gridH, stockT);
  const stepR = effectiveToolR(cop);
  const side = op.chamferSide ?? "on";
  const w = op.chamferWidth ?? 0;

  const closed = (verts: Vec2[]): void => {
    let paths = [verts];
    if (side !== "on") {
      const ccw = signedArea(verts) >= 0 ? verts : [...verts].reverse();
      const offs = offsetPolygon(ccw, side === "outside" ? w : -w);
      if (offs.length) paths = offs;
    }
    for (const p of paths) sweepPolyline(cop, data, gridW, gridH, stockT, p, true, stamp, stepR);
  };

  const lineSegIds = new Set<string>();
  const lineEnts = op.entityIds
    .map((id) => entityMap.get(id))
    .filter((e): e is LineEntity => e instanceof LineEntity && !e.isConstruction);
  for (const { verts } of chainLinesIntoPolygons(lineEnts).polygons) closed(verts);
  lineEnts.forEach((e) => lineSegIds.add(e.id));

  for (const id of op.entityIds) {
    if (lineSegIds.has(id)) continue;
    const ent = entityMap.get(id) as any;
    if (!ent || ent.isConstruction) continue;
    if (ent instanceof TextEntity) {
      for (const c of textToContours(ent)) if (c.closed) closed(c.points);
    } else if (ent instanceof CircleEntity) {
      const r = side === "outside" ? ent.radius + w
              : side === "inside"  ? Math.max(0.01, ent.radius - w) : ent.radius;
      sweepCircle(cop, data, gridW, gridH, stockT, ent.center.x, ent.center.y, r, stamp, stepR);
    } else if (ent instanceof RectEntity) {
      closed([...ent.corners()]);
    } else if (ent instanceof PolylineEntity && ent.closed) {
      closed(ent.points);
    } else if (ent instanceof PolylineEntity) {
      sweepPolyline(cop, data, gridW, gridH, stockT, ent.points, false, stamp, stepR);
    } else if (ent instanceof LineEntity) {
      sweepPolyline(cop, data, gridW, gridH, stockT, [ent.a, ent.b], false, stamp, stepR);
    } else if (ent instanceof ArcEntity) {
      sweepArc(cop, data, gridW, gridH, stockT,
        ent.center.x, ent.center.y, ent.radius, ent.startAngle, ent.endAngle, stamp, stepR);
    } else if (ent instanceof BezierEntity) {
      sweepPolyline(cop, data, gridW, gridH, stockT,
        flattenBezier(ent.p0, ent.p1, ent.p2, ent.p3, 0.05), false, stamp, stepR);
    }
  }
}

// ---------------------------------------------------------------------------
// Stamp-function factory — returns a closure for the right tool geometry

type StampFn = (cx: number, cy: number, depth: number) => void;

function makeStampFn(
  op: CAMOperation,
  data: Float32Array, w: number, h: number, stockT: number,
): StampFn {
  const R     = op.diameter / 2;
  const Rcell = R * RES;
  const tt    = op.toolType ?? "end-mill";

  if (tt === "ball-nose") {
    return (cx, cy, d) => stampBallNose(data, w, h, cx, cy, R, d);
  }
  if (tt === "v-bit") {
    const halfTan = Math.tan(((op.vAngle ?? 60) / 2) * (Math.PI / 180));
    return (cx, cy, d) => stampVCone(data, w, h, cx, cy, halfTan, d, stockT);
  }
  if (tt === "drill") {
    const tipHalfTan = Math.tan(((op.tipAngle ?? 118) / 2) * (Math.PI / 180));
    return (cx, cy, d) => stampVCone(data, w, h, cx, cy, tipHalfTan, d, stockT);
  }
  // end-mill (and any unrecognised type): flat disc
  return (cx, cy, d) => stampDisc(data, w, h, cx, cy, Rcell, d);
}

/** Step radius used for spacing stamps along a path sweep. */
function effectiveToolR(op: CAMOperation): number {
  if ((op.toolType ?? "end-mill") === "v-bit") {
    // At max depth the V-bit footprint is this wide; use it for dense-enough stepping.
    return Math.max(
      0.05,
      Math.abs(op.depth) * Math.tan(((op.vAngle ?? 60) / 2) * (Math.PI / 180)),
    );
  }
  return op.diameter / 2;
}

// ---------------------------------------------------------------------------
// Stamp primitives

/** Flat-bottomed disc (end mill). */
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

/**
 * Hemispherical stamp (ball-nose).
 * At lateral distance d_mm from centre: h = depth + R − √(R²−d²)
 * Produces a rounded trough cross-section.
 */
function stampBallNose(
  data: Float32Array, w: number, h: number,
  cx: number, cy: number, R_mm: number, depth: number,
): void {
  const Rcell = R_mm * RES;
  const R2    = R_mm * R_mm;
  const x0 = Math.max(0, Math.floor(cx - Rcell));
  const x1 = Math.min(w - 1, Math.ceil(cx + Rcell));
  const y0 = Math.max(0, Math.floor(cy - Rcell));
  const y1 = Math.min(h - 1, Math.ceil(cy + Rcell));
  for (let y = y0; y <= y1; y++) {
    const base = y * w;
    for (let x = x0; x <= x1; x++) {
      const dxMM = (x - cx) / RES;
      const dyMM = (y - cy) / RES;
      const d2 = dxMM * dxMM + dyMM * dyMM;
      if (d2 > R2) continue;
      const hAt = depth + R_mm - Math.sqrt(R2 - d2);
      if (hAt < data[base + x]) data[base + x] = hAt;
    }
  }
}

/**
 * V-cone stamp (V-bit engraving, drill tip).
 * At lateral distance d_mm from centre: h = depth + d_mm / halfAngleTan
 * Produces the characteristic V-groove cross-section; naturally capped at stockT.
 * For a drill tool the cone also creates the vertical-wall illusion at the tool
 * radius since the height field transitions sharply from h(R) to stockT outside R.
 */
function stampVCone(
  data: Float32Array, w: number, h: number,
  cx: number, cy: number, halfAngleTan: number, depth: number, stockT: number,
): void {
  // Maximum lateral reach in mm where the cone still removes material
  const dMaxMM   = (stockT - depth) * halfAngleTan;
  const dMaxCell = dMaxMM * RES;
  const x0 = Math.max(0, Math.floor(cx - dMaxCell));
  const x1 = Math.min(w - 1, Math.ceil(cx + dMaxCell));
  const y0 = Math.max(0, Math.floor(cy - dMaxCell));
  const y1 = Math.min(h - 1, Math.ceil(cy + dMaxCell));
  for (let y = y0; y <= y1; y++) {
    const base = y * w;
    for (let x = x0; x <= x1; x++) {
      const dxMM = (x - cx) / RES;
      const dyMM = (y - cy) / RES;
      const dMM  = Math.sqrt(dxMM * dxMM + dyMM * dyMM);
      const hAt  = depth + dMM / halfAngleTan;
      if (hAt < stockT && hAt < data[base + x]) data[base + x] = hAt;
    }
  }
}

// ---------------------------------------------------------------------------
// Walk / sweep helpers

/** Stamp along a segment p0→p1, spaced at half the effective tool radius. */
function walkSegment(
  p0: Vec2, p1: Vec2,
  stepR_mm: number, depth: number,
  stamp: StampFn,
): void {
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const lenMM = Math.sqrt(dx * dx + dy * dy);
  if (lenMM < 1e-9) { stamp(p0.x * RES, p0.y * RES, depth); return; }
  const steps = Math.max(1, Math.ceil(lenMM / (stepR_mm * 0.5)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    stamp((p0.x + t * dx) * RES, (p0.y + t * dy) * RES, depth);
  }
}

function sweepPolyline(
  op: CAMOperation, _data: Float32Array, _gridW: number, _gridH: number, stockT: number,
  pts: Vec2[], closed: boolean,
  stamp: StampFn, stepR: number,
): void {
  if (pts.length < 2) return;
  const n    = pts.length;
  const segs = closed ? n : n - 1;
  for (const z of depthPasses(op)) {
    const depth = stockT + z;
    for (let i = 0; i < segs; i++)
      walkSegment(pts[i], pts[(i + 1) % n], stepR, depth, stamp);
  }
}

function sweepCircle(
  op: CAMOperation, _data: Float32Array, _gridW: number, _gridH: number, stockT: number,
  cx: number, cy: number, radius: number,
  stamp: StampFn, stepR: number,
): void {
  if (radius <= 0) return;
  const steps = Math.max(32, Math.ceil(2 * Math.PI * radius / (stepR * 0.5)));
  for (const z of depthPasses(op)) {
    const depth = stockT + z;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * 2 * Math.PI;
      stamp((cx + radius * Math.cos(a)) * RES, (cy + radius * Math.sin(a)) * RES, depth);
    }
  }
}

function sweepArc(
  op: CAMOperation, _data: Float32Array, _gridW: number, _gridH: number, stockT: number,
  cx: number, cy: number, radius: number, startAngle: number, endAngle: number,
  stamp: StampFn, stepR: number,
): void {
  if (radius <= 0) return;
  let span = ((endAngle - startAngle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  if (span < 1e-9) span = 2 * Math.PI;
  const steps = Math.max(4, Math.ceil(radius * span / (stepR * 0.5)));
  for (const z of depthPasses(op)) {
    const depth = stockT + z;
    for (let i = 0; i <= steps; i++) {
      const a = startAngle + (i / steps) * span;
      stamp((cx + radius * Math.cos(a)) * RES, (cy + radius * Math.sin(a)) * RES, depth);
    }
  }
}

// ---------------------------------------------------------------------------
// Profile helpers (offset then sweep)

function rasProfilePolygon(
  verts: Vec2[], op: CAMOperation,
  _data: Float32Array, _gridW: number, _gridH: number, stockT: number,
  stamp: StampFn, stepR: number,
): void {
  const toolR = op.diameter / 2;
  const paths = offsetPolygon(verts, op.side === "outside" ? toolR : -toolR);

  const tabs    = op.tabs;
  const hasTabs = !!(tabs?.enabled && tabs.count > 0 && tabs.width > 0 && tabs.height > 0);
  const tabZOff = hasTabs ? op.depth + tabs!.height : 0;

  // Lead-in/out lengths (linear approximation of the cut path — enough to carve
  // the lead grooves into the height field so the preview matches the G-code).
  const liLen = op.leadIn  && op.leadIn.type  !== "none" ? (op.leadIn.length  ?? 2) : 0;
  const loLen = op.leadOut && op.leadOut.type !== "none" ? (op.leadOut.length ?? 2) : 0;

  const useLead = liLen > 0 || loLen > 0;
  const unit = (a: Vec2, b: Vec2): Vec2 => {
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
    return { x: dx / L, y: dy / L };
  };
  for (const rawPath of paths) {
    if (rawPath.length < 2) continue;
    // Mirror the G-code: mid-side start only when a lead is used.
    const path = useLead ? startAtLongestEdgeMid(rawPath) : rawPath;
    const np = path.length;

    const tIn = unit(path[0], path[1]);            // entry tangent
    const tOut = unit(path[np - 1], path[0]);      // exit (arrival) tangent
    const leadInP  = liLen > 0 ? { x: path[0].x - tIn.x * liLen, y: path[0].y - tIn.y * liLen } : null;
    const leadOutP = loLen > 0 ? { x: path[0].x + tOut.x * loLen, y: path[0].y + tOut.y * loLen } : null;

    for (const z of depthPasses(op)) {
      const depth              = stockT + z;
      const useTabsThisPass    = hasTabs && z < tabZOff;

      if (leadInP) walkSegment(leadInP, path[0], stepR, depth, stamp);

      if (!useTabsThisPass) {
        for (let i = 0; i < np; i++)
          walkSegment(path[i], path[(i + 1) % np], stepR, depth, stamp);
      } else {
        const tabDepth = stockT + tabZOff;
        const cumLens  = pathLengths(path);
        const totalLen = cumLens[path.length];
        const regions  = computeTabRegions(totalLen, tabs!.count, tabs!.width);
        const segs     = splitPathForTabs(path, cumLens, regions);
        for (const seg of segs)
          walkSegment(seg.p0, seg.p1, stepR, seg.isTab ? tabDepth : depth, stamp);
      }

      if (leadOutP) walkSegment(path[0], leadOutP, stepR, depth, stamp);
    }
  }
}

function rasProfileCircle(
  cx: number, cy: number, r: number, op: CAMOperation,
  data: Float32Array, gridW: number, gridH: number, stockT: number,
  stamp: StampFn, stepR: number,
): void {
  const toolR = op.diameter / 2;
  const cutR  = op.side === "outside" ? r + toolR : r - toolR;
  if (cutR <= 0) return;
  sweepCircle(op, data, gridW, gridH, stockT, cx, cy, cutR, stamp, stepR);
}

function rasPocketPolygon(
  verts: Vec2[], islands: Vec2[][], op: CAMOperation,
  _data: Float32Array, _gridW: number, _gridH: number, stockT: number,
  stamp: StampFn, stepR: number,
): void {
  const toolR    = op.diameter / 2;
  const stepover = Math.max(0.01, (op.stepover ?? 0.4) * op.diameter);
  const insets   = offsetPolygon(verts, -toolR);
  const islandKeepouts = islands.flatMap(isl => {
    const pts = signedArea(isl) >= 0 ? isl : [...isl].reverse();
    const expanded = offsetPolygon(pts, toolR);
    return expanded.length > 0 ? expanded : [pts];
  });
  for (const inset of insets) {
    if (inset.length < 2) continue;
    const rows = islandKeepouts.length > 0
      ? rasterRowsWithIslands(inset, islandKeepouts, stepover)
      : rasterRows(inset, stepover);
    for (const z of depthPasses(op)) {
      const depth = stockT + z;
      for (const row of rows)
        for (let i = 0; i + 1 < row.length; i += 2)
          walkSegment(row[i], row[i + 1], stepR, depth, stamp);
      // Sweep outer inset boundary (finish pass)
      const np = inset.length;
      for (let i = 0; i < np; i++)
        walkSegment(inset[i], inset[(i + 1) % np], stepR, depth, stamp);
      // Sweep island keepout boundaries (finish pass for island walls)
      for (const keepout of islandKeepouts) {
        const kn = keepout.length;
        for (let i = 0; i < kn; i++)
          walkSegment(keepout[i], keepout[(i + 1) % kn], stepR, depth, stamp);
      }
    }
  }
}

function rasPocketCircle(
  cx: number, cy: number, r: number, islands: Vec2[][], op: CAMOperation,
  data: Float32Array, gridW: number, gridH: number, stockT: number,
  stamp: StampFn, stepR: number,
): void {
  const toolR = op.diameter / 2;
  if (islands.length > 0) {
    const nSegs = Math.max(64, Math.ceil(2 * Math.PI * r / 0.5));
    const verts: Vec2[] = Array.from({ length: nSegs }, (_, i) => {
      const a = (i / nSegs) * 2 * Math.PI;
      return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
    });
    rasPocketPolygon(verts, islands, op, data, gridW, gridH, stockT, stamp, stepR);
    return;
  }
  const cutR = r - toolR;
  if (cutR <= 0) return;
  const nSegs = Math.max(64, Math.ceil(2 * Math.PI * cutR / 0.5));
  const verts: Vec2[] = Array.from({ length: nSegs }, (_, i) => {
    const a = (i / nSegs) * 2 * Math.PI;
    return { x: cx + cutR * Math.cos(a), y: cy + cutR * Math.sin(a) };
  });
  rasPocketPolygon(verts, [], op, data, gridW, gridH, stockT, stamp, stepR);
}

