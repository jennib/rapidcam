/**
 * Adaptive (engagement-limited) pocket clearing.
 *
 * Contour-parallel clearing spaces its loops a fixed distance apart, which sets
 * the radial load only where the wall is straight. Measured on a 40mm square
 * pocket with a 3.175mm cutter at a 1.27mm stepover (see
 * test/adaptiveClearing.test.ts, which measures rather than assumes):
 *
 *   nominal straight-wall load   157°
 *   innermost loop               360°   ← a closed slot in solid material
 *   every loop with a corner     245°
 *   a neck narrower than 2 loops 360°
 *
 * The 360° cases are the ones that break cutters: the tool is buried on all
 * sides with nowhere for chips to go. They are not a defect in the offset code,
 * they are what an offset loop *is* the first time it enters uncut stock.
 *
 * This module keeps the same loop topology — offsets handle islands, splitting
 * and merging for free — and changes what happens where the load would exceed
 * the straight-wall figure. There, the loop is replaced by trochoidal passes:
 * overlapping circles advancing along it, each one shaving a crescent as wide as
 * the stepover and no wider. The load is then set by the advance per circle
 * instead of by the shape of the wall.
 *
 * Engagement is measured, not predicted. A curvature formula was tried first and
 * disagreed with the simulator badly enough at a sharp corner (194° predicted,
 * 245° measured) to be worthless as a bound, so the generator walks candidate
 * positions against a Clipper model of the material still standing. The check
 * for whether that model is right lives in the tests, which run an independent
 * bitmap simulation and hold it against closed-form theory for a straight cut.
 */

import type { Vec2 } from "../core/vec2";
import { inflatePathsD, differenceD, unionD, JoinType, EndType, FillRule } from "clipper2-ts";
import { signedArea } from "./offset";
import type { ClearingMove } from "./clearing";
import { cuttableRegion, concentricRings } from "./clearing";

/**
 * Points sampled around the cutter when measuring how buried it is. 24 gives 15°
 * of resolution, which is finer than the overshoot being detected and half the
 * cost of 48.
 */
const PROBE_ANGLES = 24;

/** How far apart to test positions along a loop, as a fraction of tool radius. */
const WALK_STEP_FRACTION = 0.35;

/**
 * Allowed overshoot of the straight-wall load before a stretch is treated as
 * overloaded. Some slack is needed or the sampling noise of a discretised
 * measurement would trochoid the whole path.
 */
const OVERLOAD_TOLERANCE = 1.12;

/** Vertices used to draw one trochoidal circle. Arc-fitted again on the way out. */
const TROCHOID_SEGMENTS = 32;

const toV = (path: { x: number; y: number }[]): Vec2[] => path.map((p) => ({ x: p.x, y: p.y }));

function inflate(paths: Vec2[][], delta: number): Vec2[][] {
  const valid = paths.filter((p) => p.length >= 3);
  if (valid.length === 0) return [];
  return inflatePathsD(valid, delta, JoinType.Miter, EndType.Polygon, 4).map(toV);
}

/** Even-odd point-in-polygon. */
function inPolygon(pt: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Bounding box, cached per path array so it isn't recomputed per probe. */
const BBOX = new WeakMap<Vec2[], { x0: number; y0: number; x1: number; y1: number }>();
function bbox(p: Vec2[]): { x0: number; y0: number; x1: number; y1: number } {
  let b = BBOX.get(p);
  if (!b) {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const v of p) {
      if (v.x < x0) x0 = v.x;
      if (v.x > x1) x1 = v.x;
      if (v.y < y0) y0 = v.y;
      if (v.y > y1) y1 = v.y;
    }
    b = { x0, y0, x1, y1 };
    BBOX.set(p, b);
  }
  return b;
}

/**
 * Inside a set of Clipper paths, respecting holes by winding: a point inside an
 * odd number of paths is inside the set.
 *
 * The bounding-box reject matters: this runs tens of thousands of times per
 * pocket against polygons that carry hundreds of vertices after a boolean, and
 * it is most of what generation costs.
 */
function inPaths(pt: Vec2, paths: Vec2[][]): boolean {
  let n = 0;
  for (const p of paths) {
    if (p.length < 3) continue;
    const b = bbox(p);
    if (pt.x < b.x0 || pt.x > b.x1 || pt.y < b.y0 || pt.y > b.y1) continue;
    if (inPolygon(pt, p)) n++;
  }
  return n % 2 === 1;
}

/** The arc of the cutter's circumference sitting in `material`, in degrees. */
function engagementDeg(centre: Vec2, toolR: number, material: Vec2[][]): number {
  let hits = 0;
  for (let k = 0; k < PROBE_ANGLES; k++) {
    const a = (2 * Math.PI * k) / PROBE_ANGLES;
    const p = { x: centre.x + toolR * Math.cos(a), y: centre.y + toolR * Math.sin(a) };
    if (inPaths(p, material)) hits++;
  }
  return (hits / PROBE_ANGLES) * 360;
}

/** The load a straight wall step of `stepover` produces — the target everywhere. */
export function nominalEngagementDeg(toolR: number, stepover: number): number {
  const c = 1 - stepover / toolR;
  if (c <= -1) return 360;
  return (2 * Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
}

/** Resample a closed loop so successive points are at most `step` apart. */
function densifyLoop(loop: Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i],
      b = loop[(i + 1) % loop.length];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(d / step));
    for (let k = 0; k < n; k++) {
      out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
    }
  }
  return out;
}

/** The swept area of a run of tool positions: the path, fattened by the tool. */
function sweptArea(pts: Vec2[], toolR: number): Vec2[][] {
  if (pts.length === 0) return [];
  if (pts.length === 1) {
    return inflate([circlePoints(pts[0], 0.001, 8)], toolR);
  }
  return inflatePathsD([pts], toolR, JoinType.Round, EndType.Round, 4).map(toV);
}

function circlePoints(c: Vec2, r: number, n = TROCHOID_SEGMENTS): Vec2[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
  });
}

/** Largest radius at which a circle centred at `c` still keeps the tool legal. */
function fitRadius(c: Vec2, want: number, centreRegion: Vec2[][]): number {
  // The tool centre may never leave the cuttable region or the cutter gouges a
  // wall, so a trochoidal circle has to fit inside it. Shrink until it does.
  for (let r = want; r > want * 0.2; r *= 0.75) {
    let ok = true;
    for (const p of circlePoints(c, r, 12)) {
      if (!inPaths(p, centreRegion)) {
        ok = false;
        break;
      }
    }
    if (ok) return r;
  }
  return 0;
}

export interface AdaptiveOptions {
  /** Radial step, mm — the load this clearing holds itself to. */
  stepover: number;
  /** Radius of the trochoidal circles, mm. Defaults to 2× stepover. */
  trochoidRadius?: number;
}

/**
 * Generate engagement-limited clearing moves for a pocket.
 *
 * Returns the same {@link ClearingMove} shape the contour-parallel clearer does,
 * so the emitter treats both alike — but a move here may be an open path (a run
 * of trochoidal circles), which is why `closed` says which it is.
 */
export function adaptiveClear(
  outer: Vec2[],
  holes: Vec2[][],
  toolR: number,
  opts: AdaptiveOptions,
): ClearingMove[] {
  const stepover = opts.stepover;
  if (outer.length < 3 || toolR <= 0 || stepover <= 0) return [];

  const centreRegion = cuttableRegion(outer, holes, toolR);
  if (centreRegion.length === 0) return [];

  const rings = concentricRings(centreRegion, stepover);
  if (rings.length === 0) return [];

  // Material still standing, in material space (not tool-centre space).
  let material = holes.length
    ? differenceD([ccw(outer)], holes.map(ccw), FillRule.NonZero).map(toV)
    : [ccw(outer)];

  const limit = nominalEngagementDeg(toolR, stepover) * OVERLOAD_TOLERANCE;
  const trochR = opts.trochoidRadius ?? stepover * 2;
  const walkStep = Math.max(0.2, toolR * WALK_STEP_FRACTION);

  const moves: ClearingMove[] = [];

  // Innermost first, so the last cut is the outer wall — best surface finish,
  // same ordering rule the contour-parallel clearer uses.
  for (const ring of [...rings].sort((a, b) => b.k - a.k)) {
    const pts = densifyLoop(ring.loop, walkStep);
    if (pts.length < 3) continue;

    // Ring 0 is the wall itself, and it is cut last: everything inside it has
    // already gone, so it is removing exactly one stepover and is at the nominal
    // load by construction. Cut it as one continuous loop — trochoidal circles
    // there would both scallop the finished wall and have nowhere to loop into.
    const isWallPass = ring.k === 0;

    // Is the cutter, anywhere along this loop, more buried than a straight wall
    // step would bury it? Only the answer matters, not where — the whole loop is
    // trochoided either way — so this stops at the first hot point rather than
    // measuring every one of them. That single change took generation of a 40mm
    // pocket from 2.1s to well under a tenth of that: the innermost loops, which
    // are the ones that need trochoiding, go hot on their first sample.
    const hot = !isWallPass && pts.some((p) => engagementDeg(p, toolR, material) > limit);

    if (!hot) {
      // Nothing overloaded — cut it as an ordinary loop.
      moves.push({ loop: ring.loop.slice(), link: moves.length > 0, closed: true });
      material = subtract(material, sweptArea([...ring.loop, ring.loop[0]], toolR));
      continue;
    }

    // Overloaded somewhere. Trochoid the whole loop rather than stitching two
    // motions together mid-cut: the loop is one continuous pass either way, and
    // a tool that changes strategy halfway round leaves a witness mark where the
    // engagement steps.
    //
    // Each circle is its own move. That is what makes the load bounded — a
    // circle only ever eats the crescent between itself and the one before —
    // and it is also the only structure in which the load can be *measured*: a
    // whole run handed over as one pass double-counts the ground it cleared
    // itself.
    const circles = trochoidRun(pts, stepover, trochR, centreRegion);
    if (circles.length === 0) {
      moves.push({ loop: ring.loop.slice(), link: moves.length > 0, closed: true });
      material = subtract(material, sweptArea([...ring.loop, ring.loop[0]], toolR));
      continue;
    }
    for (const c of circles) {
      moves.push({ loop: c.pts, link: true, closed: c.closed });
      material = subtract(material, sweptArea(c.closed ? [...c.pts, c.pts[0]] : c.pts, toolR));
    }
  }

  return moves;
}

function ccw(pts: Vec2[]): Vec2[] {
  return signedArea(pts) >= 0 ? pts : [...pts].reverse();
}

function subtract(material: Vec2[][], swept: Vec2[][]): Vec2[][] {
  if (material.length === 0 || swept.length === 0) return material;
  const valid = material.filter((p) => p.length >= 3);
  const cut = swept.filter((p) => p.length >= 3);
  if (valid.length === 0 || cut.length === 0) return material;
  return differenceD(valid, cut, FillRule.NonZero).map(toV);
}

/**
 * Trochoidal pass along `pts`: circles of radius `trochR` centred on the path,
 * advancing by `pitch` between one and the next. Each circle removes a crescent
 * as wide as the advance, so the advance — not the shape of the wall — is what
 * sets the load.
 */
function trochoidRun(
  pts: Vec2[],
  pitch: number,
  trochR: number,
  centreRegion: Vec2[][],
): { pts: Vec2[]; closed: boolean }[] {
  const out: { pts: Vec2[]; closed: boolean }[] = [];
  let carried = pitch; // emit on the first point
  let prev: Vec2 | null = null;
  let last: Vec2 | null = null;

  for (const p of pts) {
    if (prev) carried += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
    if (carried < pitch) continue;
    carried = 0;

    const r = fitRadius(p, trochR, centreRegion);
    if (r <= 0) {
      // No room to loop here (a neck barely wider than the cutter). Follow the
      // path itself: it is a slot, and no toolpath can make it not one — only a
      // smaller cutter can. It has to be followed CONTINUOUSLY: emitting a point
      // every pitch leaves a scallop between one tool position and the next, and
      // that was a 0.75mm ridge of uncut stock down the wall.
      const open = out[out.length - 1];
      if (open && !open.closed) open.pts.push(p);
      else out.push({ pts: [p], closed: false });
      last = p;
      continue;
    }
    // Start each circle at the point nearest the previous position so the link
    // between circles is short.
    // Annotated because `last` is assigned from `circle[0]` below: without it,
    // the type of each depends on the other and inference gives up.
    const startAngle: number = last ? Math.atan2(last.y - p.y, last.x - p.x) : 0;
    const circle: Vec2[] = Array.from({ length: TROCHOID_SEGMENTS }, (_, i) => {
      const a = startAngle + (2 * Math.PI * i) / TROCHOID_SEGMENTS;
      return { x: p.x + r * Math.cos(a), y: p.y + r * Math.sin(a) };
    });
    out.push({ pts: circle, closed: true });
    last = circle[0];
  }
  return out;
}

/** Union helper kept for callers that need the swept area of a whole plan. */
export function unionAreas(paths: Vec2[][]): Vec2[][] {
  const valid = paths.filter((p) => p.length >= 3);
  if (valid.length === 0) return [];
  return unionD(valid, FillRule.NonZero).map(toV);
}
