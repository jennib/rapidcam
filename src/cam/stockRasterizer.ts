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
 *   drill     — V-cone stamp using tip angle, clamped to the bit's own radius (a
 *               real bit's flutes run straight past the point, not an ever-
 *               widening cone) — see {@link makeStampFn}, {@link stampVCone}
 */

import type { Vec2 } from "../core/vec2";
import { machinableEntityMap } from "./machinable";
import { laserFillGeometry } from "./lasergcode";
import { type CADDocument, stockFootprint } from "../model/document";
import {
  LineEntity,
  CircleEntity,
  RectEntity,
  PolylineEntity,
  ArcEntity,
  BezierEntity,
  TextEntity,
  RasterImageEntity,
} from "../model/entities";
import { textToContours } from "./textOutlines";
import { rasterField, makeRasterXf, xfPoint } from "./rasterEngrave";
import { getImageGrid } from "../core/imageManager";
import { type CAMOperation, DEFAULTS, chamferDepth, chamferSharpSequence } from "./types";
import { depthPasses } from "./postprocessors/base";
import { offsetPolygon, signedArea, startAtLongestEdgeMid } from "./offset";
import { addCornerReliefs } from "./dogbone";
import { pathLengths, computeTabRegions, resolveTabCount, splitPathForTabs } from "./tabs";
import { rasterRows, rasterRowsWithIslands } from "./pocket";
import {
  chainOpenCurvesIntoLoops,
  collectClosedLoops,
} from "./loops";
import { expandOpPatternTargets } from "./patternExpand";
import { resolveRegion } from "./regions";
import {
  vcarveRegion,
  vcarveParamsForOp,
  groupContoursIntoRegions,
  type CarveRegion,
} from "./vcarve";
import type { Entity } from "../model/entities";
import { flattenBezier } from "../core/geom";

/**
 * Grid cells per millimetre for the preview height field.
 *
 * Higher resolution = smaller raster steps, so cut walls read as clean slopes
 * instead of a stair-stepped edge in the 3D preview. Memory and mesh size grow
 * with RES², so `rasterizeStock` adapts it per job: it aims for TARGET_RES and
 * only steps down (never below the historical 2) when a large stock would blow
 * past the cell budget. Set once at the top of `rasterizeStock`, then read by
 * the stamp helpers below — safe because rasterization is fully synchronous.
 */
let RES = 4;
const TARGET_RES = 4; // 0.25 mm/cell — smooth walls for typical parts
const MIN_RES = 2; // 0.5 mm/cell — historical floor, used only for huge stock
const MAX_CELLS = 4_000_000; // caps the R32F texture + mesh at a safe size

/**
 * Visual-only surface relief (mm) for a laser engrave in the 3D preview.
 *
 * A laser scorches the surface rather than gouging it, so this stays shallow —
 * deep enough to register as material removed (above webglPreview's cut
 * threshold) and to give the burn edges a hint of relief, but not so deep it
 * reads as a milled pocket. The burn is conveyed mainly by COLOUR in the shader
 * (see the laser branch of the flat-surface fragment shader), which normalizes
 * removed depth against this value to get a 0..1 burn intensity.
 */
export const LASER_BURN_DEPTH_MM = 0.4;

export interface HeightMap {
  /** Surface height above table at each cell (mm).  0 = through-cut, stockT = uncut. */
  data: Float32Array;
  gridW: number;
  gridH: number;
  stockW: number; // doc canvas width  (mm)
  stockH: number; // doc canvas height (mm, the "depth" axis in 3-D)
  stockT: number; // stock thickness   (mm)
  /** Shade the surface as a laser burn (scorch/char) rather than a milled cut. */
  laser?: boolean;
}

export function rasterizeStock(ops: CAMOperation[], doc: CADDocument): HeightMap {
  const { width: stockW, height: stockH } = stockFootprint(doc);
  const stockT = doc.stockThickness;
  const sx = doc.stockRect && !doc.isRotary ? doc.stockRect.x : 0;
  const sy = doc.stockRect && !doc.isRotary ? doc.stockRect.y : 0;

  // Pick the finest resolution that keeps the grid under the cell budget.
  RES = TARGET_RES;
  while (RES > MIN_RES && Math.ceil(stockW * RES) * Math.ceil(stockH * RES) > MAX_CELLS) RES--;

  const gridW = Math.ceil(stockW * RES);
  const gridH = Math.ceil(stockH * RES);
  const offX = sx * RES;
  const offY = sy * RES;
  const data = new Float32Array(gridW * gridH).fill(stockT);

  const entityMap = machinableEntityMap(doc);
  // Expand pattern targets so the 3D preview matches the toolpath: an op on
  // patterned geometry renders all instances and follows the count.
  const isLaser = doc.isLaser;
  for (const op of ops) {
    rasterizeOp(
      expandOpPatternTargets(op, doc),
      entityMap,
      data,
      gridW,
      gridH,
      stockT,
      isLaser,
      offX,
      offY,
    );
  }

  return { data, gridW, gridH, stockW, stockH, stockT, laser: isLaser };
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
  isLaser: boolean,
  offX: number,
  offY: number,
): void {
  if (op.type === "chamfer") {
    rasChamfer(op, entityMap, data, gridW, gridH, stockT, offX, offY);
    return;
  }

  if (op.type === "vcarve") {
    rasVcarve(op, entityMap, data, gridW, gridH, stockT, offX, offY);
    return;
  }

  const stamp = makeStampFn(op, data, gridW, gridH, stockT, isLaser, offX, offY);
  const stepR = effectiveToolR(op, isLaser);
  const lineSegIds = new Set<string>();

  // Area-fill engrave: the beam floods the interior, so the height field must
  // too. This asks the LASER GENERATOR for the very geometry it will burn
  // (cam/lasergcode.ts), rather than deriving a second opinion here — left to
  // the per-entity walk below, a solid fill stroked only its outlines and
  // previewed as hollow lettering while the posted program filled it solid.
  if (isLaser && op.type === "engrave" && op.laserFill) {
    const { outlines, segments } = laserFillGeometry(op, entityMap as Map<string, Entity>);
    for (const ring of outlines)
      sweepPolyline(op, data, gridW, gridH, stockT, ring, true, stamp, stepR);
    for (const [a, b] of segments)
      sweepPolyline(op, data, gridW, gridH, stockT, [a, b], false, stamp, stepR);
    return;
  }

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
        const nSegs = Math.max(64, Math.ceil((2 * Math.PI * e.radius) / 0.5));
        islands.push(
          Array.from({ length: nSegs }, (_: unknown, i: number) => {
            const a = (i / nSegs) * 2 * Math.PI;
            return {
              x: e.center.x + e.radius * Math.cos(a),
              y: e.center.y + e.radius * Math.sin(a),
            };
          }),
        );
      } else if (e instanceof RectEntity) {
        islands.push([...e.corners()]);
      } else if (e instanceof PolylineEntity && e.closed) {
        islands.push(e.points);
      }
    }
    // Also chain any open curves in the island set into closed polygons.
    const islandCurveEnts = [...islandSet]
      .map((id) => entityMap.get(id))
      .filter((e): e is Entity => !!e && !(e as Entity).isConstruction);
    for (const { verts } of chainOpenCurvesIntoLoops(islandCurveEnts).loops) islands.push(verts);
  }

  // Chain any selected open curves into closed polygons for profile/pocket ops.
  if (op.type === "profile" || op.type === "pocket") {
    const curveEnts = op.entityIds
      .filter((id) => !islandSet.has(id))
      .map((id) => entityMap.get(id))
      .filter((e): e is Entity => !!e && !(e as Entity).isConstruction);
    if (curveEnts.length > 0) {
      const { loops } = chainOpenCurvesIntoLoops(curveEnts);
      for (const { verts, ids } of loops) {
        if (op.type === "pocket")
          rasPocketPolygon(verts, islands, op, data, gridW, gridH, stockT, stamp, stepR);
        else rasProfilePolygon(verts, op, data, gridW, gridH, stockT, stamp, stepR);
        
        for (const id of ids) lineSegIds.add(id);
      }
    }
  }

  for (const id of op.entityIds) {
    if (lineSegIds.has(id) || islandSet.has(id)) continue;
    const ent = entityMap.get(id) as any;
    if (!ent || ent.isConstruction) continue;

    // Expand TextEntity to glyph contours and re-dispatch
    if (ent instanceof TextEntity) {
      if (op.type === "pocket") {
        for (const region of groupContoursIntoRegions(textToContours(ent).map((c) => c.points)))
          rasPocketPolygon(region.outer, [...region.holes, ...islands], op, data, gridW, gridH, stockT, stamp, stepR);
        continue;
      }
      const contours = textToContours(ent);
      for (const c of contours) {
        if (op.type === "engrave")
          sweepPolyline(op, data, gridW, gridH, stockT, c.points, c.closed, stamp, stepR);
        else if (op.type === "profile" && c.closed)
          rasProfilePolygon(c.points, op, data, gridW, gridH, stockT, stamp, stepR);
      }
      continue;
    }

    if (op.type === "drill") {
      if (ent instanceof CircleEntity) {
        const cx = ent.center.x * RES;
        const cy = ent.center.y * RES;
        for (const z of depthPasses(op)) stamp(cx, cy, stockT + z);
      }
    } else if (op.type === "relief-rough") {
      if (ent instanceof RasterImageEntity) rasReliefRough(ent, op, stamp, stockT);
    } else if (op.type === "engrave") {
      if (ent instanceof RasterImageEntity) {
        // Relief needs a depth-shaping bit (matches gcode.ts, which skips others),
        // or a laser which we simulate with a fake depth.
        if (op.toolType === "ball-nose" || op.toolType === "v-bit" || isLaser)
          rasRelief(ent, op, stamp, stockT, isLaser);
      } else if (ent instanceof LineEntity)
        sweepPolyline(op, data, gridW, gridH, stockT, [ent.a, ent.b], false, stamp, stepR);
      else if (ent instanceof CircleEntity)
        sweepCircle(
          op,
          data,
          gridW,
          gridH,
          stockT,
          ent.center.x,
          ent.center.y,
          ent.radius,
          stamp,
          stepR,
        );
      else if (ent instanceof RectEntity)
        sweepPolyline(op, data, gridW, gridH, stockT, [...ent.corners()], true, stamp, stepR);
      else if (ent instanceof PolylineEntity)
        sweepPolyline(op, data, gridW, gridH, stockT, ent.points, ent.closed, stamp, stepR);
      else if (ent instanceof ArcEntity)
        sweepArc(
          op,
          data,
          gridW,
          gridH,
          stockT,
          ent.center.x,
          ent.center.y,
          ent.radius,
          ent.startAngle,
          ent.endAngle,
          stamp,
          stepR,
        );
      else if (ent instanceof BezierEntity)
        sweepPolyline(
          op,
          data,
          gridW,
          gridH,
          stockT,
          flattenBezier(ent.p0, ent.p1, ent.p2, ent.p3, 0.05),
          false,
          stamp,
          stepR,
        );
    } else if (op.type === "pocket") {
      if (ent instanceof CircleEntity)
        rasPocketCircle(
          ent.center.x,
          ent.center.y,
          ent.radius,
          islands,
          op,
          data,
          gridW,
          gridH,
          stockT,
          stamp,
          stepR,
        );
      else if (ent instanceof RectEntity)
        rasPocketPolygon([...ent.corners()], islands, op, data, gridW, gridH, stockT, stamp, stepR);
      else if (ent instanceof PolylineEntity && ent.closed)
        rasPocketPolygon(ent.points, islands, op, data, gridW, gridH, stockT, stamp, stepR);
    } else {
      // profile
      if (ent instanceof CircleEntity)
        rasProfileCircle(
          ent.center.x,
          ent.center.y,
          ent.radius,
          op,
          data,
          gridW,
          gridH,
          stockT,
          stamp,
          stepR,
        );
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
  data: Float32Array,
  gridW: number,
  gridH: number,
  stockT: number,
  offX: number,
  offY: number,
): void {
  if (op.toolType !== "v-bit" || (op.chamferWidth ?? 0) <= 0) return;
  const cop = { ...op, depth: chamferDepth(op) };
  const stamp = makeStampFn(cop, data, gridW, gridH, stockT, false, offX, offY);
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
    for (const p of paths) {
      if (!op.sharpenCorners) {
        sweepPolyline(cop, data, gridW, gridH, stockT, p, true, stamp, stepR);
        continue;
      }
      // Sharpen: walk the tapered sequence, ramping the V-cone up to the surface
      // at each sharp inside corner so it comes to a point.
      const ccw = signedArea(p) >= 0 ? p : [...p].reverse();
      const seq = chamferSharpSequence(ccw, w);
      for (let k = 0; k < seq.length; k++) {
        const a = seq[k],
          b = seq[(k + 1) % seq.length];
        const za = a.lift ? 0 : cop.depth,
          zb = b.lift ? 0 : cop.depth;
        const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * RES));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          stamp(
            (a.x + (b.x - a.x) * t) * RES,
            (a.y + (b.y - a.y) * t) * RES,
            stockT + za + (zb - za) * t,
          );
        }
      }
    }
  };

  const lineSegIds = new Set<string>();
  const curveEnts = op.entityIds
    .map((id) => entityMap.get(id))
    .filter((e): e is Entity => !!e && !(e as Entity).isConstruction);
  const { loops } = chainOpenCurvesIntoLoops(curveEnts);
  for (const { verts, ids } of loops) {
    closed(verts);
    for (const id of ids) lineSegIds.add(id);
  }

  for (const id of op.entityIds) {
    if (lineSegIds.has(id)) continue;
    const ent = entityMap.get(id) as any;
    if (!ent || ent.isConstruction) continue;
    if (ent instanceof TextEntity) {
      for (const c of textToContours(ent)) if (c.closed) closed(c.points);
    } else if (ent instanceof CircleEntity) {
      const r =
        side === "outside"
          ? ent.radius + w
          : side === "inside"
            ? Math.max(0.01, ent.radius - w)
            : ent.radius;
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
      sweepArc(
        cop,
        data,
        gridW,
        gridH,
        stockT,
        ent.center.x,
        ent.center.y,
        ent.radius,
        ent.startAngle,
        ent.endAngle,
        stamp,
        stepR,
      );
    } else if (ent instanceof BezierEntity) {
      sweepPolyline(
        cop,
        data,
        gridW,
        gridH,
        stockT,
        flattenBezier(ent.p0, ent.p1, ent.p2, ent.p3, 0.05),
        false,
        stamp,
        stepR,
      );
    }
  }
}

/**
 * V-carve preview: peel each region into depth passes (same solver the G-code
 * uses) and walk every pass contour with the V-cone stamp at its depth, so the
 * height field shows the tapered, spine-sharpened cut. Resolves geometry the same
 * three ways as the G-code: picked regions, text glyphs, and closed entities.
 */
function rasVcarve(
  op: CAMOperation,
  entityMap: Map<string, unknown>,
  data: Float32Array,
  gridW: number,
  gridH: number,
  stockT: number,
  offX: number,
  offY: number,
): void {
  if (op.toolType !== "v-bit") return;
  const stamp = makeStampFn(op, data, gridW, gridH, stockT, false, offX, offY);
  const stepR = effectiveToolR(op);
  const params = vcarveParamsForOp(op);

  const carve = (region: CarveRegion): void => {
    for (const pass of vcarveRegion(region.outer, region.holes, params)) {
      const depth = stockT + pass.depth;
      for (const loop of pass.loops) {
        const np = loop.length;
        if (np < 2) continue;
        for (let i = 0; i < np; i++) walkSegment(loop[i], loop[(i + 1) % np], stepR, depth, stamp);
      }
    }
  };

  // Picked regions take precedence (they carry counters as holes).
  if (op.regions && op.regions.length > 0) {
    const loops = collectClosedLoops(entityMap.values() as Iterable<Entity>);
    for (const ref of op.regions) {
      const region = resolveRegion(ref, loops);
      if (region) carve({ outer: region.outer, holes: region.holes });
    }
    return;
  }

  const chainedIds = new Set<string>();
  const curveEnts = op.entityIds
    .map((id) => entityMap.get(id))
    .filter((e): e is Entity => !!e && !(e as Entity).isConstruction);
  if (curveEnts.length > 0) {
    const { loops } = chainOpenCurvesIntoLoops(curveEnts);
    for (const { verts, ids } of loops) {
      carve({ outer: verts, holes: [] });
      for (const id of ids) chainedIds.add(id);
    }
  }

  for (const id of op.entityIds) {
    if (chainedIds.has(id)) continue;
    const ent = entityMap.get(id) as any;
    if (!ent || ent.isConstruction) continue;
    if (ent instanceof TextEntity) {
      for (const region of groupContoursIntoRegions(textToContours(ent).map((c) => c.points)))
        carve(region);
    } else if (ent instanceof RectEntity) {
      carve({ outer: [...ent.corners()], holes: [] });
    } else if (ent instanceof PolylineEntity && ent.closed) {
      carve({ outer: ent.points, holes: [] });
    } else if (ent instanceof CircleEntity) {
      const nSegs = Math.max(64, Math.ceil((2 * Math.PI * ent.radius) / 0.5));
      const outer = Array.from({ length: nSegs }, (_, i) => {
        const a = (i / nSegs) * 2 * Math.PI;
        return {
          x: ent.center.x + ent.radius * Math.cos(a),
          y: ent.center.y + ent.radius * Math.sin(a),
        };
      });
      carve({ outer, holes: [] });
    }
  }
}

/**
 * Stamp a greyscale image as a 2.5-D RELIEF into the height field: one tool stamp
 * per dot, lowered to `surface − level·maxDepth` (darker = deeper). Overlapping
 * ball/V stamps form the carved surface — so this previews the real tool ENVELOPE
 * (scallop and all), which the per-dot tip-Z G-code only approximates. Mirrors
 * `reliefImage` in gcode.ts (same rasterField, same level→depth mapping).
 */
function rasRelief(ent: RasterImageEntity, op: CAMOperation, stamp: StampFn, stockT: number, isLaser: boolean = false): void {
  const grid = getImageGrid(ent.imageId);
  if (!grid) return;
  const maxDepth = Math.min(Math.abs(isLaser ? LASER_BURN_DEPTH_MM : op.depth), stockT);
  if (maxDepth <= 0) return;
  const field = rasterField(grid, {
    widthMM: ent.widthMM,
    heightMM: ent.heightMM,
    lineIntervalMM:
      op.rasterLineInterval && op.rasterLineInterval > 0
        ? op.rasterLineInterval
        : DEFAULTS.rasterLineInterval,
    dotPitchMM: op.rasterDotPitch,
    invert: op.rasterInvert,
    gamma: op.reliefGamma,
    // op.rasterDither is intentionally NOT applied here: the 3-D height field is
    // coarser than the dot pitch, and a dither pattern's density-average is the
    // source tone anyway, so this preview shows continuous tone for both greyscale
    // and dithered laser ops. The dot pattern shows in the flat preview + G-code.
    flipX: ent.flipX,
    flipY: ent.flipY,
  });
  // Stamp each dot at its rotated world position so a tilted image previews tilted.
  const xf = makeRasterXf(ent.position, ent.angle);
  for (const row of field.rows) {
    for (let c = 0; c < field.cols; c++) {
      const level = row.levels[c];
      if (level <= 0) continue;
      const w = xfPoint(xf, (c + 0.5) * field.colPitch, row.y);
      stamp(w.x * RES, w.y * RES, stockT - level * maxDepth);
    }
  }
}

/**
 * Preview the RELIEF ROUGHING staircase: each coarse cell is cut to the deepest
 * flat Z-level that clears its material down to `finishZ + allowance`, leaving the
 * allowance for the finish pass. Uses the same coarse field (tool stepover pitch)
 * and level→plane arithmetic as `reliefRoughImage` in gcode.ts, so the preview and
 * the toolpath agree; the (flat) tool stamp gives the flat-bottomed staircase.
 */
function rasReliefRough(
  ent: RasterImageEntity,
  op: CAMOperation,
  stamp: StampFn,
  stockT: number,
): void {
  const grid = getImageGrid(ent.imageId);
  if (!grid) return;
  const maxDepth = Math.min(Math.abs(op.depth), stockT);
  if (maxDepth <= 0) return;
  const allowance = Math.max(0, op.finishAllowance ?? 0);
  const maxCut = maxDepth - allowance; // deepest material roughing removes
  if (maxCut <= 1e-6) return;
  const stepdown = op.stepdown > 0 ? op.stepdown : maxDepth;
  const pitch = Math.max(0.05, (op.stepover > 0 ? op.stepover : DEFAULTS.stepover) * op.diameter);
  const nPasses = Math.max(1, Math.ceil(maxCut / stepdown));
  // The deepest flat plane (matching reliefRoughImage's pass sequence, last plane
  // clamped to −maxCut) that still reaches a cell of the given rough surface.
  const floorZ = (roughSurf: number): number => {
    let z = 0;
    for (let p = 1; p <= nPasses; p++) {
      const zP = Math.max(-p * stepdown, -maxCut);
      if (roughSurf <= zP + 1e-9) z = zP;
    }
    return z; // ≤ 0; 0 = untouched
  };

  const field = rasterField(grid, {
    widthMM: ent.widthMM,
    heightMM: ent.heightMM,
    lineIntervalMM: pitch,
    dotPitchMM: pitch,
    invert: op.rasterInvert,
    gamma: op.reliefGamma,
    flipX: ent.flipX,
    flipY: ent.flipY,
  });
  const xf = makeRasterXf(ent.position, ent.angle);
  for (const row of field.rows) {
    for (let c = 0; c < field.cols; c++) {
      const z = floorZ(Math.min(0, -row.levels[c] * maxDepth + allowance));
      if (z >= 0) continue; // nothing removed here
      const w = xfPoint(xf, (c + 0.5) * field.colPitch, row.y);
      stamp(w.x * RES, w.y * RES, stockT + z);
    }
  }
}

// ---------------------------------------------------------------------------
// Stamp-function factory — returns a closure for the right tool geometry

type StampFn = (cx: number, cy: number, depth: number) => void;

function makeStampFn(
  op: CAMOperation,
  data: Float32Array,
  w: number,
  h: number,
  stockT: number,
  isLaser: boolean = false,
  offX: number = 0,
  offY: number = 0,
): StampFn {
  if (isLaser) {
    // The beam mark must be at least ~1 cell wide, or a swept vector line
    // scatters into disconnected dots: a sub-cell disc (a 0.1 mm dot is ~0.2
    // cells at RES 4) usually covers no integer cell, and none at all when the
    // path runs between two cell rows — the "spotty" preview. Floor the radius
    // at one cell so engraved lines/text render as continuous burns.
    const dotR = Math.max(((op.rasterDotPitch ?? 0.1) / 2) * RES, 1.0);
    // An engrave is a shallow surface scorch, so clamp its depth to the visual
    // burn floor (matches the image path). A cut goes all the way through, so
    // leave it uncapped.
    const floorH = op.type === "engrave" ? stockT - LASER_BURN_DEPTH_MM : -Infinity;
    return (cx, cy, d) => stampDisc(data, w, h, cx - offX, cy - offY, dotR, Math.max(d, floorH));
  }
  const R = op.diameter / 2;
  const Rcell = R * RES;
  const tt = op.toolType ?? "end-mill";

  if (tt === "ball-nose") {
    return (cx, cy, d) => stampBallNose(data, w, h, cx - offX, cy - offY, R, d);
  }
  if (tt === "v-bit") {
    const halfTan = Math.tan(((op.vAngle ?? 60) / 2) * (Math.PI / 180));
    return (cx, cy, d) => stampVCone(data, w, h, cx - offX, cy - offY, halfTan, d, stockT);
  }
  if (tt === "drill") {
    // A drill's point is conical, but only out to the bit's own radius — past
    // that its flutes run a straight cylindrical shank. Clamp the cone's reach
    // to R, or a deep hole with a shallow (wide) tip angle flares out forever:
    // a 12mm-deep hole at the standard 118° point (halfTan ≈ tan59° ≈ 1.66)
    // reaches ~20mm lateral before ever hitting the R clamp, rendering as a
    // crater several times the bit's actual diameter.
    const tipHalfTan = Math.tan(((op.tipAngle ?? 118) / 2) * (Math.PI / 180));
    return (cx, cy, d) => stampVCone(data, w, h, cx - offX, cy - offY, tipHalfTan, d, stockT, R);
  }
  // end-mill (and any unrecognised type): flat disc
  return (cx, cy, d) => stampDisc(data, w, h, cx - offX, cy - offY, Rcell, d);
}

/** Step radius used for spacing stamps along a path sweep. */
function effectiveToolR(op: CAMOperation, isLaser: boolean = false): number {
  // The laser mark is floored at one cell wide (see makeStampFn), so stepping by
  // a fraction of a cell keeps swept lines solid without oversampling far below
  // the grid resolution (the old raw dot-pitch stepped ~10× finer than a cell).
  if (isLaser) return Math.max((op.rasterDotPitch ?? 0.1) / 2, 1 / RES);
  if ((op.toolType ?? "end-mill") === "v-bit") {
    // At max depth the V-bit footprint is this wide; use it for dense-enough stepping.
    return Math.max(0.05, Math.abs(op.depth) * Math.tan(((op.vAngle ?? 60) / 2) * (Math.PI / 180)));
  }
  return op.diameter / 2;
}

// ---------------------------------------------------------------------------
// Stamp primitives

/** Flat-bottomed disc (end mill). */
function stampDisc(
  data: Float32Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  rCell: number,
  depth: number,
): void {
  const x0 = Math.max(0, Math.floor(cx - rCell));
  const x1 = Math.min(w - 1, Math.ceil(cx + rCell));
  const y0 = Math.max(0, Math.floor(cy - rCell));
  const y1 = Math.min(h - 1, Math.ceil(cy + rCell));
  const r2 = rCell * rCell;
  for (let y = y0; y <= y1; y++) {
    const base = y * w;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx,
        dy = y - cy;
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
  data: Float32Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  R_mm: number,
  depth: number,
): void {
  const Rcell = R_mm * RES;
  const R2 = R_mm * R_mm;
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
 *
 * `maxRMM` (default unbounded, for a V-bit whose sides genuinely are the whole
 * profile) clips the cone at a hard radius — a drill passes its own R here, since
 * past the point a real bit runs a straight cylindrical shank rather than an
 * ever-widening cone, and without the clamp a shallow tip angle on a deep hole
 * flares out to many times the bit's actual diameter (see the drill branch of
 * {@link makeStampFn}).
 */
function stampVCone(
  data: Float32Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  halfAngleTan: number,
  depth: number,
  stockT: number,
  maxRMM: number = Infinity,
): void {
  // Maximum lateral reach in mm where the cone still removes material — where it
  // reaches the stock surface, or the caller's hard radius clamp, whichever is
  // tighter.
  const dMaxMM = Math.min((stockT - depth) * halfAngleTan, maxRMM);
  const dMaxCell = dMaxMM * RES;
  const dMax2 = dMaxMM * dMaxMM;
  const x0 = Math.max(0, Math.floor(cx - dMaxCell));
  const x1 = Math.min(w - 1, Math.ceil(cx + dMaxCell));
  const y0 = Math.max(0, Math.floor(cy - dMaxCell));
  const y1 = Math.min(h - 1, Math.ceil(cy + dMaxCell));
  for (let y = y0; y <= y1; y++) {
    const base = y * w;
    for (let x = x0; x <= x1; x++) {
      const dxMM = (x - cx) / RES;
      const dyMM = (y - cy) / RES;
      const d2 = dxMM * dxMM + dyMM * dyMM;
      if (d2 > dMax2) continue;
      const hAt = depth + Math.sqrt(d2) / halfAngleTan;
      if (hAt < data[base + x]) data[base + x] = hAt;
    }
  }
}

// ---------------------------------------------------------------------------
// Walk / sweep helpers

/** Stamp along a segment p0→p1, spaced at half the effective tool radius. */
function walkSegment(p0: Vec2, p1: Vec2, stepR_mm: number, depth: number, stamp: StampFn): void {
  const dx = p1.x - p0.x,
    dy = p1.y - p0.y;
  const lenMM = Math.sqrt(dx * dx + dy * dy);
  if (lenMM < 1e-9) {
    stamp(p0.x * RES, p0.y * RES, depth);
    return;
  }
  const steps = Math.max(1, Math.ceil(lenMM / (stepR_mm * 0.5)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    stamp((p0.x + t * dx) * RES, (p0.y + t * dy) * RES, depth);
  }
}

function sweepPolyline(
  op: CAMOperation,
  _data: Float32Array,
  _gridW: number,
  _gridH: number,
  stockT: number,
  pts: Vec2[],
  closed: boolean,
  stamp: StampFn,
  stepR: number,
): void {
  if (pts.length < 2) return;
  const n = pts.length;
  const segs = closed ? n : n - 1;
  for (const z of depthPasses(op)) {
    const depth = stockT + z;
    for (let i = 0; i < segs; i++) walkSegment(pts[i], pts[(i + 1) % n], stepR, depth, stamp);
  }
}

function sweepCircle(
  op: CAMOperation,
  _data: Float32Array,
  _gridW: number,
  _gridH: number,
  stockT: number,
  cx: number,
  cy: number,
  radius: number,
  stamp: StampFn,
  stepR: number,
): void {
  if (radius <= 0) return;
  const steps = Math.max(32, Math.ceil((2 * Math.PI * radius) / (stepR * 0.5)));
  for (const z of depthPasses(op)) {
    const depth = stockT + z;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * 2 * Math.PI;
      stamp((cx + radius * Math.cos(a)) * RES, (cy + radius * Math.sin(a)) * RES, depth);
    }
  }
}

function sweepArc(
  op: CAMOperation,
  _data: Float32Array,
  _gridW: number,
  _gridH: number,
  stockT: number,
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
  stamp: StampFn,
  stepR: number,
): void {
  if (radius <= 0) return;
  let span = (((endAngle - startAngle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  if (span < 1e-9) span = 2 * Math.PI;
  const steps = Math.max(4, Math.ceil((radius * span) / (stepR * 0.5)));
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
  verts: Vec2[],
  op: CAMOperation,
  _data: Float32Array,
  _gridW: number,
  _gridH: number,
  stockT: number,
  stamp: StampFn,
  stepR: number,
): void {
  const toolR = op.diameter / 2;
  const paths = offsetPolygon(verts, op.side === "outside" ? toolR : -toolR);
  // Mirror the G-code so the preview shows dog-bone corner relief (inside only).
  const dogbone = op.cornerStyle === "dogbone" || op.cornerStyle === "tbone";

  const tabs = op.tabs;
  const tabsBySpacing = tabs?.strategy === "spacing" && (tabs.spacing ?? 0) > 0;
  const hasTabs = !!(
    tabs?.enabled &&
    (tabs.count > 0 || tabsBySpacing) &&
    tabs.width > 0 &&
    tabs.height > 0
  );
  // Match the G-code: tab height is measured from the stock bottom, not the cut
  // floor, so a through-cut's tabs stay in real material. See cam/gcode.ts.
  const tabZOff = hasTabs ? Math.max(op.depth, -stockT) + tabs!.height : 0;

  // Lead-in/out lengths (linear approximation of the cut path — enough to carve
  // the lead grooves into the height field so the preview matches the G-code).
  const liLen = op.leadIn && op.leadIn.type !== "none" ? (op.leadIn.length ?? 2) : 0;
  const loLen = op.leadOut && op.leadOut.type !== "none" ? (op.leadOut.length ?? 2) : 0;

  const useLead = liLen > 0 || loLen > 0;
  const unit = (a: Vec2, b: Vec2): Vec2 => {
    const dx = b.x - a.x,
      dy = b.y - a.y,
      L = Math.hypot(dx, dy) || 1;
    return { x: dx / L, y: dy / L };
  };
  for (const rawPath of paths) {
    if (rawPath.length < 2) continue;
    // Mirror the G-code: dog-bone the wall, then mid-side start only for a lead.
    const dogboneSide = op.type === "profile" && op.side === "outside" ? "outside" : "inside";
    const db = dogbone ? addCornerReliefs(rawPath, toolR, dogboneSide, op.cornerStyle as "dogbone" | "tbone") : rawPath;
    const path = useLead ? startAtLongestEdgeMid(db) : db;
    const np = path.length;

    const tIn = unit(path[0], path[1]); // entry tangent
    const tOut = unit(path[np - 1], path[0]); // exit (arrival) tangent
    const leadInP =
      liLen > 0 ? { x: path[0].x - tIn.x * liLen, y: path[0].y - tIn.y * liLen } : null;
    const leadOutP =
      loLen > 0 ? { x: path[0].x + tOut.x * loLen, y: path[0].y + tOut.y * loLen } : null;

    for (const z of depthPasses(op)) {
      const depth = stockT + z;
      const useTabsThisPass = hasTabs && z < tabZOff;

      if (leadInP) walkSegment(leadInP, path[0], stepR, depth, stamp);

      if (!useTabsThisPass) {
        for (let i = 0; i < np; i++) walkSegment(path[i], path[(i + 1) % np], stepR, depth, stamp);
      } else {
        const tabDepth = stockT + tabZOff;
        const cumLens = pathLengths(path);
        const totalLen = cumLens[path.length];
        const tabN = resolveTabCount(
          totalLen,
          tabs!.count,
          tabsBySpacing ? tabs!.spacing : undefined,
        );
        const regions = computeTabRegions(totalLen, tabN, tabs!.width);
        const segs = splitPathForTabs(path, cumLens, regions);
        for (const seg of segs)
          walkSegment(seg.p0, seg.p1, stepR, seg.isTab ? tabDepth : depth, stamp);
      }

      if (leadOutP) walkSegment(path[0], leadOutP, stepR, depth, stamp);
    }
  }
}

function rasProfileCircle(
  cx: number,
  cy: number,
  r: number,
  op: CAMOperation,
  data: Float32Array,
  gridW: number,
  gridH: number,
  stockT: number,
  stamp: StampFn,
  stepR: number,
): void {
  const toolR = op.diameter / 2;
  const cutR = op.side === "outside" ? r + toolR : r - toolR;
  if (cutR <= 0) return;
  sweepCircle(op, data, gridW, gridH, stockT, cx, cy, cutR, stamp, stepR);
}

function rasPocketPolygon(
  verts: Vec2[],
  islands: Vec2[][],
  op: CAMOperation,
  _data: Float32Array,
  _gridW: number,
  _gridH: number,
  stockT: number,
  stamp: StampFn,
  stepR: number,
): void {
  const toolR = op.diameter / 2;
  const stepover = Math.max(0.01, (op.stepover ?? 0.4) * op.diameter);
  const insets = offsetPolygon(verts, -toolR);
  const islandKeepouts = islands.flatMap((isl) => {
    const pts = signedArea(isl) >= 0 ? isl : [...isl].reverse();
    const expanded = offsetPolygon(pts, toolR);
    return expanded.length > 0 ? expanded : [pts];
  });
  for (const inset of insets) {
    if (inset.length < 2) continue;
    const rows =
      islandKeepouts.length > 0
        ? rasterRowsWithIslands(inset, islandKeepouts, stepover)
        : rasterRows(inset, stepover);
    for (const z of depthPasses(op)) {
      const depth = stockT + z;
      for (const row of rows)
        for (let i = 0; i + 1 < row.length; i += 2)
          walkSegment(row[i], row[i + 1], stepR, depth, stamp);
      // Sweep outer inset boundary (finish pass), with dog-bone relief when set —
      // matching the G-code's wall lap. The interior clearing rows stay plain.
      const dogboneSide = op.type === "profile" && op.side === "outside" ? "outside" : "inside";
      const wall =
        op.cornerStyle === "dogbone" || op.cornerStyle === "tbone"
          ? addCornerReliefs(inset, toolR, dogboneSide, op.cornerStyle as "dogbone" | "tbone")
          : inset;
      const np = wall.length;
      for (let i = 0; i < np; i++) walkSegment(wall[i], wall[(i + 1) % np], stepR, depth, stamp);
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
  cx: number,
  cy: number,
  r: number,
  islands: Vec2[][],
  op: CAMOperation,
  data: Float32Array,
  gridW: number,
  gridH: number,
  stockT: number,
  stamp: StampFn,
  stepR: number,
): void {
  const toolR = op.diameter / 2;
  if (islands.length > 0) {
    const nSegs = Math.max(64, Math.ceil((2 * Math.PI * r) / 0.5));
    const verts: Vec2[] = Array.from({ length: nSegs }, (_, i) => {
      const a = (i / nSegs) * 2 * Math.PI;
      return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
    });
    rasPocketPolygon(verts, islands, op, data, gridW, gridH, stockT, stamp, stepR);
    return;
  }
  const cutR = r - toolR;
  if (cutR <= 0) return;
  const nSegs = Math.max(64, Math.ceil((2 * Math.PI * cutR) / 0.5));
  const verts: Vec2[] = Array.from({ length: nSegs }, (_, i) => {
    const a = (i / nSegs) * 2 * Math.PI;
    return { x: cx + cutR * Math.cos(a), y: cy + cutR * Math.sin(a) };
  });
  rasPocketPolygon(verts, [], op, data, gridW, gridH, stockT, stamp, stepR);
}
