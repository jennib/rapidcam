import type { Vec2 } from "../core/vec2";
import { type CADDocument, resolveOrigin, stockFootprint, stockBox } from "../model/document";
import { machinableEntityMap } from "./machinable";
import {
  type Entity,
  LineEntity,
  CircleEntity,
  RectEntity,
  PolylineEntity,
  BezierEntity,
  TextEntity,
  ArcEntity,
  RasterImageEntity,
} from "../model/entities";
import { rasterField, makeRasterXf, xfPoint, levelDepthEps } from "./rasterEngrave";
import {
  reliefSpacing,
  grooveWidth,
  grooveOverlapRatio,
  OVERLAP_WARN_RATIO,
} from "./halftone";
import { reliefEncodingFor } from "./reliefEncoding";
import { toolContactField } from "./toolProfile";
import { FINISH_STEPOVER_FRACTION, cuspReadout } from "./scallop";
import { getImageGrid } from "../core/imageManager";
import { textToContours } from "./textOutlines";
import {
  type CAMOperation,
  type CoolantMode,
  DEFAULTS,
  chamferDepth,
  chamferSharpSequence,
  resolveOpTool,
} from "./types";
import { offsetPolygon, signedArea, startAtLongestEdgeMid } from "./offset";
import { addCornerReliefs } from "./dogbone";

/**
 * Reorient a profile toolpath loop so it travels in the requested cut direction,
 * assuming a clockwise (M3) spindle. Climb keeps the freshly-cut wall behind the
 * tool; the winding that achieves it flips with the cut side:
 *   climb → CCW inside, CW outside;   conventional → the reverse.
 * Unset leaves the loop as-is (byte-identical to pre-toggle output).
 */
function orientForCut(loop: Vec2[], op: CAMOperation): Vec2[] {
  if (op.cutDirection !== "climb" && op.cutDirection !== "conventional") return loop;
  const wantCCW = op.cutDirection === "climb" ? op.side === "inside" : op.side === "outside";
  const isCCW = signedArea(loop) >= 0;
  return isCCW === wantCCW ? loop : [...loop].reverse();
}
import { contourParallelClear, clearCentreRegion, type ClearingMove } from "./clearing";
import { adaptiveClear } from "./adaptive";
import { restRegions, restCentreRegions, restArea, reliefRest } from "./rest";
import { facePlan, type Rect } from "./facing";
import { n, X, Y, Z, depthPasses, toAsciiGcode, type PostProcessor } from "./postprocessors/base";
import { pathLengths, computeTabRegions, resolveTabCount, splitPathForTabs } from "./tabs";
import { rasterRows, rasterRowsWithIslands } from "./pocket";
import { chainLinesIntoPolygons, chainOpenCurvesIntoLoops, collectClosedLoops } from "./loops";
import { resolveRegion } from "./regions";
import {
  vcarveRegion,
  vcarveParamsForOp,
  groupContoursIntoRegions,
  type CarveRegion,
} from "./vcarve";
import { fitArcs } from "./arcfit";
import { expandOpPatternTargets } from "./patternExpand";
import { LinuxCNC } from "./postprocessors/linuxcnc";
import { Grbl } from "./postprocessors/grbl";
import { generateLaserGCode } from "./lasergcode";
import { insertTimeEstimateComment } from "./timeEstimate";

export function getPostProcessor(name: string): PostProcessor {
  switch (name) {
    case "grbl":
      return new Grbl();
    default:
      return new LinuxCNC();
  }
}

// --- profile -----------------------------------------------------------------

/** Compute normalised entry/exit tangent and optional lead geometry for a closed path. */
function leadInGeo(path: Vec2[], leadR: number, side: "outside" | "inside") {
  const t1 = path[1],
    t0 = path[0],
    tn = path[path.length - 1];
  const dx = t1.x - t0.x,
    dy = t1.y - t0.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-9) return null;
  const tx = dx / len,
    ty = dy / len;
  // Left normal for outside (CW), right normal for inside (CCW).
  const sg = side === "outside" ? 1 : -1;
  const nx = -ty * sg,
    ny = tx * sg;
  // Entry arc start point
  const arcStart: Vec2 = { x: t0.x + nx * leadR - tx * leadR, y: t0.y + ny * leadR - ty * leadR };
  // Exit tangent (direction arriving at path[0] from the last move)
  const ex = t0.x - tn.x,
    ey = t0.y - tn.y;
  const el = Math.sqrt(ex * ex + ey * ey);
  const etx = el > 1e-9 ? ex / el : tx,
    ety = el > 1e-9 ? ey / el : ty;
  const enx = -ety * sg,
    eny = etx * sg;
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
export function finishAllowance(op: CAMOperation): number {
  if (!op.finishPass) return 0;
  const a = op.finishAllowance ?? FINISH_ALLOWANCE_DEFAULT;
  return Math.max(0, Math.min(a, (op.diameter / 2) * 0.8));
}

function profilePolygon(
  verts: Vec2[],
  op: CAMOperation,
  ox: number,
  oy: number,
  zOff: number,
  stockThickness: number,
): string[] {
  const toolR = op.diameter / 2;
  // Normalise winding to CCW so "outside" (+toolR) always expands and "inside"
  // (-toolR) always shrinks, regardless of how the source geometry was wound.
  const ccw = signedArea(verts) >= 0 ? verts : [...verts].reverse();
  const sideSign = op.side === "outside" ? 1 : -1;

  // Roughing leaves `allowance` of stock on the wall; the finishing lap then cuts
  // at the true offset to remove it. With no allowance the finish lap coincides
  // with roughing — a spring pass.
  const allowance = finishAllowance(op);
  const roughPaths = offsetPolygon(ccw, sideSign * (toolR + allowance));
  if (roughPaths.length === 0) return [];
  const finishPaths = op.finishPass
    ? allowance > 0
      ? offsetPolygon(ccw, sideSign * toolR)
      : roughPaths
    : [];

  const tabs = op.tabs;
  const tabsBySpacing = tabs?.strategy === "spacing" && (tabs.spacing ?? 0) > 0;
  const hasTabs = !!(
    tabs?.enabled &&
    (tabs.count > 0 || tabsBySpacing) &&
    tabs.width > 0 &&
    tabs.height > 0
  );
  // Tabs leave `height` mm of material measured from the STOCK BOTTOM, not the cut
  // floor: a through-cut (depth past the stock) would otherwise sink the tab into
  // the spoilboard, holding nothing. `max` keeps a shallow profile's tab at its own
  // floor (its cut never reaches the stock bottom).
  const tabZOff = hasTabs ? Math.max(op.depth, -stockThickness) + tabs!.height : 0;

  const liType = op.leadIn?.type ?? "none";
  const loType = op.leadOut?.type ?? "none";
  const liLen = op.leadIn?.length ?? 2;
  const loLen = op.leadOut?.length ?? 2;
  const useLead = liType !== "none" || loType !== "none";

  const lines: string[] = [];

  // Trace one closed lap of `path` at depth `z` (approach/entry, body with
  // optional tabs, lead-out). `zFrom` is the depth the previous pass left the
  // floor at, and the height this one has to lose; null means "just plunge".
  const tracePass = (path: Vec2[], z: number, zFrom: number | null): void => {
    const s = path[0];
    const geo = useLead ? leadInGeo(path, Math.max(liLen, loLen), op.side) : null;
    const useTabsThisPass = hasTabs && z < tabZOff;

    // A closed lap can be entered by spiralling down the contour itself, which
    // spreads the descent along the cut instead of driving the tool in axially —
    // the treatment pocket entries have always had. Two cases keep the plunge:
    // a lead-in (the lead IS the entry, and it starts off the contour, so a
    // helix around the contour would cut before the lead did), and the finishing
    // lap (`zFrom` null), whose plunge lands in the rough kerf rather than solid
    // stock.
    //
    // With tabs, the helix stops at the tab tops: it laps the WHOLE contour,
    // including the spans that have to stay standing, so descending to `z` here
    // would machine the tabs away. The tab-aware body below then takes the
    // remaining depth between them, exactly as it did before.
    const entryFloor = useTabsThisPass ? Math.max(z, tabZOff) : z;
    const canHelix =
      zFrom !== null && liType === "none" && path.length >= 3 && zFrom - entryFloor > 1e-9;
    let reachedZ = z;

    if (canHelix) {
      lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
      lines.push(`G0 X${X(s.x, ox)} Y${Y(s.y, oy)}`);
      lines.push(`G0 Z${Z(zFrom + RAMP_CLEAR, zOff)}`);
      lines.push(`G1 Z${Z(zFrom, zOff)} F${n(op.plungeRate)}`);
      lines.push(...helicalDescent(path, zFrom, entryFloor, op, ox, oy, zOff));
      reachedZ = entryFloor;
    } else if (liType === "none" || !geo) {
      lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
      lines.push(`G0 X${X(s.x, ox)} Y${Y(s.y, oy)}`);
      lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
    } else if (liType === "linear") {
      const { tx, ty } = geo;
      const lx = s.x - tx * liLen,
        ly = s.y - ty * liLen;
      lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
      lines.push(`G0 X${X(lx, ox)} Y${Y(ly, oy)}`);
      lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
      lines.push(`G1 X${X(s.x, ox)} Y${Y(s.y, oy)} F${n(op.feedrate)}`);
    } else {
      // arc
      const { arcStart, arcCmd, tx, ty } = leadInGeo(path, liLen, op.side)!;
      lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
      lines.push(`G0 X${X(arcStart.x, ox)} Y${Y(arcStart.y, oy)}`);
      lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
      lines.push(
        `${arcCmd} X${X(s.x, ox)} Y${Y(s.y, oy)} I${n(tx * liLen)} J${n(ty * liLen)} F${n(op.feedrate)}`,
      );
    }

    // Arc-fit an open run of points starting at the current tool position
    // (pts[0]). Curved runs post as smooth G2/G3; straight runs fit to all lines
    // → identical output. I/J are the centre offset from each move's start point.
    // `first` carries the pending feed word across runs; returns it updated.
    const emitRun = (pts: Vec2[], first: boolean): boolean => {
      let cur = pts[0];
      for (const mv of fitArcs(pts)) {
        const f = first ? ` F${n(op.feedrate)}` : "";
        if (mv.kind === "line") {
          lines.push(`G1 X${X(mv.to.x, ox)} Y${Y(mv.to.y, oy)}${f}`);
        } else {
          const cmd = mv.cw ? "G2" : "G3";
          lines.push(
            `${cmd} X${X(mv.to.x, ox)} Y${Y(mv.to.y, oy)} I${n(mv.cx - cur.x)} J${n(mv.cy - cur.y)}${f}`,
          );
        }
        cur = mv.to;
        first = false;
      }
      return first;
    };

    if (!useTabsThisPass) {
      // Arc-fit the whole closed lap.
      emitRun([...path, s], liType === "none");
    } else {
      const cumLens = pathLengths(path);
      const totalLen = cumLens[path.length];
      const tabN = resolveTabCount(
        totalLen,
        tabs!.count,
        tabsBySpacing ? tabs!.spacing : undefined,
      );
      const regions = computeTabRegions(totalLen, tabN, tabs!.width);
      const segs = splitPathForTabs(path, cumLens, regions);

      // Walk the split segments, arc-fitting each maximal run of material-cutting
      // (non-tab) segments so curved profiles stay smooth between tabs; tab bridges
      // ride up to tabZOff and stay straight G1 lines (they're short by design).
      // The helix may have stopped at the tab tops rather than at `z`.
      let currentZ = reachedZ;
      let first = liType === "none";
      let i = 0;
      while (i < segs.length) {
        if (segs[i].isTab) {
          if (currentZ !== tabZOff) {
            lines.push(`G1 Z${Z(tabZOff, zOff)} F${n(op.plungeRate)}`);
            currentZ = tabZOff;
            // The lift left plungeRate as the modal feed — the next lateral
            // cut must re-issue the cutting feed or the whole rest of the lap
            // silently runs at plunge speed.
            first = true;
          }
          const feedStr = first ? ` F${n(op.feedrate)}` : "";
          lines.push(`G1 X${X(segs[i].p1.x, ox)} Y${Y(segs[i].p1.y, oy)}${feedStr}`);
          first = false;
          i++;
        } else {
          const runPts: Vec2[] = [segs[i].p0];
          while (i < segs.length && !segs[i].isTab) {
            runPts.push(segs[i].p1);
            i++;
          }
          if (currentZ !== z) {
            lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
            currentZ = z;
            first = true; // same: restore the cutting feed after the descent
          }
          first = emitRun(runPts, first);
        }
      }
      if (currentZ !== z) lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
    }

    if (loType === "linear" && geo) {
      const { etx, ety } = geo;
      lines.push(`G1 X${X(s.x + etx * loLen, ox)} Y${Y(s.y + ety * loLen, oy)}`);
    } else if (loType === "arc" && geo) {
      const loGeo = leadInGeo(path, loLen, op.side)!;
      lines.push(
        `${loGeo.arcCmd} X${X(loGeo.arcOut.x, ox)} Y${Y(loGeo.arcOut.y, oy)} I${n(loGeo.enx * loLen)} J${n(loGeo.eny * loLen)}`,
      );
    }
  };

  // Anchor the lead/plunge mid-edge only when a lead is used (otherwise leave the
  // profiles optionally get dog-bone corner relief first (a female feature that
  // must seat a square part); outside profiles optionally get it for tabs.
  const dogbone = op.cornerStyle === "dogbone" || op.cornerStyle === "tbone";
  const dogboneSide = op.type === "profile" && op.side === "outside" ? "outside" : "inside";
  const prep = (raw: Vec2[]): Vec2[] => {
    const db = dogbone ? addCornerReliefs(raw, toolR, dogboneSide, op.cornerStyle as "dogbone" | "tbone") : raw;
    const dir = orientForCut(db, op);
    return useLead ? startAtLongestEdgeMid(dir) : dir;
  };

  for (const rawPath of roughPaths) {
    if (rawPath.length < 2) continue;
    const path = prep(rawPath);
    let prevZ = 0; // top of stock (work surface)
    for (const z of depthPasses(op)) {
      tracePass(path, z, prevZ);
      prevZ = z;
    }
  }
  // Finishing lap at the true wall, full depth (its centre sits in the rough
  // kerf, so the plunge enters cleared stock — no helix needed, hence null).
  for (const rawPath of finishPaths) {
    if (rawPath.length < 2) continue;
    tracePass(prep(rawPath), op.depth, null);
  }

  lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
  return lines;
}

// --- pocket ------------------------------------------------------------------

/** Ramp-entry geometry: descend at this angle off horizontal (gentle on the cutter). */
const RAMP_ANGLE_DEG = 3;
/** Relief-roughing entry ramp angle — steeper than a pocket helix (the descent is
 *  only one stepdown), but still spreads the plunge load along the cut instead of
 *  dropping straight in. */
const ROUGH_RAMP_DEG = 20;

/**
 * The plunge ramp angle (degrees off horizontal) for an op: the user's
 * `rampAngle` override when set, else the context default. Clamped to a sane
 * range so a stray value can't make the ramp vertical (loads the tip) or
 * near-flat (a mile-long entry).
 */
function rampAngleDeg(op: CAMOperation, fallback: number): number {
  const a = op.rampAngle;
  if (a === undefined || !Number.isFinite(a)) return fallback;
  return Math.max(0.5, Math.min(45, a));
}
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
  a: Vec2,
  b: Vec2,
  zStart: number,
  zTarget: number,
  op: CAMOperation,
  ox: number,
  oy: number,
  zOff: number,
): string[] {
  const out: string[] = [];
  out.push(`G0 Z${Z(op.safeZ, zOff)}`);
  out.push(`G0 X${X(a.x, ox)} Y${Y(a.y, oy)}`);
  out.push(`G0 Z${Z(zStart + RAMP_CLEAR, zOff)}`); // rapid into cleared air above last level

  const segLen = Math.hypot(b.x - a.x, b.y - a.y);
  const depth = zStart - zTarget; // positive: how far we still need to descend
  if (segLen < 1e-6 || depth < 1e-9) {
    out.push(`G1 Z${Z(zTarget, zOff)} F${n(op.plungeRate)}`);
    if (segLen >= 1e-6) out.push(`G1 X${X(b.x, ox)} Y${Y(b.y, oy)} F${n(op.feedrate)}`);
    return out;
  }

  out.push(`G1 Z${Z(zStart, zOff)} F${n(op.plungeRate)}`); // feed down to the cut level
  const run = depth / Math.tan((rampAngleDeg(op, RAMP_ANGLE_DEG) * Math.PI) / 180); // horizontal travel needed

  let dist = 0;
  let cur = a,
    target = b;
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
 * Laps needed to lose `depth` around a path of length `perim` without exceeding
 * the op's helix angle. Shared by every helical entry — the pocket loop, the
 * bore and the profile entry — so they cannot drift into disagreeing about what
 * the angle means. Zero when there is nothing to descend, or nowhere to do it.
 */
function helixLapCount(perim: number, depth: number, op: CAMOperation): number {
  if (perim < 1e-9 || depth < 1e-9) return 0;
  return Math.max(
    1,
    Math.ceil(depth / (perim * Math.tan((rampAngleDeg(op, HELIX_ANGLE_MAX_DEG) * Math.PI) / 180))),
  );
}

/**
 * Spiral down `loop` from `zStart` to `zTarget`, ending back at `loop[0]` at
 * depth. Assumes the tool is already sitting at `loop[0]` at `zStart` — the
 * caller owns the approach — and emits no flat lap, because for a profile the
 * pass that follows this *is* one.
 */
function helicalDescent(
  loop: Vec2[],
  zStart: number,
  zTarget: number,
  op: CAMOperation,
  ox: number,
  oy: number,
  zOff: number,
): string[] {
  const N = loop.length;
  const seg: number[] = [];
  let perim = 0;
  for (let i = 0; i < N; i++) {
    const a = loop[i],
      b = loop[(i + 1) % N];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    seg.push(L);
    perim += L;
  }
  const depth = zStart - zTarget;
  const nLaps = helixLapCount(perim, depth, op);
  if (nLaps === 0) return [];

  const out: string[] = [];
  const totalArc = nLaps * perim;
  let acc = 0;
  let first = true;
  for (let lap = 0; lap < nLaps; lap++) {
    for (let i = 1; i <= N; i++) {
      acc += seg[(i - 1) % N];
      const zc = zStart - depth * Math.min(1, acc / totalArc);
      const p = loop[i % N];
      out.push(
        `G1 X${X(p.x, ox)} Y${Y(p.y, oy)} Z${Z(zc, zOff)}${first ? ` F${n(op.feedrate)}` : ""}`,
      );
      first = false;
    }
  }
  return out;
}

/**
 * Cut a closed loop with a helical entry: descend from `zStart` to `z` while
 * spiralling around the loop (one or more laps, kept under HELIX_ANGLE_MAX_DEG),
 * then one flat finishing lap so the floor is level. Always ends back at loop[0].
 * Much gentler than a vertical plunge and avoids the oscillation of ramping along
 * a single short edge.
 */
function helicalLoop(
  loop: Vec2[],
  zStart: number,
  z: number,
  op: CAMOperation,
  ox: number,
  oy: number,
  zOff: number,
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
    const a = loop[i],
      b = loop[(i + 1) % N];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    seg.push(L);
    perim += L;
  }
  const depth = zStart - z;
  if (perim < 1e-9 || depth < 1e-9) {
    out.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
    for (let i = 1; i <= N; i++)
      out.push(
        `G1 X${X(loop[i % N].x, ox)} Y${Y(loop[i % N].y, oy)}${i === 1 ? ` F${n(op.feedrate)}` : ""}`,
      );
    return out;
  }

  const nLaps = helixLapCount(perim, depth, op);
  const totalArc = nLaps * perim;
  let acc = 0,
    first = true;
  for (let lap = 0; lap < nLaps; lap++) {
    for (let i = 1; i <= N; i++) {
      acc += seg[(i - 1) % N];
      const zc = zStart - depth * Math.min(1, acc / totalArc);
      const p = loop[i % N];
      out.push(
        `G1 X${X(p.x, ox)} Y${Y(p.y, oy)} Z${Z(zc, zOff)}${first ? ` F${n(op.feedrate)}` : ""}`,
      );
      first = false;
    }
  }
  // Flat finishing lap at full depth (ends at loop[0]).
  for (let i = 1; i <= N; i++) out.push(`G1 X${X(loop[i % N].x, ox)} Y${Y(loop[i % N].y, oy)}`);
  return out;
}

/** Profile a closed contour at a fixed depth, entering with a ramp along its first edge. */
function finishContour(
  poly: Vec2[],
  zStart: number,
  z: number,
  op: CAMOperation,
  ox: number,
  oy: number,
  zOff: number,
): string[] {
  if (poly.length < 3) return [];
  const out = rampPlunge(poly[0], poly[1], zStart, z, op, ox, oy, zOff); // ends at poly[1] @ z
  for (let i = 2; i < poly.length; i++) out.push(`G1 X${X(poly[i].x, ox)} Y${Y(poly[i].y, oy)}`);
  out.push(`G1 X${X(poly[0].x, ox)} Y${Y(poly[0].y, oy)}`);
  return out;
}

/** Dispatch to the configured pocket clearing strategy (default: contour-parallel). */
function pocketPolygon(
  verts: Vec2[],
  islands: Vec2[][],
  op: CAMOperation,
  ox: number,
  oy: number,
  zOff: number,
): string[] {
  const clear = (v: Vec2[], isl: Vec2[][]): string[] => {
    switch (op.pocketStrategy ?? "offset") {
      case "raster":
        return pocketPolygonRaster(v, isl, op, ox, oy, zOff);
      case "adaptive":
        return pocketPolygonAdaptive(v, isl, op, ox, oy, zOff);
      default:
        return pocketPolygonOffset(v, isl, op, ox, oy, zOff);
    }
  };

  const allowance = finishAllowance(op);
  const lines: string[] = [];

  // Rest machining: replace the pocket with just the parts the earlier, bigger
  // tool could not reach, and clear each of those with the chosen strategy.
  const restD = op.restToolDiameter ?? 0;
  if (restD > 0) {
    if (restD <= op.diameter) {
      return [
        `; NOTE: rest machining needs a previous tool LARGER than this one ` +
          `(previous dia ${n(restD)}mm, this dia ${n(op.diameter)}mm) — skipped`,
      ];
    }
    const leftover = restRegions(verts, islands, restD / 2, allowance);
    const centres = restCentreRegions(verts, islands, restD / 2, op.diameter / 2, allowance);
    const header =
      `; rest machining after dia ${n(restD)}mm: ${leftover.length} area` +
      `${leftover.length === 1 ? "" : "s"}, ${n(restArea(leftover))}mm2 standing`;
    const stepoverMM = Math.max(0.01, (op.stepover ?? 0.4) * op.diameter);
    // The centre set is handed to the clearer as-is: it is already where the
    // cutter may go, so insetting it again by a radius would shrink the pass off
    // the very stock it exists to take.
    const cut = centres.flatMap((r) =>
      emitClearingMoves(
        clearCentreRegion(
          [r.outer, ...r.holes],
          op.diameter / 2,
          stepoverMM,
          islands.map((h) => h),
        ),
        `rest, ${n(restArea(leftover))}mm2`,
        op,
        ox,
        oy,
        zOff,
        // Arc-fitted: a leftover region is bounded by the arc the round roughing
        // cutter swept, so these loops are genuinely curved and post as a swarm
        // of short segments otherwise.
        true,
      ),
    );
    // Judged on what came out, not on an area threshold: whether a cutter can
    // take a sliver depends on its shape, and a rule of thumb about square
    // millimetres gets both answers wrong at the edges.
    if (!cut.some((l) => /^G[123]\b/.test(l))) {
      return [
        `; NOTE: nothing to rest machine — a dia ${n(restD)}mm tool already reached everything ` +
          `this dia ${n(op.diameter)}mm one could take`,
      ];
    }
    lines.push(header, ...cut);
    // Falls through to the shared wall-lap block below rather than returning.
    // Returning here made two controls in the same dialog silently inert on a
    // rest pass: the dog-bone, whose corner relief is cut BY that lap — and
    // corners are the whole of what a rest pass does — and the finishing pass,
    // which changed the roughing allowance but never laid down the lap it names.
    // "Finishing pass" means the same lap on every other pocket; it means it
    // here too, and its cost shows up in the run-time estimate like any other.
  } else if (allowance > 0) {
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

  // Add a finishing wall lap if clearing actually cut something — a pocket too
  // small for the tool emits just a `; NOTE:` and has no wall to finish. A
  // dog-bone request also needs the wall lap (that's where the corner relief is
  // cut), even without an explicit finishing pass.
  const cleared = lines.some((l) => /^G[0-3]\b/.test(l));
  if ((op.finishPass || op.cornerStyle === "dogbone" || op.cornerStyle === "tbone") && cleared)
    lines.push(...pocketWallFinish(verts, islands, op, ox, oy, zOff));
  return lines;
}

/**
 * Final full-depth finishing lap around a pocket's walls (boundary + island
 * walls), to clean the ridges left by stepdown roughing. Independent of the
 * clearing strategy.
 */
function pocketWallFinish(
  verts: Vec2[],
  islands: Vec2[][],
  op: CAMOperation,
  ox: number,
  oy: number,
  zOff: number,
): string[] {
  const toolR = op.diameter / 2;
  const ccw = signedArea(verts) >= 0 ? verts : [...verts].reverse();
  const walls = offsetPolygon(ccw, -toolR);
  if (walls.length === 0) return [];

  // Dog-bone corner relief lives on the region walls (not the islands): the
  const dogboneSide = op.type === "profile" && op.side === "outside" ? "outside" : "inside";
  const wallLoops =
    op.cornerStyle === "dogbone" || op.cornerStyle === "tbone"
      ? walls.map((w) => addCornerReliefs(w, toolR, dogboneSide, op.cornerStyle as "dogbone" | "tbone"))
      : walls;

  const lines: string[] = [`; finishing pass (full-depth wall) Z${n(op.depth)}`];
  for (const w of wallLoops) lines.push(...finishContour(w, op.depth, op.depth, op, ox, oy, zOff));
  for (const isl of islands) {
    const pts = signedArea(isl) >= 0 ? isl : [...isl].reverse();
    for (const k of offsetPolygon(pts, toolR))
      lines.push(...finishContour(k, op.depth, op.depth, op, ox, oy, zOff));
  }
  lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
  return lines;
}

/**
 * Skim a surface level: the top of the blank, or the spoilboard.
 *
 * The rows run off the edge on every side (see facing.ts), so the tool is
 * already clear of the material at the start and end of each one — there is
 * nothing to plunge into. It steps down to depth like any other roughing
 * operation, and each level is a zig-zag with no lift between rows.
 *
 * Surfacing the bed is a different job wearing the same clothes: no workpiece on
 * the machine, and Z zeroed on the spoilboard rather than on stock that isn't
 * there. That cannot be inferred from the program, so it is stated in it.
 */
function faceSurface(
  op: CAMOperation,
  doc: CADDocument,
  ox: number,
  oy: number,
  zOff: number,
  machineBed?: { width: number; height: number } | null,
): string[] {
  // The bed comes in with the machine options rather than being read here: the
  // emitter is pure, and its tests build a job without touching localStorage.
  // A rotary job wraps a flat program around a cylinder, and there is no flat
  // surface on a dowel to skim. Left alone it emitted 46 moves of wrapped
  // facing rows spiralling round the workpiece — valid G-code for something
  // nobody asked for, which is worse than refusing.
  if (doc.isRotary) {
    return [
      `; NOTE: facing has no meaning on a rotary job — there is no flat surface on a cylinder — skipped`,
    ];
  }

  const bed: Rect | null =
    op.faceTarget === "bed" && machineBed && machineBed.width > 0 && machineBed.height > 0
      ? { x: 0, y: 0, width: machineBed.width, height: machineBed.height }
      : null;
  if (op.faceTarget === "bed" && !bed) {
    return [
      `; NOTE: spoilboard surfacing needs the machine's bed size — set it in Machine Settings — skipped`,
    ];
  }
  const target: Rect = bed ?? stockBox(doc);
  // Surfacing the bed is zeroed on the BED's front-left corner, not on the
  // blank's — there is no blank on the machine. Emitting the bed through the
  // stock's origin offset posted a 600mm bed as X-30..570, i.e. told the
  // operator to drive 30mm off the front of their own machine.
  if (bed) {
    ox = 0;
    oy = 0;
  }
  const toolR = op.diameter / 2;
  const stepover = Math.max(0.01, (op.stepover ?? 0.4) * op.diameter);
  const plan = facePlan(target, toolR, stepover, op.faceOverhang ?? 0, op.faceDirection ?? "x");
  if (!plan || plan.rows.length === 0) {
    return [`; NOTE: nothing to face — check the stock size and tool diameter — skipped`];
  }

  const lines: string[] = [];
  if (bed) {
    // Loud, and in the program itself: this one is run with the machine empty.
    lines.push(
      `; ***  SPOILBOARD SURFACING  ***`,
      `; ZERO ON THE SPOILBOARD, not on stock: X0 Y0 at its front-left corner,`,
      `; Z0 on its surface. This program ignores the blank in the drawing.`,
      `; Take the workpiece OFF the machine, and check that no clamp stands`,
      `; inside ${n(target.width)} x ${n(target.height)}mm of bed before starting.`,
    );
  }
  lines.push(
    `; facing ${bed ? "spoilboard" : "stock"}: ${n(plan.swept.width)} x ${n(plan.swept.height)}mm swept, ` +
      `${plan.rows.length} rows at ${n(stepover)}mm`,
  );

  for (const z of depthPasses(op)) {
    lines.push(`; facing pass Z${n(z)}`);
    const first = plan.rows[0];
    lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
    lines.push(`G0 X${X(first[0].x, ox)} Y${Y(first[0].y, oy)}`);
    // Down to depth clear of the material: every row starts off the edge.
    lines.push(`G1 Z${Z(z, zOff)} F${n(op.plungeRate)}`);
    let feed = true;
    for (const row of plan.rows) {
      for (const p of row) {
        lines.push(`G1 X${X(p.x, ox)} Y${Y(p.y, oy)}${feed ? ` F${n(op.feedrate)}` : ""}`);
        feed = false;
      }
    }
    lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
  }
  return lines;
}

/**
 * Emit a plan of clearing moves at every depth level. Shared by both clearing
 * strategies, which differ in the moves they produce, not in how they're cut:
 * each level is cleared completely before descending, the first cut of a level
 * helixes in, and later moves feed straight across ground the previous move
 * already cleared.
 */
function emitClearingMoves(
  moves: ClearingMove[],
  /** Full text for the per-pass comment, e.g. "contour-parallel, 14 loops". */
  label: string,
  op: CAMOperation,
  ox: number,
  oy: number,
  zOff: number,
  /**
   * Arc-fit the cutting moves. On by default for adaptive clearing, whose motion
   * is circles by construction: drawn as line segments a 40mm pocket posted
   * 20,876 moves against contour-parallel's 218, which is a file no controller
   * should be asked to look ahead through. Off for contour-parallel, whose loops
   * are offsets of arbitrary geometry — fitting those is a worthwhile change on
   * its own terms, and one that would move its golden.
   */
  arcFit = false,
): string[] {
  /** Emit a run of points from the current position, as arcs where they fit. */
  const emitRun = (pts: Vec2[]): string[] => {
    if (!arcFit) return pts.map((p) => `G1 X${X(p.x, ox)} Y${Y(p.y, oy)}`);
    const out: string[] = [];
    let cur = pts[0];
    for (const mv of fitArcs(pts)) {
      if (mv.kind === "line") {
        out.push(`G1 X${X(mv.to.x, ox)} Y${Y(mv.to.y, oy)}`);
      } else {
        out.push(
          `${mv.cw ? "G2" : "G3"} X${X(mv.to.x, ox)} Y${Y(mv.to.y, oy)} I${n(mv.cx - cur.x)} J${n(mv.cy - cur.y)}`,
        );
      }
      cur = mv.to;
    }
    return out;
  };
  const lines: string[] = [];
  let prevZ = 0; // top of stock (work surface)
  for (const z of depthPasses(op)) {
    lines.push(`; clearing pass Z${n(z)} (${label})`);
    let entered = false;
    for (const mv of moves) {
      const loop = mv.loop;
      // A closed loop needs three points to enclose anything; an open run is
      // valid with two — adaptive clearing emits those where a neck is too
      // narrow to loop in.
      const closed = mv.closed !== false;
      if (loop.length < (closed ? 3 : 2)) continue;
      if (entered && mv.link) {
        // Safe feed-link straight into this move (gap already cleared), trace at depth.
        lines.push(...emitRun(closed ? [...loop, loop[0]] : loop));
      } else if (closed) {
        // First move of the pass, or a gap too wide to feed across: helix in.
        lines.push(...helicalLoop(loop, prevZ, z, op, ox, oy, zOff));
        entered = true;
      } else {
        // An open run can't be helixed round — ramp down its own length instead.
        lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
        lines.push(`G0 X${X(loop[0].x, ox)} Y${Y(loop[0].y, oy)}`);
        lines.push(...rampPlunge(loop[0], loop[1], prevZ, z, op, ox, oy, zOff));
        for (let i = 2; i < loop.length; i++)
          lines.push(`G1 X${X(loop[i].x, ox)} Y${Y(loop[i].y, oy)}`);
        entered = true;
      }
    }
    lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
    prevZ = z;
  }
  return lines;
}

/**
 * Adaptive clearing: the same loop topology, but any stretch where the cutter
 * would be buried deeper than a straight wall step is replaced by trochoidal
 * circles, so the load is set by the advance per circle rather than by the shape
 * of the wall. See src/cam/adaptive.ts for the measurements behind that.
 */
function pocketPolygonAdaptive(
  verts: Vec2[],
  islands: Vec2[][],
  op: CAMOperation,
  ox: number,
  oy: number,
  zOff: number,
): string[] {
  const toolR = op.diameter / 2;
  const stepover = Math.max(0.01, (op.stepover ?? 0.4) * op.diameter);
  const moves = adaptiveClear(verts, islands, toolR, { stepover });
  if (moves.length === 0) return [`; NOTE: pocket too small for ⌀${op.diameter}mm tool — skipped`];
  return emitClearingMoves(moves, `adaptive, ${moves.length} moves`, op, ox, oy, zOff, true);
}

/**
 * Contour-parallel clearing: concentric offset loops that wrap islands without
 * lifting. Each depth level is cleared completely (innermost loop → outer wall)
 * before descending; loops link with short feed moves where the gap is already
 * cut, otherwise the tool lifts and ramps back in.
 */
function pocketPolygonOffset(
  verts: Vec2[],
  islands: Vec2[][],
  op: CAMOperation,
  ox: number,
  oy: number,
  zOff: number,
): string[] {
  const toolR = op.diameter / 2;
  const stepover = Math.max(0.01, (op.stepover ?? 0.4) * op.diameter);
  const moves = contourParallelClear(verts, islands, toolR, stepover);
  if (moves.length === 0) return [`; NOTE: pocket too small for ⌀${op.diameter}mm tool — skipped`];

  // Wording preserved exactly: the enclosure golden is the control proving this
  // strategy's output is untouched, and a comment counts.
  return emitClearingMoves(moves, `contour-parallel, ${moves.length} loops`, op, ox, oy, zOff);
}

function pocketPolygonRaster(
  verts: Vec2[],
  islands: Vec2[][],
  op: CAMOperation,
  ox: number,
  oy: number,
  zOff: number,
): string[] {
  const toolR = op.diameter / 2;
  const stepover = Math.max(0.01, (op.stepover ?? 0.4) * op.diameter);
  // Normalise winding to CCW so the inward (-toolR) inset always shrinks the
  // boundary, regardless of the source geometry's winding direction.
  const ccw = signedArea(verts) >= 0 ? verts : [...verts].reverse();
  const insets = offsetPolygon(ccw, -toolR);
  if (insets.length === 0) return [`; NOTE: pocket too small for ⌀${op.diameter}mm tool — skipped`];

  // Expand each island outward by toolR to create keepout zones.
  // If the offset returns empty (degenerate case), fall back to the raw polygon.
  const islandKeepouts = islands.flatMap((isl) => {
    const pts = signedArea(isl) >= 0 ? isl : [...isl].reverse();
    const expanded = offsetPolygon(pts, toolR);
    return expanded.length > 0 ? expanded : [pts];
  });

  const lines: string[] = [];

  for (const inset of insets) {
    const rows =
      islandKeepouts.length > 0
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
            const a = row[i],
              b = row[i + 1];
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
  cx: number,
  cy: number,
  rad: number,
  zStart: number,
  zTarget: number,
  op: CAMOperation,
  ox: number,
  oy: number,
  zOff: number,
): string[] {
  const sx = cx + rad;
  const out: string[] = [
    `G0 Z${Z(op.safeZ, zOff)}`,
    `G0 X${X(sx, ox)} Y${Y(cy, oy)}`,
    `G0 Z${Z(zStart + RAMP_CLEAR, zOff)}`,
    `G1 Z${Z(zStart, zOff)} F${n(op.plungeRate)}`,
  ];
  const depth = zStart - zTarget;
  const turns = helixLapCount(2 * Math.PI * rad, depth, op);
  for (let i = 1; i <= turns; i++) {
    const zc = zStart - depth * (i / turns);
    out.push(`G2 X${X(sx, ox)} Y${Y(cy, oy)} I${n(-rad)} J0 Z${Z(zc, zOff)} F${n(op.feedrate)}`);
  }
  out.push(`G2 X${X(sx, ox)} Y${Y(cy, oy)} I${n(-rad)} J0 F${n(op.feedrate)}`); // flat floor lap
  return out;
}

function pocketCircle(
  cx: number,
  cy: number,
  r: number,
  islands: Vec2[][],
  op: CAMOperation,
  ox: number,
  oy: number,
  zOff: number,
): string[] {
  // Rest machining a round pocket has a closed-form answer, and it is usually
  // "nothing": a round cutter that fits at all sweeps the whole circle, corners
  // included, because there are none. Without this the flag would be silently
  // ignored here and the pocket cut again in full — the opposite of what was
  // asked for. (Islands put corners back, so those go the polygon route.)
  const restD = op.restToolDiameter ?? 0;
  if (restD > 0 && islands.length === 0) {
    if (restD <= op.diameter) {
      return [
        `; NOTE: rest machining needs a previous tool LARGER than this one ` +
          `(previous dia ${n(restD)}mm, this dia ${n(op.diameter)}mm) — skipped`,
      ];
    }
    if (restD / 2 <= r) {
      return [
        `; NOTE: nothing to rest machine — a dia ${n(restD)}mm tool sweeps a round pocket entirely`,
      ];
    }
    // The earlier tool never fitted, so the pocket is untouched: cut it all.
  }
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
  const cutR = r - toolR;
  if (cutR <= 0) return [`; NOTE: pocket circle too small for ⌀${op.diameter}mm tool — skipped`];

  const so = Math.max(0.01, (op.stepover ?? 0.4) * op.diameter);
  const allowance = finishAllowance(op);
  // Rough out to the wall less the allowance; the finishing lap takes the wall.
  const roughR = allowance > 0 ? Math.max(0.01, cutR - allowance) : cutR;
  // Helix radius small enough that the tool covers the centre (≤ toolR).
  const helixR = Math.min(roughR, toolR * 0.9);

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
      lines.push(`G1 X${X(cx + rr, ox)} Y${Y(cy, oy)} F${n(op.feedrate)}`); // step out
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
  cx: number,
  cy: number,
  r: number,
  op: CAMOperation,
  ox: number,
  oy: number,
  zOff: number,
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
  // Spiral down the wall rather than plunging at each step. A circle can do this
  // as true helical interpolation — G2 with a Z word — so the entry stays one
  // arc per turn instead of the segment soup a tessellated helix would post.
  let prevZ = 0; // top of stock (work surface)
  for (const z of depthPasses(op)) {
    lines.push(...helicalBore(cx, cy, cutRrough, prevZ, z, op, ox, oy, zOff));
    prevZ = z;
  }
  // The finishing lap plunges: its centre sits inside the rough kerf, so it is
  // dropping through stock that has already been cleared.
  if (op.finishPass) circleAt(cutR, op.depth);
  lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
  return lines;
}

// --- engrave -----------------------------------------------------------------

function engravePoints(
  pts: Vec2[],
  closed: boolean,
  op: CAMOperation,
  ox: number,
  oy: number,
  zOff: number,
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
  cx: number,
  cy: number,
  r: number,
  op: CAMOperation,
  ox: number,
  oy: number,
  zOff: number,
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
  arc: ArcEntity,
  op: CAMOperation,
  ox: number,
  oy: number,
  zOff: number,
): string[] {
  const span = (((arc.endAngle - arc.startAngle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
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

// --- raster relief (greyscale image → modulated Z depth) ---------------------

/**
 * Carve a greyscale image as a 2.5-D RELIEF: the mill rasters the image like the
 * laser does, but maps each dot's darkness to **Z depth** (darker = deeper)
 * instead of beam power. Needs a depth-shaping bit (ball-nose or V-bit) — a flat
 * end mill leaves blocky flat-bottomed dots — and rides a *continuous* Z profile
 * across each row (white = surface), boustrophedon, with no retract between rows.
 *
 * Depth is reached over **stepdown passes** (each pass clamps to a deeper Z
 * floor), so the bit never plunges the full relief depth in one go — a single
 * deep pass would snap a small finishing bit. Equal-Z dots within a row are
 * merged into straight segments, so the move count is bounded by the number of
 * distinct depth levels, not the pixel count.
 *
 * The scan runs along the image's local rows; a rotated image carves along its
 * own tilted rows (each point lifted through the entity transform).
 */
function reliefImage(
  ent: RasterImageEntity,
  rawOp: CAMOperation,
  ox: number,
  oy: number,
  zOff: number,
): string[] {
  // How this image's bytes become depth, resolved once — a height map from an
  // imported STL is not tone-curved. `enc.op` is the op AS IT APPLIES to this
  // image, and shadowing the parameter with it means every line below screens on
  // the same truth rather than on what the op merely claims.
  const enc = reliefEncodingFor(ent, rawOp);
  const op = enc.op;
  if (op.toolType !== "ball-nose" && op.toolType !== "v-bit")
    return [
      `; NOTE: relief engrave needs a ball-nose or V-bit (got "${op.toolType}") — a flat end mill leaves blocky dots; image ${ent.id} skipped`,
    ];
  const grid = getImageGrid(ent.imageId);
  if (!grid) return [`; NOTE: image (${ent.id}) pixels not loaded — skipped`];

  const maxDepth = Math.abs(op.depth);
  if (maxDepth <= 0)
    return [`; NOTE: relief depth is 0 — set a cut depth; image ${ent.id} skipped`];
  const stepdown = op.stepdown > 0 ? op.stepdown : maxDepth;
  // Row/dot pitch comes from the shared resolver so the 3-D preview (rasRelief)
  // cannot disagree with what is posted here — halftone or ordinary relief.
  const { lineInterval, dotPitch, tone, plan } = reliefSpacing(op);

  const field = rasterField(grid, enc.field(lineInterval, dotPitch, tone));
  if (field.rows.length === 0)
    return [`; NOTE: relief produced nothing (blank or zero size) — image ${ent.id} skipped`];

  // A point sample is where the surface is under the TIP; the bit has flanks, so
  // the Z it may ride at is the max over its whole footprint. Without this the
  // flank cuts through material the centre sample said was clear.
  const { cols, colPitch, rows } = toolContactField(field, op, maxDepth);
  const passes = Math.max(1, Math.ceil(maxDepth / stepdown));
  const xf = makeRasterXf(ent.position, ent.angle);
  const lines: string[] = [];

  if (plan) {
    // Halftone: state the screen. Its tonal range is a property of the bit and
    // the depth — no amount of adjusting the image widens it — so the operator
    // needs the numbers, not a reassurance.
    const pct = (c: number) => Math.round(c * 100);
    lines.push(
      `; V-carve halftone: ${n(op.vAngle ?? DEFAULTS.vAngle)}° bit at ${n(maxDepth)}mm deep cuts ` +
        `${n(plan.grooveWidth)}mm grooves, spaced ${n(plan.rowPitch)}mm — ` +
        `${rows.length} rows, darkest tone ${pct(plan.maxCoverage)}% coverage`,
    );
    if (plan.capped)
      lines.push(
        `; NOTE: a ⌀${n(op.diameter)}mm ${n(op.vAngle ?? DEFAULTS.vAngle)}° bit runs out of flute at ` +
          `${n(plan.usableDepth)}mm — below that the groove stops widening, so the darkest tones ` +
          `flatten together. Cut ${n(plan.usableDepth)}mm deep, or use a wider bit.`,
      );
    if (plan.minCoverage > 0)
      lines.push(
        `; NOTE: the ${n(op.tipDiameter ?? 0)}mm flat on this bit cuts a ${n(op.tipDiameter ?? 0)}mm groove ` +
          `the instant it touches, so the lightest ${pct(plan.minCoverage)}% of the tonal range cannot be ` +
          `cut and prints as white. A sharp bit reaches the highlights.`,
      );
  } else if (op.halftone) {
    // The flag is set but the width law it depends on is the V's, so it is being
    // ignored. The dialog cannot produce this; a hand-written or AI-generated
    // .rcam can, and silently carving an ordinary relief instead is the sort of
    // "did what you asked" that is worse than refusing.
    lines.push(
      `; NOTE: halftone needs a V-bit (got "${op.toolType}") — ignored, carving an ordinary relief instead`,
    );
  } else if (op.toolType === "v-bit") {
    // Not halftoning: a V-bit cuts a cone per dot, not a smooth surface — fine
    // for line art, engraving-like for a photo. Flag it so the result isn't a
    // surprise, and name the mode that is built for this.
    lines.push(
      `; NOTE: a V-bit carves an engraving-like relief (a cone per dot, not a smooth surface) — use a ball-nose for a smooth photo relief, a V-carve op for line art, or turn on V-carve halftone to screen the photo as V-grooves`,
    );
    const overlap = grooveOverlapRatio(op);
    if (overlap >= OVERLAP_WARN_RATIO)
      lines.push(
        `; NOTE: rows are ${n(lineInterval)}mm apart but this bit cuts ${n(grooveWidth(maxDepth, op))}mm ` +
          `wide at ${n(maxDepth)}mm deep — each groove is re-cut by ~${overlap.toFixed(1)} of its ` +
          `neighbours, so fine detail is replaced by whatever was darkest nearby. Turn on V-carve ` +
          `halftone to space the rows to the bit.`,
      );
  }

  if (!plan) {
    // The finish this program will leave, stated before it is cut. Only the ROW
    // spacing leaves a cusp — along a row the tool rides a continuous Z, so the
    // dot pitch buys resolution, not smoothness.
    const cusp = cuspReadout(op, lineInterval);
    lines.push(
      cusp.overlapping
        ? `; finish: ⌀${n(op.diameter)}mm ${op.toolType} at ${n(lineInterval)}mm stepover ` +
          `(${Math.round(cusp.fraction * 100)}% of diameter) leaves a ${n(cusp.cusp)}mm cusp between rows`
        : `; NOTE: rows are ${n(lineInterval)}mm apart, wider than the ⌀${n(op.diameter)}mm bit — ` +
          `adjacent passes never touch, so what stands between them is not a cusp but ` +
          `full-height uncut stock. ${n(cusp.suggested)}mm (${FINISH_STEPOVER_FRACTION * 100}% of ⌀) ` +
          `is the usual finish stepover.`,
    );
  }

  for (let p = 1; p <= passes; p++) {
    const passFloor = -Math.min(p * stepdown, maxDepth); // deepest Z this pass may reach
    // How deep the previous pass already got. A row with nothing below that gets
    // clamped to exactly the Z it is already sitting at, so re-tracing it cuts
    // AIR for the row's whole length — on a halftone, where most of an image is
    // shallower than one stepdown, that was most of every pass after the first.
    // The first pass has nothing behind it and still rides the whole image
    // (blank rows included), so its output is unchanged.
    const prevReach = (p - 1) * stepdown;
    const needsPass = (r: number): boolean =>
      p === 1 || rows[r].levels.some((lv) => lv * maxDepth > prevReach + 1e-9);

    /** Vertices for rows `from..to`, one continuous boustrophedon, equal-Z merged. */
    const vertsFor = (from: number, to: number): { x: number; y: number; z: number }[] => {
      const verts: { x: number; y: number; z: number }[] = [];
      for (let r = from; r <= to; r++) {
        const row = rows[r];
        // Keyed to the ROW index, not to emission order, so the snake keeps
        // alternating within a run however the runs happen to fall.
        const ltr = r % 2 === 0;
        const zAt = (c: number) => Math.max(-row.levels[c] * maxDepth, passFloor);
        for (let k = 0; k < cols; k++) {
          const c = ltr ? k : cols - 1 - k;
          // Keep run boundaries and depth changes; drop interior collinear dots.
          const prev = ltr ? c - 1 : c + 1;
          const next = ltr ? c + 1 : c - 1;
          const z = zAt(c);
          const keep =
            k === 0 ||
            k === cols - 1 ||
            prev < 0 ||
            prev >= cols ||
            z !== zAt(prev) ||
            next < 0 ||
            next >= cols ||
            z !== zAt(next);
          // Lift the local (x, y) dot through the entity transform (rotation-aware).
          if (keep) {
            const w = xfPoint(xf, (c + 0.5) * colPitch, row.y);
            verts.push({ x: w.x, y: w.y, z });
          }
        }
      }
      return verts;
    };

    // Skipped rows break the snake, so each unbroken stretch is its own path
    // with its own approach — a feed move across the gap would plough a groove
    // through the rows in between.
    let r = 0;
    while (r < rows.length) {
      if (!needsPass(r)) {
        r++;
        continue;
      }
      let end = r;
      while (end + 1 < rows.length && needsPass(end + 1)) end++;
      const verts = vertsFor(r, end);
      r = end + 1;
      if (verts.length === 0) continue;

      lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
      lines.push(`G0 X${X(verts[0].x, ox)} Y${Y(verts[0].y, oy)}`);
      lines.push(`G1 Z${Z(verts[0].z, zOff)} F${n(op.plungeRate)}`);
      for (let i = 1; i < verts.length; i++) {
        const v = verts[i];
        const f = i === 1 ? ` F${n(op.feedrate)}` : "";
        lines.push(`G1 X${X(v.x, ox)} Y${Y(v.y, oy)} Z${Z(v.z, zOff)}${f}`);
      }
    }
  }
  lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
  return lines;
}

/**
 * ROUGH a greyscale relief in flat **Z-levels** with a coarse flat / bull-nose
 * tool, clearing the bulk down to a `finishAllowance` of stock that the relief
 * FINISH pass (an `engrave` op on the same image, ball-nose) then carves to shape.
 *
 * The image is resampled to a coarse grid at the roughing tool's stepover (a
 * fraction of its diameter, like a pocket), and each cell's final depth is
 * `−level·maxDepth` (darker = deeper). Roughing removes material down to
 * `finishZ + allowance` (capped at the stock top), in planes stepped down by
 * `stepdown`. At each plane `zP` the tool clears every cell whose rough surface
 * sits at or below the plane — a raster of straight runs (boustrophedon), hopping
 * over the gaps at a low clearance above the stock top (safe: nothing protrudes
 * above the stock). Because a deeper plane's cleared region is a subset of the
 * shallower one above it, the plunge at each run only cuts one `stepdown` of new
 * material — never a full-depth plunge.
 *
 * The op's depth / gamma / invert / flip should MATCH the finish op or the left
 * allowance won't be uniform; they're exposed on both ops for that reason.
 */
function reliefRoughImage(
  ent: RasterImageEntity,
  rawOp: CAMOperation,
  ox: number,
  oy: number,
  zOff: number,
): string[] {
  // Same resolver as the finish pass — which is the point. The encoding is read
  // from the image both ops share, so it cannot be typed into one and not the other.
  const enc = reliefEncodingFor(ent, rawOp);
  const op = enc.op;
  const grid = getImageGrid(ent.imageId);
  if (!grid) return [`; NOTE: image (${ent.id}) pixels not loaded — skipped`];

  const maxDepth = Math.abs(op.depth);
  if (maxDepth <= 0)
    return [`; NOTE: relief roughing depth is 0 — set a cut depth; image ${ent.id} skipped`];
  const allowance = Math.max(0, op.finishAllowance ?? 0);
  if (maxDepth - allowance <= 1e-6)
    return [
      `; NOTE: relief depth (${maxDepth}mm) ≤ finish allowance (${allowance}mm) — nothing to rough; the finish pass cuts it all. image ${ent.id} skipped`,
    ];

  const stepdown = op.stepdown > 0 ? op.stepdown : maxDepth;
  // stepover is a fraction of tool diameter (like a pocket); the coarse raster
  // pitch is that radial engagement in mm.
  const pitch = Math.max(0.05, (op.stepover > 0 ? op.stepover : DEFAULTS.stepover) * op.diameter);

  // Coarse square grid at the tool's stepover.
  const field = rasterField(grid, enc.field(pitch, pitch));
  if (field.rows.length === 0)
    return [
      `; NOTE: relief roughing produced nothing (blank or zero size) — image ${ent.id} skipped`,
    ];

  // Backs the allowance off the target and then dilates by the roughing tool's
  // own footprint — a ⌀6 end mill cannot drop into a 2mm-wide well however deep
  // the image says it is. Both are folded into the level, so a cell's level IS
  // the depth roughing may reach.
  const { cols, colPitch, rows } = toolContactField(field, op, maxDepth, allowance);
  const xf = makeRasterXf(ent.position, ent.angle);
  const lines: string[] = [];

  // Rest machining: cut only where the earlier, bigger tool left more than its
  // own staircase behind. The mask is constant across passes, which is what
  // preserves this emitter's standing invariant — a deeper plane's cut region is
  // a subset of the one above it, so each plunge only takes one stepdown of new
  // material even inside a rest region.
  const rest = reliefRest(field, op, maxDepth, stepdown, allowance);
  if (rest.kind === "not-larger")
    return [
      `; NOTE: rest machining needs a previous tool LARGER than this one ` +
        `(previous dia ${n(rest.prevDiameter)}mm, this dia ${n(op.diameter)}mm) — skipped`,
    ];
  if (rest.kind === "clear")
    return [
      `; NOTE: nothing to rest machine — a dia ${n(rest.prevDiameter)}mm tool already reached ` +
        `everything this dia ${n(op.diameter)}mm one could take on this relief`,
    ];
  if (rest.kind === "mask")
    lines.push(
      `; rest machining after dia ${n(rest.prevDiameter)}mm (assumed flat): ${rest.cells} of ` +
        `${rest.total} cells hold more than one ${n(stepdown)}mm stepdown, deepest ` +
        `${n(rest.maxLeftoverMM)}mm`,
    );

  if (op.toolType === "v-bit" || op.toolType === "ball-nose")
    lines.push(
      `; NOTE: roughing with a ${op.toolType} works but is slow — a flat or bull-nose end mill clears bulk faster (save the ball-nose for the finish pass)`,
    );

  // Rough surface per cell. The allowance and the tool footprint are already in
  // the level (see above), and 0 still means "leave at the stock top, never cut".
  const roughSurf = (level: number) => -level * maxDepth;
  const deepest = -(maxDepth - allowance); // deepest plane needed
  const nPasses = Math.max(1, Math.ceil((maxDepth - allowance) / stepdown));
  const RC = RAMP_CLEAR; // hop height above stock top
  const eps = levelDepthEps(maxDepth); // levels are float32 — see the helper

  lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
  let firstRun = true; // first traverse clears fixtures at safeZ
  for (let p = 1; p <= nPasses; p++) {
    const zP = Math.max(-p * stepdown, deepest); // this pass's flat cutting plane
    const zPrev = p === 1 ? RC : Math.max(-(p - 1) * stepdown, deepest); // cleared floor just above zP
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const ltr = r % 2 === 0;
      // Emit runs of consecutive in-mask cells; runFrom is the scan-order START.
      let runFrom = -1,
        runTo = -1;
      const flush = () => {
        if (runFrom < 0) return;
        const a = xfPoint(xf, (runFrom + 0.5) * colPitch, row.y); // cut runFrom → runTo (boustrophedon)
        const b = xfPoint(xf, (runTo + 0.5) * colPitch, row.y);
        const hop = firstRun ? op.safeZ : RC;
        lines.push(`G0 Z${Z(hop, zOff)}`); // lift over the gap
        lines.push(`G0 X${X(a.x, ox)} Y${Y(a.y, oy)}`);
        if (zPrev !== hop) lines.push(`G0 Z${Z(zPrev, zOff)}`); // rapid down onto the prior-pass floor
        // Enter with a ramp along the run (spreads the plunge load off the tool tip)
        // when there's length for it; otherwise a short run just plunges straight.
        const L = Math.hypot(b.x - a.x, b.y - a.y);
        const rampDist =
          (zPrev - zP) / Math.tan((rampAngleDeg(op, ROUGH_RAMP_DEG) * Math.PI) / 180);
        if (L > rampDist && rampDist > 1e-6) {
          const t = rampDist / L; // ramp to full depth over rampDist of a→b
          const rx = a.x + (b.x - a.x) * t,
            ry = a.y + (b.y - a.y) * t;
          lines.push(`G1 X${X(rx, ox)} Y${Y(ry, oy)} Z${Z(zP, zOff)} F${n(op.plungeRate)}`); // descending ramp
          lines.push(`G1 X${X(b.x, ox)} Y${Y(b.y, oy)} F${n(op.feedrate)}`); // flat cut remainder
        } else {
          lines.push(`G1 Z${Z(zP, zOff)} F${n(op.plungeRate)}`); // too short to ramp — straight plunge
          lines.push(`G1 X${X(b.x, ox)} Y${Y(b.y, oy)} F${n(op.feedrate)}`);
        }
        firstRun = false;
        runFrom = runTo = -1;
      };
      for (let k = 0; k < cols; k++) {
        const c = ltr ? k : cols - 1 - k;
        if (roughSurf(row.levels[c]) <= zP + eps && (rest.kind !== "mask" || rest.keep(r, c))) {
          // material present at this plane, and this operation's to take
          if (runFrom < 0) runFrom = c;
          runTo = c;
        } else flush();
      }
      flush();
    }
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
  cx: number,
  cy: number,
  op: CAMOperation,
  ox: number,
  oy: number,
  zOff: number,
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
  verts: Vec2[],
  op: CAMOperation,
  ox: number,
  oy: number,
  zOff: number,
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
  verts: Vec2[],
  op: CAMOperation,
  ox: number,
  oy: number,
  zOff: number,
): string[] {
  const cop = { ...op, depth: chamferDepth(op) };
  const lines: string[] = [];
  for (const path of chamferOffsets(verts, op))
    lines.push(
      ...(op.sharpenCorners
        ? chamferContourSharp(path, op, ox, oy, zOff)
        : engravePoints(path, true, cop, ox, oy, zOff)),
    );
  return lines;
}

/** Chamfer a circle: trace a circle shifted per side at the derived depth. */
function chamferCircle(
  cx: number,
  cy: number,
  r: number,
  op: CAMOperation,
  ox: number,
  oy: number,
  zOff: number,
): string[] {
  const cop = { ...op, depth: chamferDepth(op) };
  const w = op.chamferWidth ?? 0;
  const radius =
    op.chamferSide === "outside" ? r + w : op.chamferSide === "inside" ? Math.max(0.01, r - w) : r;
  return engraveCircle(cx, cy, radius, cop, ox, oy, zOff);
}

// --- v-carve -----------------------------------------------------------------

/**
 * Emit G-code for one carved region: peel it into depth passes (shallow→deep)
 * and follow each pass's contours at its depth.
 *
 * Between contours the bit retracts to `safeZ` by default. If the op opts in via
 * `vHopClearance` (mm above the stock surface), the *in-region* hops use that low
 * height instead — saving the full-height retract between every nested ring (a
 * big air-time win on text/concentric peels). That trade is the user's to make:
 * a low hop only clears the stock the rapid passes over, NOT a hold-down clamp or
 * fixture standing above the stock within the carve's footprint — which is why it
 * is off unless asked for. The first approach and final park always use `safeZ`.
 */
function vcarveRegionGcode(
  region: CarveRegion,
  op: CAMOperation,
  ox: number,
  oy: number,
  zOff: number,
): string[] {
  const passes = vcarveRegion(region.outer, region.holes, vcarveParamsForOp(op));
  if (passes.length === 0) return [];
  const lines: string[] = [];
  // In-region hop height: the opted-in low clearance, else a full safe-Z retract.
  const hopZ = op.vHopClearance && op.vHopClearance > 0 ? op.vHopClearance : op.safeZ;
  let first = true;
  for (const pass of passes) {
    for (const loop of pass.loops) {
      if (loop.length < 2) continue;
      const s = loop[0];
      lines.push(`G0 Z${Z(first ? op.safeZ : hopZ, zOff)}`);
      lines.push(`G0 X${X(s.x, ox)} Y${Y(s.y, oy)}`);
      lines.push(`G1 Z${Z(pass.depth, zOff)} F${n(op.plungeRate)}`);
      for (let i = 1; i < loop.length; i++) {
        const f = i === 1 ? ` F${n(op.feedrate)}` : "";
        lines.push(`G1 X${X(loop[i].x, ox)} Y${Y(loop[i].y, oy)}${f}`);
      }
      lines.push(`G1 X${X(s.x, ox)} Y${Y(s.y, oy)}`); // close the ring
      first = false;
    }
  }
  lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
  return lines;
}

// --- toolpath body (no spindle/tool-change preamble) -------------------------

function toolpathBody(
  op: CAMOperation,
  doc: CADDocument,
  ox: number,
  oy: number,
  zOff: number,
  pp: PostProcessor,
  /** Machine travel envelope, for facing the bed. Absent when unconfigured. */
  bed?: { width: number; height: number } | null,
): string[] {
  const lines: string[] = [];
  const entityMap = machinableEntityMap(doc);

  // A chamfer needs a V-bit (the bevel angle comes from the tool) and a width.
  if (op.type === "chamfer") {
    if (op.toolType !== "v-bit") return [`; NOTE: chamfer requires a V-bit tool — skipped`];
    if ((op.chamferWidth ?? 0) <= 0) return [`; NOTE: chamfer width is 0 — skipped`];
    // A V-bit can only cut a face as wide as its cutting radius (the half of the
    // cutting diameter at the top of the V); past that the requested bevel runs
    // off the cutting edge into the shank.
    const cuttingR = op.diameter / 2;
    if ((op.chamferWidth ?? 0) > cuttingR)
      lines.push(
        `; NOTE: chamfer face ${op.chamferWidth}mm exceeds the V-bit's cutting radius ${n(cuttingR)}mm (⌀${op.diameter}mm cutting diameter) — the bit can't cut a face this wide; use a larger-diameter bit or reduce the width`,
      );
    const d = chamferDepth(op);
    if (-d > doc.stockThickness)
      lines.push(
        `; NOTE: chamfer depth ${n(-d)}mm exceeds stock thickness ${n(doc.stockThickness)}mm — reduce the chamfer width or use a wider-angle bit`,
      );
    lines.push(
      `; Chamfer: ⌀ V-bit ${op.vAngle ?? 60}° · face ${op.chamferWidth}mm → depth ${n(d)}mm (${op.chamferSide ?? "on"})`,
    );
  }

  // A v-carve needs a V-bit — the slope of the cut comes from the bit's angle.
  if (op.type === "vcarve" && op.toolType !== "v-bit")
    return [`; NOTE: v-carve requires a V-bit tool — skipped`];

  /** Human/AI-readable summary of a region ref for skip NOTEs. */
  const describeRegionRef = (ref: { containingLoops: string[][] }): string =>
    `[${ref.containingLoops.map((ids) => ids.join("+")).join(", ")}]`;

  // Region v-carves: resolve each parametric region against live geometry (its
  // enclosed loops become counters/holes) and peel-carve it. Mirrors region
  // pockets and supersedes any entity-based fallback for picked regions.
  if (op.type === "vcarve" && op.regions && op.regions.length > 0) {
    const loops = collectClosedLoops(doc.entities);
    for (const ref of op.regions) {
      const region = resolveRegion(ref, loops);
      if (!region) {
        lines.push(
          `; NOTE: v-carve region ${describeRegionRef(ref)} could not be resolved — its boundary ids must name existing geometry forming closed loop(s) — skipped`,
        );
        continue;
      }
      lines.push(
        ...vcarveRegionGcode({ outer: region.outer, holes: region.holes }, op, ox, oy, zOff),
      );
    }
    return lines;
  }

  // Facing takes its extent from the job, not from geometry — it is the one
  // operation with nothing drawn to point at, so it is handled before the loop
  // over entityIds below (which would find none and emit nothing).
  if (op.type === "face") {
    return faceSurface(op, doc, ox, oy, zOff, bed);
  }

  // Region pockets: resolve each parametric region against live geometry and
  // pocket it (enclosed loops become islands). Supersedes the legacy
  // entityIds/islandIds pocket path.
  if (op.type === "pocket" && op.regions && op.regions.length > 0) {
    const loops = collectClosedLoops(doc.entities);
    for (const ref of op.regions) {
      const region = resolveRegion(ref, loops);
      if (!region) {
        lines.push(
          `; NOTE: pocket region ${describeRegionRef(ref)} could not be resolved — its boundary ids must name existing geometry forming closed loop(s) — skipped`,
        );
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
        const nSegs = Math.max(64, Math.ceil((2 * Math.PI * e.radius) / 0.5));
        islands.push(
          Array.from({ length: nSegs }, (_, i) => {
            const a = (i / nSegs) * 2 * Math.PI;
            return {
              x: e.center.x + e.radius * Math.cos(a),
              y: e.center.y + e.radius * Math.sin(a),
            };
          }),
        );
      } else if (e instanceof RectEntity) {
        islands.push(e.outlinePoints());
      } else if (e instanceof PolylineEntity && e.closed) {
        islands.push(e.outlinePoints());
      }
    }
    // Also chain any line segments in the island set into closed polygons.
    const islandLineEnts = [...islandSet]
      .map((id) => entityMap.get(id))
      .filter((e): e is LineEntity => e instanceof LineEntity && !e.isConstruction);
    for (const { verts } of chainLinesIntoPolygons(islandLineEnts).polygons) islands.push(verts);
    lines.push(`; islands: ${islands.length} polygon(s) from ${islandSet.size} entity id(s)`);
  }

  // For profile/pocket/chamfer ops, chain the selected open curves (lines,
  // arcs, beziers, open polylines) into closed loops and cut each loop as one
  // contour — so a rounded-rectangle outline authored as 4 lines + 4 fillet
  // arcs profiles as a single closed shape. Loose lines never cut alone and
  // are noted; other unchained open curves fall through to the per-entity
  // handling below (e.g. chamfer's open-edge bevel).
  const chainedIds = new Set<string>();
  if (
    op.type === "profile" ||
    op.type === "pocket" ||
    op.type === "chamfer" ||
    op.type === "vcarve"
  ) {
    const candidates = op.entityIds
      .filter((id) => !islandSet.has(id))
      .map((id) => entityMap.get(id))
      .filter((e): e is Entity => !!e && !e.isConstruction);
    const { loops, leftover } = chainOpenCurvesIntoLoops(candidates);
    for (const { verts, ids } of loops) {
      if (op.type === "pocket") lines.push(...pocketPolygon(verts, islands, op, ox, oy, zOff));
      else if (op.type === "chamfer") lines.push(...chamferPolygon(verts, op, ox, oy, zOff));
      else if (op.type === "vcarve")
        lines.push(...vcarveRegionGcode({ outer: verts, holes: [] }, op, ox, oy, zOff));
      else lines.push(...profilePolygon(verts, op, ox, oy, zOff, doc.stockThickness));
      for (const id of ids) chainedIds.add(id);
    }
    const looseLines = leftover.filter((e): e is LineEntity => e instanceof LineEntity);
    if (looseLines.length > 0) {
      lines.push(
        `; NOTE: ${looseLines.length} selected line(s) do not form a closed polygon — skipped`,
      );
      for (const e of looseLines) chainedIds.add(e.id);
    }
  }

  let firstDrill = true;
  for (const id of op.entityIds) {
    if (chainedIds.has(id) || islandSet.has(id)) continue;
    const ent = entityMap.get(id);
    if (!ent || ent.isConstruction) continue;

    if (op.type === "drill") {
      if (ent instanceof CircleEntity) {
        // Establish safe Z once, before the first hole, then peck each hole.
        if (firstDrill) {
          lines.push(`G0 Z${Z(op.safeZ, zOff)}`);
          firstDrill = false;
        }
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
      // V-carve and pocket need the glyphs grouped into solids-with-counters so the holes
      // (e.g. the centre of an "O") are carved as holes, not filled.
      if (op.type === "vcarve" || op.type === "pocket") {
        for (const region of groupContoursIntoRegions(contours.map((c) => c.points))) {
          if (op.type === "vcarve") lines.push(...vcarveRegionGcode(region, op, ox, oy, zOff));
          else lines.push(...pocketPolygon(region.outer, [...region.holes, ...islands], op, ox, oy, zOff));
        }
        continue;
      }
      for (const c of contours) {
        if (op.type === "engrave")
          lines.push(...engravePoints(c.points, c.closed, op, ox, oy, zOff));
        else if (op.type === "chamfer" && c.closed)
          lines.push(...chamferPolygon(c.points, op, ox, oy, zOff));
        else if (op.type === "profile" && c.closed)
          lines.push(...profilePolygon(c.points, op, ox, oy, zOff, doc.stockThickness));
      }
      continue;
    }

    // V-carve a directly-selected closed shape as a region with no holes. (Picked
    // regions with counters go through the region block above.)
    if (op.type === "vcarve") {
      let outer: Vec2[] | null = null;
      if (ent instanceof RectEntity) outer = ent.outlinePoints();
      else if (ent instanceof PolylineEntity && ent.closed) outer = ent.outlinePoints();
      else if (ent instanceof CircleEntity) {
        const nSegs = Math.max(64, Math.ceil((2 * Math.PI * ent.radius) / 0.5));
        outer = Array.from({ length: nSegs }, (_, i) => {
          const a = (i / nSegs) * 2 * Math.PI;
          return {
            x: ent.center.x + ent.radius * Math.cos(a),
            y: ent.center.y + ent.radius * Math.sin(a),
          };
        });
      }
      if (outer) lines.push(...vcarveRegionGcode({ outer, holes: [] }, op, ox, oy, zOff));
      else
        lines.push(
          `; NOTE: v-carve needs a closed shape (rect, circle, closed polyline, text, or a picked region) — entity ${ent.id} skipped`,
        );
      continue;
    }

    if (op.type === "chamfer") {
      const cop = { ...op, depth: chamferDepth(op) };
      if (ent instanceof CircleEntity)
        lines.push(...chamferCircle(ent.center.x, ent.center.y, ent.radius, op, ox, oy, zOff));
      else if (ent instanceof RectEntity)
        lines.push(...chamferPolygon(ent.outlinePoints(), op, ox, oy, zOff));
      else if (ent instanceof PolylineEntity && ent.closed)
        lines.push(...chamferPolygon(ent.outlinePoints(), op, ox, oy, zOff));
      else if (ent instanceof PolylineEntity)
        lines.push(...engravePoints(ent.outlinePoints(), false, cop, ox, oy, zOff)); // open edge, centred
      else if (ent instanceof LineEntity)
        lines.push(...engravePoints([ent.a, ent.b], false, cop, ox, oy, zOff));
      else if (ent instanceof ArcEntity) lines.push(...engraveArc(ent, cop, ox, oy, zOff));
      else if (ent instanceof BezierEntity)
        lines.push(...pp.engraveBezier(ent.p0, ent.p1, ent.p2, ent.p3, cop, ox, oy, zOff));
      continue;
    }

    if (op.type === "relief-rough") {
      if (ent instanceof RasterImageEntity)
        // Append element-wise (not push(...)): roughing can emit 100k+ lines.
        for (const l of reliefRoughImage(ent, op, ox, oy, zOff)) lines.push(l);
      else
        lines.push(
          `; NOTE: relief roughing targets a greyscale image — entity ${ent.id} (${ent.type}) skipped`,
        );
      continue;
    }

    if (op.type === "engrave") {
      if (ent instanceof RasterImageEntity)
        // Append element-wise, NOT push(...): a relief can emit 100k+ lines and
        // spreading that as call args overflows the stack (same trap as laser).
        for (const l of reliefImage(ent, op, ox, oy, zOff)) lines.push(l);
      else if (ent instanceof LineEntity)
        lines.push(...engravePoints([ent.a, ent.b], false, op, ox, oy, zOff));
      else if (ent instanceof CircleEntity)
        lines.push(...engraveCircle(ent.center.x, ent.center.y, ent.radius, op, ox, oy, zOff));
      else if (ent instanceof RectEntity)
        lines.push(...engravePoints(ent.outlinePoints(), true, op, ox, oy, zOff));
      else if (ent instanceof PolylineEntity)
        lines.push(...engravePoints(ent.outlinePoints(), ent.closed, op, ox, oy, zOff));
      else if (ent instanceof ArcEntity) lines.push(...engraveArc(ent, op, ox, oy, zOff));
      else if (ent instanceof BezierEntity)
        lines.push(...pp.engraveBezier(ent.p0, ent.p1, ent.p2, ent.p3, op, ox, oy, zOff));
      continue;
    }

    // profile / pocket
    if (op.type === "pocket") {
      if (ent instanceof CircleEntity)
        lines.push(
          ...pocketCircle(ent.center.x, ent.center.y, ent.radius, islands, op, ox, oy, zOff),
        );
      else if (ent instanceof RectEntity)
        lines.push(...pocketPolygon(ent.outlinePoints(), islands, op, ox, oy, zOff));
      else if (ent instanceof PolylineEntity && ent.closed)
        lines.push(...pocketPolygon(ent.outlinePoints(), islands, op, ox, oy, zOff));
      else if (ent instanceof ArcEntity)
        lines.push(
          `; NOTE: arc (${ent.id}) skipped — pocket requires a closed region (use a closed loop or region pick)`,
        );
    } else {
      if (ent instanceof CircleEntity)
        lines.push(...profileCircle(ent.center.x, ent.center.y, ent.radius, op, ox, oy, zOff));
      else if (ent instanceof RectEntity)
        lines.push(...profilePolygon(ent.outlinePoints(), op, ox, oy, zOff, doc.stockThickness));
      else if (ent instanceof PolylineEntity && ent.closed)
        lines.push(...profilePolygon(ent.outlinePoints(), op, ox, oy, zOff, doc.stockThickness));
      else if (ent instanceof PolylineEntity)
        lines.push(`; NOTE: open polyline (${ent.id}) skipped — profile requires closed geometry`);
      else if (ent instanceof LineEntity)
        lines.push("; NOTE: open line skipped — profile requires closed geometry");
      else if (ent instanceof ArcEntity)
        lines.push(
          `; NOTE: arc (${ent.id}) skipped — profile requires closed geometry (use engrave for an open arc)`,
        );
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
  /** Laser only: controller max power (GRBL `$30`) that 100% maps to. Default 1000. */
  laserMaxPower?: number;
  /**
   * Post-processor id for this machine. Machine configuration, so it arrives as
   * an option rather than off the document — a `.rcam` is a drawing and must not
   * carry the author's controller (see SETTINGS_MODEL.md). Unset falls back to
   * the head's default, which keeps direct generator calls (tests, fixtures)
   * working without a profile.
   */
  postProcessor?: string;
  /** Machine has an automatic tool changer: emit T/M6 rather than pausing. */
  hasToolChanger?: boolean;
  /** Rotary only: which axis word this machine's 4th axis answers to. */
  rotaryAxisWord?: "A" | "B";
  /** Rotary only: chord tolerance (mm) for flattening arcs into the wrap. */
  arcTolerance?: number;
  /**
   * Machine travel envelope (mm), or null/absent when the user hasn't set one.
   * Not used to GENERATE anything — it reaches the pre-flight fit check, which
   * is part of producing a program, so it rides the same machine channel.
   */
  bed?: { width: number; height: number } | null;
}

/** Split a multi-line custom block into trimmed, non-empty-trailing lines. */
function customLines(block: string | undefined): string[] {
  if (!block?.trim()) return [];
  return block.replace(/\s+$/, "").split(/\r?\n/);
}

export function generateGCode(
  rawOps: CAMOperation[],
  doc: CADDocument,
  opts: GCodeOptions = {},
): string {
  // Laser machines have no spindle/Z — route to the fixed-Z beam generator,
  // which reuses the same XY geometry but emits beam on/off instead.
  if (doc.isLaser) {
    return generateLaserGCode(rawOps, doc, {
      customStart: opts.customStart,
      customEnd: opts.customEnd,
      laserMaxPower: opts.laserMaxPower,
      postProcessor: opts.postProcessor,
    });
  }

  if (rawOps.length === 0) return "; No toolpaths\nM30\n";

  // Expand pattern targets (so a toolpath follows its pattern's count), then
  // resolve each op's tool reference up front so every downstream read of
  // op.diameter/feedrate/etc. sees the embedded tool's values when toolId is set.
  const ops = rawOps.map((op) => resolveOpTool(expandOpPatternTargets(op, doc), doc.tools));

  const { ox, oy, zOffset } = resolveOrigin(doc);
  const foot = stockFootprint(doc);
  // Machine configuration, not document state: the post arrives via options so
  // a shared design never carries the author's controller. Unset = the mill
  // default, which keeps direct generator calls working without a profile.
  const pp = getPostProcessor(opts.postProcessor ?? "linuxcnc");

  const xLabel = { left: "Left", center: "Center", right: "Right" }[doc.origin.x];
  const yLabel = { front: "Front", center: "Center", back: "Back" }[doc.origin.y];
  // A cylinder is always surface-zeroed (no bed) — mirror resolveOrigin so the
  // header label and the inter-op safe-Z retract don't apply a bed offset to it.
  const bedZero = doc.origin.z === "bed" && doc.stock.kind !== "cylinder";
  const zLabel = bedZero ? `Bed (top at Z=${n(doc.stockThickness)}mm)` : "Top of stock";

  const toolsSeen = new Map<number, CAMOperation>();
  for (const op of ops) {
    if (!toolsSeen.has(op.toolNumber)) toolsSeen.set(op.toolNumber, op);
  }
  const toolSummary = [...toolsSeen.entries()]
    .sort(([a], [b]) => a - b)
    .map(([t, op]) => {
      const tl =
        op.toolType === "v-bit"
          ? `V-Bit(${op.vAngle ?? 60}°)`
          : op.toolType === "ball-nose"
            ? "BallNose"
            : op.toolType === "drill"
              ? "Drill"
              : "EndMill";
      return `T${t} ⌀${op.diameter}mm ${tl} ${op.spindleSpeed}rpm`;
    })
    .join(", ");

  const md = doc.metadata ?? {};
  const metaLines: string[] = [];
  if (md.job?.trim()) metaLines.push(`; Job: ${md.job.trim()}`);
  if (md.revision?.trim()) metaLines.push(`; Revision: ${md.revision.trim()}`);
  if (md.notes?.trim()) metaLines.push(`; Notes: ${md.notes.trim().replace(/\r?\n/g, " ")}`);

  const lines: string[] = [
    "; RapidCAM generated G-code - https://rapidcam.app",
    ...metaLines,
    `; Post-processor: ${pp.name}`,
    `; ${ops.length} toolpath${ops.length !== 1 ? "s" : ""}`,
    `; WCS origin X: ${xLabel}  Y: ${yLabel}  Z: ${zLabel}`,
    // Rounded (not the raw values): a rotary job's wrapped dimension is
    // Math.PI * diameter, an irrational number that otherwise prints its full
    // float precision straight into the header (e.g. "188.49555921538757").
    `; Stock: ${n(foot.width)} × ${n(foot.height)} × ${n(doc.stockThickness)}mm`,
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
    m === "mist" ? "M7 ; mist coolant on" : m === "flood" ? "M8 ; flood coolant on" : null;
  let currentCoolant: CoolantMode = "off";

  let currentTool: number | null = null;
  let currentSpeed: number | null = null;

  for (const op of ops) {
    const toolChanged = op.toolNumber !== currentTool;
    const speedChanged = op.spindleSpeed !== currentSpeed;
    const isFirst = currentTool === null;

    if (toolChanged || isFirst) {
      if (!isFirst) {
        lines.push(`G0 Z${n(op.safeZ + (bedZero ? doc.stockThickness : 0))}`);
        if (currentCoolant !== "off") {
          lines.push("M9 ; coolant off");
          currentCoolant = "off";
        }
        lines.push("M5 ; spindle stop");
      }

      if (opts.hasToolChanger) {
        lines.push(`T${op.toolNumber} M6 ; tool change`);
      } else if (!isFirst && toolChanged) {
        // Rapid to the park position (work coords, already at safe Z) so the
        // operator can reach the spindle for the swap.
        if (doc.toolChangePosition) {
          const tp = doc.toolChangePosition;
          lines.push(`G0 X${n(tp.x)} Y${n(tp.y)} ; park for tool change`);
        }
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
      op.type === "profile"
        ? `Profile (${op.side})`
        : op.type === "pocket"
          ? "Pocket"
          : op.type === "engrave"
            ? "Engrave"
            : op.type === "vcarve"
              ? "V-Carve"
              : op.type === "chamfer"
                ? "Chamfer"
                : op.type === "relief-rough"
                  ? "Relief Roughing"
                  : "Drill";
    const toolLabel =
      op.toolType === "v-bit"
        ? `V-Bit(${op.vAngle ?? 60}°)`
        : op.toolType === "ball-nose"
          ? "Ball Nose"
          : op.toolType === "drill"
            ? `Drill(tip ${op.tipAngle ?? 118}°)`
            : "End Mill";
    lines.push(
      `; --- ${typeLabel} "${op.name}"  T${op.toolNumber} ⌀${op.diameter}mm ${toolLabel}  depth:${op.depth}mm ---`,
    );
    if (op.toolType === "v-bit" && op.type === "engrave") {
      const halfAngle = ((op.vAngle ?? 60) / 2) * (Math.PI / 180);
      const width = (2 * Math.abs(op.depth) * Math.tan(halfAngle)).toFixed(3);
      lines.push(`; V-Bit effective cut width at ${op.depth}mm: ${width}mm`);
    }
    for (const l of toolpathBody(op, doc, ox, oy, zOffset, pp, opts.bed)) lines.push(l); // not spread: a relief op can emit 100k+ lines
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
  insertTimeEstimateComment(lines);
  return toAsciiGcode(lines.join("\n"));
}
