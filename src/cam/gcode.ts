import type { Vec2 } from "../core/vec2";
import { type CADDocument, resolveOrigin } from "../model/document";
import { LineEntity, CircleEntity, RectEntity, PolylineEntity, BezierEntity, TextEntity, ArcEntity } from "../model/entities";
import { textToContours } from "./textOutlines";
import { type CAMOperation, type CoolantMode, chamferDepth, chamferSharpSequence, resolveOpTool } from "./types";
import { offsetPolygon, signedArea, startAtLongestEdgeMid } from "./offset";
import { contourParallelClear } from "./clearing";
import { n, X, Y, Z, depthPasses, PostProcessor } from "./postprocessors/base";
import { pathLengths, computeTabRegions, splitPathForTabs } from "./tabs";
import { rasterRows, rasterRowsWithIslands } from "./pocket";
import { chainLinesIntoPolygons, collectClosedLoops } from "./loops";
import { resolveRegion } from "./regions";
import { LinuxCNC } from "./postprocessors/linuxcnc";
import { Grbl } from "./postprocessors/grbl";

export function getPostProcessor(name: string): PostProcessor {
  switch (name) {
    case "grbl":     return new Grbl();
    default:         return new LinuxCNC();
  }
}

// --- profile -----------------------------------------------------------------

/** Compute normalised entry/exit tangent and optional lead geometry for a closed path. */
function leadInGeo(path: Vec2[], leadR: number, side: "outside" | "inside") {
  const t1 = path[1], t0 = path[0], tn = path[path.length - 1];
  const dx  = t1.x - t0.x, dy  = t1.y - t0.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-9) return null;
  const tx = dx / len, ty = dy / len;
  // Left normal for outside (CW), right normal for inside (CCW).
  const sg  = side === "outside" ? 1 : -1;
  const nx  = -ty * sg, ny = tx * sg;
  // Entry arc start point
  const arcStart: Vec2 = { x: t0.x + nx * leadR - tx * leadR, y: t0.y + ny * leadR - ty * leadR };
  // Exit tangent (direction arriving at path[0] from the last move)
  const ex = t0.x - tn.x, ey = t0.y - tn.y;
  const el = Math.sqrt(ex * ex + ey * ey);
  const etx = el > 1e-9 ? ex / el : tx, ety = el > 1e-9 ? ey / el : ty;
  const enx = -ety * sg, eny = etx * sg;
  const arcOut: Vec2 = { x: t0.x + enx * leadR + etx * leadR, y: t0.y + eny * leadR + ety * leadR };
  const arcCmd = side === "outside" ? "G3" : "G2";
  return { tx, ty, nx, ny, arcStart, arcCmd, etx, ety, enx, eny, arcOut };
}

/** Default radial finishing allowance (mm) when finishPass is on without an explicit value. */
const FINISH_ALLOWANCE_DEFAULT = 0.2;

/**
 * Effective finishing allowance for an op: 0 when off, otherwise the requested
 * value clamped below the tool radius so the finish lap still plunges through
 * already-cleared stock (its centre stays inside the rough kerf).
 */
function finishAllowance(op: CAMOperation): number {
  if (!op.finishPass) return 0;
  const a = op.finishAllowance ?? FINISH_ALLOWANCE_DEFAULT;
  return Math.max(0, Math.min(a, (op.diameter / 2) * 0.8));
}

function profilePolygon(
  verts: Vec2[], op: CAMOperation,
  ox: number, oy: number, zOff: number,
): string[] {
  const toolR = op.diameter / 2;
  // Normalise winding to CCW so "outside" (+toolR) always expands and "inside"
  // (-toolR) always shrinks, regardless of how the source geometry was wound.
  const ccw = signedArea(verts) >= 0 ? verts : [...verts].reverse();
  const sideSign = op.side === "outside" ? 1 : -1;

  // Roughing leaves `allowance` of stock on the wall; the finishing lap then cuts
  // at the true offset to remove it. With no allowance the finish lap coincides
  // with roughing — a spring pass.
  const allowance   = finishAllowance(op);
  const roughPaths  = offsetPolygon(ccw, sideSign * (toolR + allowance));
  if (roughPaths.length === 0) return [];
  const finishPaths = op.finishPass
    ? (allowance > 0 ? offsetPolygon(ccw, sideSign * toolR) : roughPaths)
    : [];

  const tabs      = op.tabs;
  const hasTabs   = !!(tabs?.enabled && tabs.count > 0 && tabs.width > 0 && tabs.height > 0);
  const tabZOff   = hasTabs ? op.depth + tabs!.height : 0;

  const liType = op.leadIn?.type  ?? "none";
  const loType = op.leadOut?.type ?? "none";
  const liLen  = op.leadIn?.length  ?? 2;
  const loLen  = op.leadOut?.length ?? 2;
  const useLead = liType !== "none" || loType !== "none";

  const lines: string[] = [];

  // Trace one closed lap of `path` at depth `z` (approach/plunge, body with
  // optional tabs, lead-out).
  const tracePass = (path: Vec2[], z: number): void => {
    const s = path[0];
    const geo = useLead ? leadInGeo(path, Math.max(liLen, loLen), op.side) : null;
    const useTabsThisPass = hasTabs && z < tabZOff;

    if (liType === "none" || !geo) {
      lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
      lines.push(`G0 X${X(s.x, ox)} Y${Y(s.y, oy)}`);
      lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
    } else if (liType === "linear") {
      const { tx, ty } = geo;
      const lx = s.x - tx * liLen, ly = s.y - ty * liLen;
      lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
      lines.push(`G0 X${X(lx, ox)} Y${Y(ly, oy)}`);
      lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
      lines.push(`G1 X${X(s.x, ox)} Y${Y(s.y, oy)} F${n(op.feedrate)}`);
    } else { // arc
      const { arcStart, arcCmd, tx, ty } = leadInGeo(path, liLen, op.side)!;
      lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
      lines.push(`G0 X${X(arcStart.x, ox)} Y${Y(arcStart.y, oy)}`);
      lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
      lines.push(`${arcCmd} X${X(s.x, ox)} Y${Y(s.y, oy)} I${n(tx * liLen)} J${n(ty * liLen)} F${n(op.feedrate)}`);
    }

    if (!useTabsThisPass) {
      for (let i = 1; i < path.length; i++) {
        const f = (i === 1 && liType === "none") ? ` F${n(op.feedrate)}` : "";
        lines.push(`G1 X${X(path[i].x, ox)} Y${Y(path[i].y, oy)}${f}`);
      }
      lines.push(`G1 X${X(s.x, ox)} Y${Y(s.y, oy)}`);
    } else {
      const cumLens  = pathLengths(path);
      const totalLen = cumLens[path.length];
      const regions  = computeTabRegions(totalLen, tabs!.count, tabs!.width);
      const segs     = splitPathForTabs(path, cumLens, regions);

      let currentZ = z;
      let first    = liType === "none";
      for (const seg of segs) {
        const targetZ = seg.isTab ? tabZOff : z;
        if (targetZ !== currentZ) {
          lines.push(`G1 Z${Z(targetZ, zOff)} F${n(op.plungeRate)}`);
          currentZ = targetZ;
        }
        const feedStr = first ? ` F${n(op.feedrate)}` : "";
        lines.push(`G1 X${X(seg.p1.x, ox)} Y${Y(seg.p1.y, oy)}${feedStr}`);
        first = false;
      }
      if (currentZ !== z) lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
    }

    if (loType === "linear" && geo) {
      const { etx, ety } = geo;
      lines.push(`G1 X${X(s.x + etx * loLen, ox)} Y${Y(s.y + ety * loLen, oy)}`);
    } else if (loType === "arc" && geo) {
      const loGeo = leadInGeo(path, loLen, op.side)!;
      lines.push(`${loGeo.arcCmd} X${X(loGeo.arcOut.x, ox)} Y${Y(loGeo.arcOut.y, oy)} I${n(loGeo.enx * loLen)} J${n(loGeo.eny * loLen)}`);
    }
  };

  // Anchor the lead/plunge mid-edge only when a lead is used (otherwise leave the
  // start at the natural corner — no silent change to plain profiles).
  const prep = (raw: Vec2[]): Vec2[] => (useLead ? startAtLongestEdgeMid(raw) : raw);

  for (const rawPath of roughPaths) {
    if (rawPath.length < 2) continue;
    const path = prep(rawPath);
    for (const z of depthPasses(op)) tracePass(path, z);
  }
  // Finishing lap at the true wall, full depth (its centre sits in the rough
  // kerf, so the plunge enters cleared stock).
  for (const rawPath of finishPaths) {
    if (rawPath.length < 2) continue;
    tracePass(prep(rawPath), op.depth);
  }

  lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
  return lines;
}

// --- pocket ------------------------------------------------------------------

/** Ramp-entry geometry: descend at this angle off horizontal (gentle on the cutter). */
const RAMP_ANGLE_DEG = 3;
/** Rapid down to this clearance (mm) above the previous cut level before feeding. */
const RAMP_CLEAR = 0.5;

/**
 * Emit a ramped plunge from `zStart` down to `zTarget` by zig-zagging along the
 * segment a↔b, instead of a straight vertical plunge (which loads the tool tip
 * and snaps cutters in metal/hardwood). The tool rapids to a clearance plane
 * above the already-cleared `zStart` level, then descends at RAMP_ANGLE_DEG.
 * Guarantees the final position is `b` at `zTarget` with the full a→b interval
 * cut at depth. Falls back to a straight plunge for degenerate segments.
 */
function rampPlunge(
  a: Vec2, b: Vec2, zStart: number, zTarget: number, op: CAMOperation,
  ox: number, oy: number, zOff: number,
): string[] {
  const out: string[] = [];
  out.push(`G0 Z${Z(op.safeZ, zOff)}`);
  out.push(`G0 X${X(a.x, ox)} Y${Y(a.y, oy)}`);
  out.push(`G0 Z${Z(zStart + RAMP_CLEAR, zOff)}`); // rapid into cleared air above last level

  const segLen = Math.hypot(b.x - a.x, b.y - a.y);
  const depth  = zStart - zTarget; // positive: how far we still need to descend
  if (segLen < 1e-6 || depth < 1e-9) {
    out.push(`G1 Z${Z(zTarget, zOff)} F${n(op.plungeRate)}`);
    if (segLen >= 1e-6) out.push(`G1 X${X(b.x, ox)} Y${Y(b.y, oy)} F${n(op.feedrate)}`);
    return out;
  }

  out.push(`G1 Z${Z(zStart, zOff)} F${n(op.plungeRate)}`); // feed down to the cut level
  const run = depth / Math.tan((RAMP_ANGLE_DEG * Math.PI) / 180); // horizontal travel needed

  let dist = 0;
  let cur = a, target = b;
  while (dist < run - 1e-9) {
    const remaining = run - dist;
    if (segLen <= remaining) {
      dist += segLen;
      const z = zStart - depth * Math.min(1, dist / run);
      out.push(`G1 X${X(target.x, ox)} Y${Y(target.y, oy)} Z${Z(z, zOff)} F${n(op.feedrate)}`);
      [cur, target] = [target, cur];
    } else {
      const t = remaining / segLen;
      const px = cur.x + (target.x - cur.x) * t;
      const py = cur.y + (target.y - cur.y) * t;
      out.push(`G1 X${X(px, ox)} Y${Y(py, oy)} Z${Z(zTarget, zOff)} F${n(op.feedrate)}`);
      cur = { x: px, y: py };
      dist = run;
    }
  }
  // Level pass at full depth so the whole a→b interval is cut and we end at b.
  out.push(`G1 X${X(a.x, ox)} Y${Y(a.y, oy)} F${n(op.feedrate)}`);
  out.push(`G1 X${X(b.x, ox)} Y${Y(b.y, oy)}`);
  return out;
}

/** Max helix angle (off horizontal) for a contour-parallel loop entry. */
const HELIX_ANGLE_MAX_DEG = 10;

/**
 * Cut a closed loop with a helical entry: descend from `zStart` to `z` while
 * spiralling around the loop (one or more laps, kept under HELIX_ANGLE_MAX_DEG),
 * then one flat finishing lap so the floor is level. Always ends back at loop[0].
 * Much gentler than a vertical plunge and avoids the oscillation of ramping along
 * a single short edge.
 */
function helicalLoop(
  loop: Vec2[], zStart: number, z: number, op: CAMOperation,
  ox: number, oy: number, zOff: number,
): string[] {
  const out: string[] = [];
  const N = loop.length;
  out.push(`G0 Z${Z(op.safeZ, zOff)}`);
  out.push(`G0 X${X(loop[0].x, ox)} Y${Y(loop[0].y, oy)}`);
  out.push(`G0 Z${Z(zStart + RAMP_CLEAR, zOff)}`);
  out.push(`G1 Z${Z(zStart, zOff)} F${n(op.plungeRate)}`);

  const seg: number[] = [];
  let perim = 0;
  for (let i = 0; i < N; i++) {
    const a = loop[i], b = loop[(i + 1) % N];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    seg.push(L); perim += L;
  }
  const depth = zStart - z;
  if (perim < 1e-9 || depth < 1e-9) {
    out.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
    for (let i = 1; i <= N; i++)
      out.push(`G1 X${X(loop[i % N].x, ox)} Y${Y(loop[i % N].y, oy)}${i === 1 ? ` F${n(op.feedrate)}` : ""}`);
    return out;
  }

  const nLaps = Math.max(1, Math.ceil(depth / (perim * Math.tan((HELIX_ANGLE_MAX_DEG * Math.PI) / 180))));
  const totalArc = nLaps * perim;
  let acc = 0, first = true;
  for (let lap = 0; lap < nLaps; lap++) {
    for (let i = 1; i <= N; i++) {
      acc += seg[(i - 1) % N];
      const zc = zStart - depth * Math.min(1, acc / totalArc);
      const p = loop[i % N];
      out.push(`G1 X${X(p.x, ox)} Y${Y(p.y, oy)} Z${Z(zc, zOff)}${first ? ` F${n(op.feedrate)}` : ""}`);
      first = false;
    }
  }
  // Flat finishing lap at full depth (ends at loop[0]).
  for (let i = 1; i <= N; i++)
    out.push(`G1 X${X(loop[i % N].x, ox)} Y${Y(loop[i % N].y, oy)}`);
  return out;
}

/** Profile a closed contour at a fixed depth, entering with a ramp along its first edge. */
function finishContour(
  poly: Vec2[], zStart: number, z: number, op: CAMOperation,
  ox: number, oy: number, zOff: number,
): string[] {
  if (poly.length < 3) return [];
  const out = rampPlunge(poly[0], poly[1], zStart, z, op, ox, oy, zOff); // ends at poly[1] @ z
  for (let i = 2; i < poly.length; i++)
    out.push(`G1 X${X(poly[i].x, ox)} Y${Y(poly[i].y, oy)}`);
  out.push(`G1 X${X(poly[0].x, ox)} Y${Y(poly[0].y, oy)}`);
  return out;
}

/** Dispatch to the configured pocket clearing strategy (default: contour-parallel). */
function pocketPolygon(
  verts: Vec2[], islands: Vec2[][], op: CAMOperation,
  ox: number, oy: number, zOff: number,
): string[] {
  const clear = (v: Vec2[], isl: Vec2[][]): string[] =>
    (op.pocketStrategy ?? "offset") === "raster"
      ? pocketPolygonRaster(v, isl, op, ox, oy, zOff)
      : pocketPolygonOffset(v, isl, op, ox, oy, zOff);

  const allowance = finishAllowance(op);
  const lines: string[] = [];
  if (allowance > 0) {
    // Shrink the region (and grow islands) by the allowance so clearing leaves a
    // skin on the true walls, which the finishing lap then removes.
    const ccw = signedArea(verts) >= 0 ? verts : [...verts].reverse();
    const innerRegions = offsetPolygon(ccw, -allowance);
    const grownIslands = islands.flatMap((isl) => {
      const p = signedArea(isl) >= 0 ? isl : [...isl].reverse();
      const ex = offsetPolygon(p, allowance);
      return ex.length ? ex : [p];
    });
    for (const region of innerRegions) lines.push(...clear(region, grownIslands));
  } else {
    lines.push(...clear(verts, islands));
  }

  // Only add a finishing wall lap if clearing actually cut something — a pocket
  // too small for the tool emits just a `; NOTE:` and has no wall to finish.
  const cleared = lines.some((l) => /^G[0-3]\b/.test(l));
  if (op.finishPass && cleared) lines.push(...pocketWallFinish(verts, islands, op, ox, oy, zOff));
  return lines;
}

/**
 * Final full-depth finishing lap around a pocket's walls (boundary + island
 * walls), to clean the ridges left by stepdown roughing. Independent of the
 * clearing strategy.
 */
function pocketWallFinish(
  verts: Vec2[], islands: Vec2[][], op: CAMOperation,
  ox: number, oy: number, zOff: number,
): string[] {
  const toolR = op.diameter / 2;
  const ccw = signedArea(verts) >= 0 ? verts : [...verts].reverse();
  const walls = offsetPolygon(ccw, -toolR);
  if (walls.length === 0) return [];

  const lines: string[] = [`; finishing pass (full-depth wall) Z${n(op.depth)}`];
  for (const w of walls)
    lines.push(...finishContour(w, op.depth, op.depth, op, ox, oy, zOff));
  for (const isl of islands) {
    const pts = signedArea(isl) >= 0 ? isl : [...isl].reverse();
    for (const k of offsetPolygon(pts, toolR))
      lines.push(...finishContour(k, op.depth, op.depth, op, ox, oy, zOff));
  }
  lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
  return lines;
}

/**
 * Contour-parallel clearing: concentric offset loops that wrap islands without
 * lifting. Each depth level is cleared completely (innermost loop → outer wall)
 * before descending; loops link with short feed moves where the gap is already
 * cut, otherwise the tool lifts and ramps back in.
 */
function pocketPolygonOffset(
  verts: Vec2[], islands: Vec2[][], op: CAMOperation,
  ox: number, oy: number, zOff: number,
): string[] {
  const toolR    = op.diameter / 2;
  const stepover = Math.max(0.01, (op.stepover ?? 0.4) * op.diameter);
  const moves    = contourParallelClear(verts, islands, toolR, stepover);
  if (moves.length === 0)
    return [`; NOTE: pocket too small for ⌀${op.diameter}mm tool — skipped`];

  const lines: string[] = [];
  let prevZ = 0; // top of stock (work surface)
  for (const z of depthPasses(op)) {
    lines.push(`; clearing pass Z${n(z)} (contour-parallel, ${moves.length} loops)`);
    let entered = false;
    for (const mv of moves) {
      const loop = mv.loop;
      if (loop.length < 3) continue;
      if (entered && mv.link) {
        // Safe feed-link straight into this loop (gap already cleared), trace at depth.
        for (let i = 0; i < loop.length; i++)
          lines.push(`G1 X${X(loop[i].x, ox)} Y${Y(loop[i].y, oy)}`);
        lines.push(`G1 X${X(loop[0].x, ox)} Y${Y(loop[0].y, oy)}`);
      } else {
        // First loop of the pass, or a gap too wide to feed across: helix in.
        lines.push(...helicalLoop(loop, prevZ, z, op, ox, oy, zOff));
        entered = true;
      }
    }
    lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
    prevZ = z;
  }
  return lines;
}

function pocketPolygonRaster(
  verts: Vec2[], islands: Vec2[][], op: CAMOperation,
  ox: number, oy: number, zOff: number,
): string[] {
  const toolR    = op.diameter / 2;
  const stepover = Math.max(0.01, (op.stepover ?? 0.4) * op.diameter);
  // Normalise winding to CCW so the inward (-toolR) inset always shrinks the
  // boundary, regardless of the source geometry's winding direction.
  const ccw      = signedArea(verts) >= 0 ? verts : [...verts].reverse();
  const insets   = offsetPolygon(ccw, -toolR);
  if (insets.length === 0)
    return [`; NOTE: pocket too small for ⌀${op.diameter}mm tool — skipped`];

  // Expand each island outward by toolR to create keepout zones.
  // If the offset returns empty (degenerate case), fall back to the raw polygon.
  const islandKeepouts = islands.flatMap(isl => {
    const pts = signedArea(isl) >= 0 ? isl : [...isl].reverse();
    const expanded = offsetPolygon(pts, toolR);
    return expanded.length > 0 ? expanded : [pts];
  });

  const lines: string[] = [];

  for (const inset of insets) {
    const rows = islandKeepouts.length > 0
      ? rasterRowsWithIslands(inset, islandKeepouts, stepover)
      : rasterRows(inset, stepover);
    if (rows.length === 0 && islandKeepouts.length === 0) continue;

    // Cut each depth level COMPLETELY (rough rows → finish walls) before
    // descending. The previous code roughed all depths then finished all
    // depths, which retracted and re-cut shallow walls after deep roughing.
    let prevZ = 0; // top of stock (work surface)
    for (const z of depthPasses(op)) {
      if (rows.length > 0) {
        lines.push(`; clearing pass Z${n(z)}`);
        // Each row contains 2*k points representing k intervals (one pair per interval).
        // Consecutive rows connect via zig-zag G1 (safe: along outer boundary).
        // Multiple intervals within the same row require a lift/rapid between them
        // to avoid cutting through the island.
        let entered = false;
        for (const row of rows) {
          for (let i = 0; i + 1 < row.length; i += 2) {
            const a = row[i], b = row[i + 1];
            if (!entered) {
              lines.push(...rampPlunge(a, b, prevZ, z, op, ox, oy, zOff));
              entered = true;
            } else if (i === 0) {
              // First interval of a new row — zig-zag connection along outer boundary (safe).
              lines.push(`G1 X${X(a.x, ox)} Y${Y(a.y, oy)}`);
              lines.push(`G1 X${X(b.x, ox)} Y${Y(b.y, oy)}`);
            } else {
              // Additional interval within same row — lift over island, ramp back in.
              lines.push(...rampPlunge(a, b, prevZ, z, op, ox, oy, zOff));
            }
          }
        }
      }

      // Finish the outer wall, then each island wall, at this same depth.
      lines.push(`; finishing walls Z${n(z)}`);
      lines.push(...finishContour(inset, prevZ, z, op, ox, oy, zOff));
      for (const keepout of islandKeepouts)
        lines.push(...finishContour(keepout, prevZ, z, op, ox, oy, zOff));

      prevZ = z;
    }

    lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
  }

  return lines;
}

/**
 * Helically bore a circle of radius `rad` about (cx,cy) from `zStart` down to
 * `zTarget` using G2 + Z (real helical interpolation), one revolution per turn
 * kept under HELIX_ANGLE_MAX_DEG, then one flat lap to level the floor. Leaves
 * the tool at (cx+rad, cy, zTarget).
 */
function helicalBore(
  cx: number, cy: number, rad: number, zStart: number, zTarget: number,
  op: CAMOperation, ox: number, oy: number, zOff: number,
): string[] {
  const sx = cx + rad;
  const out: string[] = [
    `G0 Z${Z(op.safeZ, zOff)}`,
    `G0 X${X(sx, ox)} Y${Y(cy, oy)}`,
    `G0 Z${Z(zStart + RAMP_CLEAR, zOff)}`,
    `G1 Z${Z(zStart, zOff)} F${n(op.plungeRate)}`,
  ];
  const depth = zStart - zTarget;
  const turns = depth < 1e-9 ? 0
    : Math.max(1, Math.ceil(depth / (2 * Math.PI * rad * Math.tan((HELIX_ANGLE_MAX_DEG * Math.PI) / 180))));
  for (let i = 1; i <= turns; i++) {
    const zc = zStart - depth * (i / turns);
    out.push(`G2 X${X(sx, ox)} Y${Y(cy, oy)} I${n(-rad)} J0 Z${Z(zc, zOff)} F${n(op.feedrate)}`);
  }
  out.push(`G2 X${X(sx, ox)} Y${Y(cy, oy)} I${n(-rad)} J0 F${n(op.feedrate)}`); // flat floor lap
  return out;
}

function pocketCircle(
  cx: number, cy: number, r: number, islands: Vec2[][], op: CAMOperation,
  ox: number, oy: number, zOff: number,
): string[] {
  // Islands make smooth concentric arcs impossible — fall back to the general
  // polygon clearer (tessellated), which handles arbitrary islands.
  if (islands.length > 0) {
    const nSegs = Math.max(64, Math.ceil((2 * Math.PI * r) / 0.5));
    const verts: Vec2[] = Array.from({ length: nSegs }, (_, i) => {
      const a = (i / nSegs) * 2 * Math.PI;
      return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
    });
    return pocketPolygon(verts, islands, op, ox, oy, zOff);
  }

  const toolR = op.diameter / 2;
  const cutR  = r - toolR;
  if (cutR <= 0)
    return [`; NOTE: pocket circle too small for ⌀${op.diameter}mm tool — skipped`];

  const so        = Math.max(0.01, (op.stepover ?? 0.4) * op.diameter);
  const allowance = finishAllowance(op);
  // Rough out to the wall less the allowance; the finishing lap takes the wall.
  const roughR    = allowance > 0 ? Math.max(0.01, cutR - allowance) : cutR;
  // Helix radius small enough that the tool covers the centre (≤ toolR).
  const helixR    = Math.min(roughR, toolR * 0.9);

  // Concentric tool-centre radii: helixR, helixR+so, … up to roughR.
  const radii: number[] = [];
  for (let rr = helixR; rr < roughR - 1e-6; rr += so) radii.push(rr);
  radii.push(roughR);

  const lines: string[] = [];
  let prevZ = 0;
  for (const z of depthPasses(op)) {
    lines.push(...helicalBore(cx, cy, helixR, prevZ, z, op, ox, oy, zOff));
    // Clear outward with concentric full circles at this depth.
    for (const rr of radii) {
      lines.push(`G1 X${X(cx + rr, ox)} Y${Y(cy, oy)} F${n(op.feedrate)}`);   // step out
      lines.push(`G2 X${X(cx + rr, ox)} Y${Y(cy, oy)} I${n(-rr)} J0 F${n(op.feedrate)}`);
    }
    lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
    prevZ = z;
  }

  // Finishing lap: a smooth full-depth wall circle at the true radius.
  if (op.finishPass) {
    const sx = cx + cutR;
    lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
    lines.push(`G0 X${X(sx, ox)} Y${Y(cy, oy)}`);
    lines.push(`G1 Z${Z(op.depth, zOff)} F${n(op.plungeRate)}`);
    lines.push(`G2 X${X(sx, ox)} Y${Y(cy, oy)} I${n(-cutR)} J0 F${n(op.feedrate)}`);
    lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
  }

  return lines;
}

function profileCircle(
  cx: number, cy: number, r: number, op: CAMOperation,
  ox: number, oy: number, zOff: number,
): string[] {
  const toolR = op.diameter / 2;
  const cutR = op.side === "outside" ? r + toolR : r - toolR;
  if (cutR <= 0)
    return [`; WARNING: tool ⌀${op.diameter}mm too large for inside circle r=${r}mm — skipped`];

  // Roughing leaves `allowance` on the wall; the finishing lap cuts at the true
  // radius. (Spring pass when allowance is 0.)
  const allowance = finishAllowance(op);
  let cutRrough = op.side === "outside" ? cutR + allowance : cutR - allowance;
  if (cutRrough <= 0) cutRrough = cutR; // too small to leave a skin

  const lines: string[] = [];
  const circleAt = (radius: number, z: number): void => {
    const sx = cx + radius;
    lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
    lines.push(`G0 X${X(sx, ox)} Y${Y(cy, oy)}`);
    lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
    lines.push(`G2 X${X(sx, ox)} Y${Y(cy, oy)} I${n(-radius)} J0 F${n(op.feedrate)}`);
  };
  for (const z of depthPasses(op)) circleAt(cutRrough, z);
  if (op.finishPass) circleAt(cutR, op.depth);
  lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
  return lines;
}

// --- engrave -----------------------------------------------------------------

function engravePoints(
  pts: Vec2[], closed: boolean, op: CAMOperation,
  ox: number, oy: number, zOff: number,
): string[] {
  if (pts.length === 0) return [];
  const lines: string[] = [];
  const s = pts[0];
  for (const z of depthPasses(op)) {
    lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
    lines.push(`G0 X${X(s.x, ox)} Y${Y(s.y, oy)}`);
    lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
    for (let i = 1; i < pts.length; i++) {
      const f = i === 1 ? ` F${n(op.feedrate)}` : "";
      lines.push(`G1 X${X(pts[i].x, ox)} Y${Y(pts[i].y, oy)}${f}`);
    }
    if (closed && pts.length > 2) lines.push(`G1 X${X(s.x, ox)} Y${Y(s.y, oy)}`);
  }
  lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
  return lines;
}

function engraveCircle(
  cx: number, cy: number, r: number, op: CAMOperation,
  ox: number, oy: number, zOff: number,
): string[] {
  const lines: string[] = [];
  const sx = cx + r;
  for (const z of depthPasses(op)) {
    lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
    lines.push(`G0 X${X(sx, ox)} Y${Y(cy, oy)}`);
    lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
    lines.push(`G2 X${X(sx, ox)} Y${Y(cy, oy)} I${n(-r)} J0 F${n(op.feedrate)}`);
  }
  lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
  return lines;
}

/**
 * Engrave a circular arc on its own centreline (no tool-radius compensation).
 * Arcs are stored CCW from startAngle→endAngle (world Y-up), which maps to a
 * G3 (counter-clockwise) move in the G17 plane. I/J are the centre offset
 * relative to the arc start point.
 */
function engraveArc(
  arc: ArcEntity, op: CAMOperation,
  ox: number, oy: number, zOff: number,
): string[] {
  const span = ((arc.endAngle - arc.startAngle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  if (span < 1e-6) return [`; NOTE: arc (${arc.id}) has zero sweep — skipped`];
  const s = arc.startPoint;
  const e = arc.endPoint;
  const iOff = arc.center.x - s.x;
  const jOff = arc.center.y - s.y;
  const lines: string[] = [];
  for (const z of depthPasses(op)) {
    lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
    lines.push(`G0 X${X(s.x, ox)} Y${Y(s.y, oy)}`);
    lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
    lines.push(`G3 X${X(e.x, ox)} Y${Y(e.y, oy)} I${n(iOff)} J${n(jOff)} F${n(op.feedrate)}`);
  }
  lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
  return lines;
}

// --- drill -------------------------------------------------------------------

/** Re-entry clearance above the previous peck bottom before feeding again, mm. */
const PECK_CLEAR = 0.5;

// Drill one hole. The tool is assumed already at safe Z (the caller emits a
// single retract before the first hole), so we don't re-retract on entry — that
// produced a redundant duplicate `G0 Z<safe>` between holes. With a peck depth
// the hole is cut in increments, fully retracting to safe Z between pecks to
// clear chips (G83-style); otherwise it's a single full-depth plunge.
function drillPoint(
  cx: number, cy: number, op: CAMOperation,
  ox: number, oy: number, zOff: number,
): string[] {
  const lines = [`G0 X${X(cx, ox)} Y${Y(cy, oy)}`];
  const peck = op.peckDepth ?? 0;

  if (peck <= 0 || peck >= Math.abs(op.depth)) {
    // Single plunge to full depth.
    lines.push(`G1 Z${Z(op.depth, zOff)} F${n(op.plungeRate)}`);
    lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
    return lines;
  }

  // Peck: feed one increment, full-retract to safe Z to clear chips, rapid back
  // to just above the last bottom, repeat until full depth.
  let z = 0; // current bottom (descends toward op.depth, which is negative)
  let first = true;
  while (z > op.depth + 1e-9) {
    const next = Math.max(op.depth, z - peck);
    if (!first) lines.push(`G0 Z${Z(z + PECK_CLEAR, zOff)}`);
    lines.push(`G1 Z${Z(next, zOff)} F${n(op.plungeRate)}`);
    lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
    z = next;
    first = false;
  }
  return lines;
}

// --- chamfer (V-bevel along an edge) -----------------------------------------

/** Offset a closed chamfer contour per `chamferSide` ("on" = centred, no offset). */
function chamferOffsets(verts: Vec2[], op: CAMOperation): Vec2[][] {
  const side = op.chamferSide ?? "on";
  if (side === "on") return [verts];
  const ccw = signedArea(verts) >= 0 ? verts : [...verts].reverse();
  const d = side === "outside" ? (op.chamferWidth ?? 0) : -(op.chamferWidth ?? 0);
  const offs = offsetPolygon(ccw, d);
  return offs.length ? offs : [verts];
}

/**
 * Trace a closed contour at the derived depth, but taper the bevel to the surface
 * at each sharp inside corner — the V-bit tip is pulled up into the corner so the
 * two bevel faces meet at a crisp point instead of a rounded fillet.
 */
function chamferContourSharp(
  verts: Vec2[], op: CAMOperation, ox: number, oy: number, zOff: number,
): string[] {
  const ccw = signedArea(verts) >= 0 ? verts : [...verts].reverse();
  if (ccw.length < 3) return [];
  const seq = chamferSharpSequence(ccw, op.chamferWidth ?? 0);
  const cop = { ...op, depth: chamferDepth(op) };
  const lines: string[] = [];

  for (const z of depthPasses(cop)) {
    const zOf = (p: { lift: boolean }) => (p.lift ? 0 : z); // lift = up to the surface
    lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
    lines.push(`G0 X${X(seq[0].x, ox)} Y${Y(seq[0].y, oy)}`);
    lines.push(`G1 Z${Z(zOf(seq[0]), zOff)} F${n(op.plungeRate)}`);
    for (let i = 1; i < seq.length; i++) {
      const f = i === 1 ? ` F${n(op.feedrate)}` : "";
      lines.push(`G1 X${X(seq[i].x, ox)} Y${Y(seq[i].y, oy)} Z${Z(zOf(seq[i]), zOff)}${f}`);
    }
    lines.push(`G1 X${X(seq[0].x, ox)} Y${Y(seq[0].y, oy)} Z${Z(zOf(seq[0]), zOff)}`); // close
  }
  lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
  return lines;
}

/** Chamfer a closed contour: trace the (optionally offset) edge at the derived depth. */
function chamferPolygon(
  verts: Vec2[], op: CAMOperation, ox: number, oy: number, zOff: number,
): string[] {
  const cop = { ...op, depth: chamferDepth(op) };
  const lines: string[] = [];
  for (const path of chamferOffsets(verts, op))
    lines.push(...(op.sharpenCorners
      ? chamferContourSharp(path, op, ox, oy, zOff)
      : engravePoints(path, true, cop, ox, oy, zOff)));
  return lines;
}

/** Chamfer a circle: trace a circle shifted per side at the derived depth. */
function chamferCircle(
  cx: number, cy: number, r: number, op: CAMOperation, ox: number, oy: number, zOff: number,
): string[] {
  const cop = { ...op, depth: chamferDepth(op) };
  const w = op.chamferWidth ?? 0;
  const radius = op.chamferSide === "outside" ? r + w
               : op.chamferSide === "inside"  ? Math.max(0.01, r - w)
               : r;
  return engraveCircle(cx, cy, radius, cop, ox, oy, zOff);
}

// --- toolpath body (no spindle/tool-change preamble) -------------------------

function toolpathBody(
  op: CAMOperation, doc: CADDocument,
  ox: number, oy: number, zOff: number,
  pp: PostProcessor,
): string[] {
  const lines: string[] = [];
  const entityMap = new Map(doc.entities.map((e) => [e.id, e]));

  // A chamfer needs a V-bit (the bevel angle comes from the tool) and a width.
  if (op.type === "chamfer") {
    if (op.toolType !== "v-bit")
      return [`; NOTE: chamfer requires a V-bit tool — skipped`];
    if ((op.chamferWidth ?? 0) <= 0)
      return [`; NOTE: chamfer width is 0 — skipped`];
    const d = chamferDepth(op);
    lines.push(`; Chamfer: ⌀ V-bit ${op.vAngle ?? 60}° · face ${op.chamferWidth}mm → depth ${n(d)}mm (${op.chamferSide ?? "on"})`);
  }

  // Region pockets: resolve each parametric region against live geometry and
  // pocket it (enclosed loops become islands). Supersedes the legacy
  // entityIds/islandIds pocket path.
  if (op.type === "pocket" && op.regions && op.regions.length > 0) {
    const loops = collectClosedLoops(doc.entities);
    for (const ref of op.regions) {
      const region = resolveRegion(ref, loops);
      if (!region) {
        lines.push(`; NOTE: a pocket region could not be resolved — its boundary geometry changed or was removed — skipped`);
        continue;
      }
      lines.push(...pocketPolygon(region.outer, region.holes, op, ox, oy, zOff));
    }
    return lines;
  }

  // Collect island polygons for pocket operations.
  const islandSet = new Set(op.islandIds ?? []);
  const islands: Vec2[][] = [];
  if (op.type === "pocket" && islandSet.size > 0) {
    for (const id of islandSet) {
      const e = entityMap.get(id);
      if (!e || e.isConstruction) continue;
      if (e instanceof CircleEntity) {
        const nSegs = Math.max(64, Math.ceil(2 * Math.PI * e.radius / 0.5));
        islands.push(Array.from({ length: nSegs }, (_, i) => {
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
    lines.push(`; islands: ${islands.length} polygon(s) from ${islandSet.size} entity id(s)`);
  }

  // For profile/pocket/chamfer ops, chain any selected LineEntity instances into closed polygons.
  const lineSegIds = new Set<string>();
  if (op.type === "profile" || op.type === "pocket" || op.type === "chamfer") {
    const lineEnts = op.entityIds
      .filter(id => !islandSet.has(id))
      .map(id => entityMap.get(id))
      .filter((e): e is LineEntity => e instanceof LineEntity && !e.isConstruction);
    if (lineEnts.length > 0) {
      const { polygons, leftover } = chainLinesIntoPolygons(lineEnts);
      for (const { verts } of polygons) {
        if (op.type === "pocket") lines.push(...pocketPolygon(verts, islands, op, ox, oy, zOff));
        else if (op.type === "chamfer") lines.push(...chamferPolygon(verts, op, ox, oy, zOff));
        else lines.push(...profilePolygon(verts, op, ox, oy, zOff));
      }
      if (leftover.length > 0)
        lines.push(`; NOTE: ${leftover.length} selected line(s) do not form a closed polygon — skipped`);
      for (const e of lineEnts) lineSegIds.add(e.id);
    }
  }

  let firstDrill = true;
  for (const id of op.entityIds) {
    if (lineSegIds.has(id) || islandSet.has(id)) continue;
    const ent = entityMap.get(id);
    if (!ent || ent.isConstruction) continue;

    if (op.type === "drill") {
      if (ent instanceof CircleEntity) {
        // Establish safe Z once, before the first hole, then peck each hole.
        if (firstDrill) { lines.push(`G0 Z${Z(op.safeZ, zOff)}`); firstDrill = false; }
        lines.push(...drillPoint(ent.center.x, ent.center.y, op, ox, oy, zOff));
      }
      continue;
    }

    // Expand TextEntity to glyph contours and re-dispatch
    if (ent instanceof TextEntity) {
      const contours = textToContours(ent);
      if (contours.length === 0) {
        lines.push(`; NOTE: text "${ent.text}" — font not loaded or no glyphs`);
        continue;
      }
      for (const c of contours) {
        if (op.type === "engrave")
          lines.push(...engravePoints(c.points, c.closed, op, ox, oy, zOff));
        else if (op.type === "chamfer" && c.closed)
          lines.push(...chamferPolygon(c.points, op, ox, oy, zOff));
        else if (op.type === "pocket" && c.closed)
          lines.push(...pocketPolygon(c.points, islands, op, ox, oy, zOff));
        else if (op.type === "profile" && c.closed)
          lines.push(...profilePolygon(c.points, op, ox, oy, zOff));
      }
      continue;
    }

    if (op.type === "chamfer") {
      const cop = { ...op, depth: chamferDepth(op) };
      if (ent instanceof CircleEntity)
        lines.push(...chamferCircle(ent.center.x, ent.center.y, ent.radius, op, ox, oy, zOff));
      else if (ent instanceof RectEntity)
        lines.push(...chamferPolygon([...ent.corners()], op, ox, oy, zOff));
      else if (ent instanceof PolylineEntity && ent.closed)
        lines.push(...chamferPolygon(ent.points, op, ox, oy, zOff));
      else if (ent instanceof PolylineEntity)
        lines.push(...engravePoints(ent.points, false, cop, ox, oy, zOff)); // open edge, centred
      else if (ent instanceof LineEntity)
        lines.push(...engravePoints([ent.a, ent.b], false, cop, ox, oy, zOff));
      else if (ent instanceof ArcEntity)
        lines.push(...engraveArc(ent, cop, ox, oy, zOff));
      else if (ent instanceof BezierEntity)
        lines.push(...pp.engraveBezier(ent.p0, ent.p1, ent.p2, ent.p3, cop, ox, oy, zOff));
      continue;
    }

    if (op.type === "engrave") {
      if (ent instanceof LineEntity)
        lines.push(...engravePoints([ent.a, ent.b], false, op, ox, oy, zOff));
      else if (ent instanceof CircleEntity)
        lines.push(...engraveCircle(ent.center.x, ent.center.y, ent.radius, op, ox, oy, zOff));
      else if (ent instanceof RectEntity)
        lines.push(...engravePoints([...ent.corners()], true, op, ox, oy, zOff));
      else if (ent instanceof PolylineEntity)
        lines.push(...engravePoints(ent.points, ent.closed, op, ox, oy, zOff));
      else if (ent instanceof ArcEntity)
        lines.push(...engraveArc(ent, op, ox, oy, zOff));
      else if (ent instanceof BezierEntity)
        lines.push(...pp.engraveBezier(ent.p0, ent.p1, ent.p2, ent.p3, op, ox, oy, zOff));
      continue;
    }

    // profile / pocket
    if (op.type === "pocket") {
      if (ent instanceof CircleEntity)
        lines.push(...pocketCircle(ent.center.x, ent.center.y, ent.radius, islands, op, ox, oy, zOff));
      else if (ent instanceof RectEntity)
        lines.push(...pocketPolygon([...ent.corners()], islands, op, ox, oy, zOff));
      else if (ent instanceof PolylineEntity && ent.closed)
        lines.push(...pocketPolygon(ent.points, islands, op, ox, oy, zOff));
      else if (ent instanceof ArcEntity)
        lines.push(`; NOTE: arc (${ent.id}) skipped — pocket requires a closed region (use a closed loop or region pick)`);
    } else {
      if (ent instanceof CircleEntity)
        lines.push(...profileCircle(ent.center.x, ent.center.y, ent.radius, op, ox, oy, zOff));
      else if (ent instanceof RectEntity)
        lines.push(...profilePolygon([...ent.corners()], op, ox, oy, zOff));
      else if (ent instanceof PolylineEntity && ent.closed)
        lines.push(...profilePolygon(ent.points, op, ox, oy, zOff));
      else if (ent instanceof PolylineEntity)
        lines.push(`; NOTE: open polyline (${ent.id}) skipped — profile requires closed geometry`);
      else if (ent instanceof LineEntity)
        lines.push("; NOTE: open line skipped — profile requires closed geometry");
      else if (ent instanceof ArcEntity)
        lines.push(`; NOTE: arc (${ent.id}) skipped — profile requires closed geometry (use engrave for an open arc)`);
      else if (ent instanceof BezierEntity)
        lines.push(`; NOTE: bezier (${ent.id}) skipped in profile — beziers are open paths`);
    }
  }
  return lines;
}

// --- main entry --------------------------------------------------------------

export interface GCodeOptions {
  /** Machine-wide custom lines injected after the G21/G90/G17 setup block. */
  customStart?: string;
  /** Machine-wide custom lines injected after the final M5, before M30. */
  customEnd?: string;
  /**
   * Whether the machine has coolant. When explicitly false, no M7/M8/M9 is
   * emitted even if the document requests a coolant mode. Undefined = assume
   * supported (so the document's `coolant` drives emission).
   */
  coolantSupported?: boolean;
}

/** Split a multi-line custom block into trimmed, non-empty-trailing lines. */
function customLines(block: string | undefined): string[] {
  if (!block || !block.trim()) return [];
  return block.replace(/\s+$/, "").split(/\r?\n/);
}

export function generateGCode(
  rawOps: CAMOperation[], doc: CADDocument, opts: GCodeOptions = {},
): string {
  if (rawOps.length === 0) return "; No toolpaths\nM30\n";

  // Resolve each op's tool reference up front so every downstream read of
  // op.diameter/feedrate/etc. sees the embedded tool's values when toolId is set.
  const ops = rawOps.map((op) => resolveOpTool(op, doc.tools));

  const { ox, oy, zOffset } = resolveOrigin(doc);
  const pp = getPostProcessor(doc.postProcessor ?? "linuxcnc");

  const xLabel = { left: "Left", center: "Center", right: "Right" }[doc.origin.x];
  const yLabel = { front: "Front", center: "Center", back: "Back" }[doc.origin.y];
  const zLabel = doc.origin.z === "top"
    ? "Top of stock"
    : `Bed (top at Z=${n(doc.stockThickness)}mm)`;

  const toolsSeen = new Map<number, CAMOperation>();
  for (const op of ops) {
    if (!toolsSeen.has(op.toolNumber)) toolsSeen.set(op.toolNumber, op);
  }
  const toolSummary = [...toolsSeen.entries()]
    .sort(([a], [b]) => a - b)
    .map(([t, op]) => {
      const tl = op.toolType === "v-bit"    ? `V-Bit(${op.vAngle ?? 60}°)`
               : op.toolType === "ball-nose" ? "BallNose"
               : op.toolType === "drill"     ? "Drill"
               : "EndMill";
      return `T${t} ⌀${op.diameter}mm ${tl} ${op.spindleSpeed}rpm`;
    })
    .join(", ");

  const lines: string[] = [
    "; RapidCAM generated G-code",
    `; Post-processor: ${pp.name}`,
    `; ${ops.length} toolpath${ops.length !== 1 ? "s" : ""}`,
    `; WCS origin X: ${xLabel}  Y: ${yLabel}  Z: ${zLabel}`,
    `; Stock: ${doc.canvas.width} × ${doc.canvas.height} × ${doc.stockThickness}mm`,
    `; Tools: ${toolSummary}`,
    "G21 ; metric",
    "G90 ; absolute",
    "G17 ; XY plane",
    "",
  ];

  // Machine-wide custom program start (e.g. a shop's safe-start block).
  const startLines = customLines(opts.customStart);
  if (startLines.length > 0) {
    lines.push("; --- custom start ---", ...startLines, "");
  }

  // Coolant is per-operation: each op's mode is turned on after its spindle is
  // running and turned off (M9) when it changes, at a tool change, and at
  // program end. Suppressed entirely when the machine has no coolant.
  const coolantSupported = opts.coolantSupported !== false;
  const coolantOnCode = (m: CoolantMode): string | null =>
    m === "mist"  ? "M7 ; mist coolant on"
    : m === "flood" ? "M8 ; flood coolant on"
    : null;
  let currentCoolant: CoolantMode = "off";

  let currentTool: number | null = null;
  let currentSpeed: number | null = null;

  for (const op of ops) {
    const toolChanged = op.toolNumber !== currentTool;
    const speedChanged = op.spindleSpeed !== currentSpeed;
    const isFirst = currentTool === null;

    if (toolChanged || isFirst) {
      if (!isFirst) {
        lines.push(`G0 Z${n(op.safeZ + (doc.origin.z === "bed" ? doc.stockThickness : 0))}`);
        if (currentCoolant !== "off") { lines.push("M9 ; coolant off"); currentCoolant = "off"; }
        lines.push("M5 ; spindle stop");
      }

      if (doc.hasToolChanger) {
        lines.push(`T${op.toolNumber} M6 ; tool change`);
      } else if (!isFirst && toolChanged) {
        lines.push(`; *** Manual tool change to T${op.toolNumber} (⌀${op.diameter}mm) ***`);
        lines.push("; M0 ; uncomment to pause for manual tool change");
      }

      lines.push(`M3 S${op.spindleSpeed} ; spindle on`);
      lines.push("");
    } else if (speedChanged) {
      lines.push(`S${op.spindleSpeed} ; spindle speed change`);
    }

    currentTool = op.toolNumber;
    currentSpeed = op.spindleSpeed;

    // Per-op coolant: switch to this op's mode (spindle is now running). A tool
    // change above already reset it to off, so this re-establishes it; ops that
    // share a tool only emit a command when the mode actually changes.
    const opCoolant: CoolantMode = coolantSupported ? (op.coolant ?? "off") : "off";
    if (opCoolant !== currentCoolant) {
      lines.push(opCoolant === "off" ? "M9 ; coolant off" : coolantOnCode(opCoolant)!);
      currentCoolant = opCoolant;
    }

    const typeLabel =
      op.type === "profile" ? `Profile (${op.side})`
      : op.type === "pocket"  ? "Pocket"
      : op.type === "engrave" ? "Engrave"
      : "Drill";
    const toolLabel = op.toolType === "v-bit"     ? `V-Bit(${op.vAngle ?? 60}°)`
                    : op.toolType === "ball-nose"  ? "Ball Nose"
                    : op.toolType === "drill"      ? `Drill(tip ${op.tipAngle ?? 118}°)`
                    : "End Mill";
    lines.push(`; --- ${typeLabel} "${op.name}"  T${op.toolNumber} ⌀${op.diameter}mm ${toolLabel}  depth:${op.depth}mm ---`);
    if (op.toolType === "v-bit" && op.type === "engrave") {
      const halfAngle = ((op.vAngle ?? 60) / 2) * (Math.PI / 180);
      const width = (2 * Math.abs(op.depth) * Math.tan(halfAngle)).toFixed(3);
      lines.push(`; V-Bit effective cut width at ${op.depth}mm: ${width}mm`);
    }
    lines.push(...toolpathBody(op, doc, ox, oy, zOffset, pp));
    lines.push("");
  }

  // Optional end-of-program park: lift to the last op's safe Z, then rapid to
  // the requested work-coordinate position (e.g. 0,0 = WCS origin). The end
  // position is already in work coords, so it's emitted without the origin
  // offset that X()/Y() apply to model coordinates.
  const ep = doc.endPosition;
  if (ep) {
    const lastSafeZ = ops[ops.length - 1].safeZ;
    lines.push(`G0 Z${Z(lastSafeZ, zOffset)}`);
    lines.push(`G0 X${n(ep.x)} Y${n(ep.y)} ; return to end position`);
  }

  if (currentCoolant !== "off") lines.push("M9 ; coolant off");
  lines.push("M5 ; spindle stop");

  // Machine-wide custom program end (after spindle stop, before M30).
  const endLines = customLines(opts.customEnd);
  if (endLines.length > 0) {
    lines.push("; --- custom end ---", ...endLines);
  }

  lines.push("M30 ; end program");
  return lines.join("\n");
}
