/**
 * Stitch phase 2b — clip a finished toolpath to one tile.
 *
 * Given a parsed program (see gcodeMotion) and a tile rectangle in the program's
 * own coordinate space, this keeps only the cutting that falls inside the tile,
 * re-entering the material with a straight plunge wherever a cut path crosses a
 * seam. Arcs are linearized to fine chords so they clip cleanly. Pass-through
 * lines (setup, spindle, tool changes, comments) are preserved in order.
 *
 * Seam entry is a plunge at plunge-rate — the same entry the generator already
 * uses at every contour start, and full-depth exactly where this tile's edge
 * must meet the neighbouring tile's. Rapids are regenerated per in-tile run, so
 * the tool never traverses at cutting depth across an excluded region.
 *
 * Scope: 2.5D toolpaths (profile / pocket / engrave / drill). Continuously
 * varying-Z paths (relief, v-carve, helical) still clip, but their entry is
 * approximated by a plunge to the run's first depth — {@link clipProgramToTile}
 * reports them via `warnings` so the export can caution the user.
 */

import type { Vec2 } from "../core/vec2";
import type { Bounds } from "../model/entities";
import { type GProgram, type GMoveEvent, type GEvent, parseProgram } from "./gcodeMotion";

interface P3 {
  x: number;
  y: number;
  z: number;
}

/** Max chord error (mm) when linearizing an arc for clipping. */
const ARC_CHORD_TOL = 0.02;
/** A run whose Z spans more than this (mm) is a 3D path, not flat 2.5D. */
const FLAT_Z_TOL = 0.01;

// ---------------------------------------------------------------------------
// Arc linearization
// ---------------------------------------------------------------------------

/** Points along a G2 (cw) / G3 (ccw) arc from `start` to the move's end, end inclusive. */
function linearizeArc(start: P3, m: GMoveEvent): P3[] {
  const cx = start.x + (m.i ?? 0);
  const cy = start.y + (m.j ?? 0);
  const r = Math.hypot(start.x - cx, start.y - cy);
  if (r < 1e-9) return [{ x: m.x, y: m.y, z: m.z }];

  const a0 = Math.atan2(start.y - cy, start.x - cx);
  const a1 = Math.atan2(m.y - cy, m.x - cx);
  const cw = m.motion === 2;
  let sweep = a1 - a0;
  // Normalize to the correct direction; a full loop (start==end) sweeps 2π.
  if (cw) {
    while (sweep > -1e-9) sweep -= 2 * Math.PI;
  } else {
    while (sweep < 1e-9) sweep += 2 * Math.PI;
  }

  const steps = Math.max(
    1,
    Math.ceil(Math.abs(sweep) / (2 * Math.acos(Math.max(0, 1 - ARC_CHORD_TOL / r)))),
  );
  const pts: P3[] = [];
  for (let k = 1; k <= steps; k++) {
    const t = k / steps;
    const a = a0 + sweep * t;
    pts.push({
      x: cx + r * Math.cos(a),
      y: cy + r * Math.sin(a),
      z: start.z + (m.z - start.z) * t,
    });
  }
  pts[pts.length - 1] = { x: m.x, y: m.y, z: m.z }; // land exactly on the endpoint
  return pts;
}

// ---------------------------------------------------------------------------
// Run extraction — split the program into pass-through lines and cutting runs
// ---------------------------------------------------------------------------

interface CutRun {
  pts: P3[];
  feed: number;
  plunge: number;
}
type Item = { kind: "raw"; text: string } | { kind: "run"; run: CutRun };

interface Extracted {
  items: Item[];
  safeZ: number;
  hasVaryingZ: boolean;
}

function extractRuns(program: GProgram): Extracted {
  const items: Item[] = [];
  let prev: P3 = { x: 0, y: 0, z: 0 };
  let safeZ = -Infinity;
  let hasVaryingZ = false;

  let run: CutRun | null = null;
  const closeRun = () => {
    if (run && run.pts.length >= 1) {
      let zmin = Infinity,
        zmax = -Infinity;
      for (const p of run.pts) {
        if (p.z < zmin) zmin = p.z;
        if (p.z > zmax) zmax = p.z;
      }
      if (zmax - zmin > FLAT_Z_TOL) hasVaryingZ = true;
      items.push({ kind: "run", run });
    }
    run = null;
  };

  for (const ev of program.events) {
    if (ev.kind === "raw") {
      items.push({ kind: "raw", text: ev.text });
      continue;
    }
    const m = ev;
    const end: P3 = { x: m.x, y: m.y, z: m.z };
    const seg = m.motion === 2 || m.motion === 3 ? linearizeArc(prev, m) : [end];

    if (m.motion === 0) {
      closeRun();
      if (m.hasZ) safeZ = Math.max(safeZ, m.z);
    } else if (end.z < 0) {
      if (!run) run = { pts: [], feed: 0, plunge: 0 };
      for (const p of seg) {
        const last = run.pts[run.pts.length - 1];
        if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1e-9) run.pts.push(p);
        else run.pts[run.pts.length - 1] = p; // pure plunge: keep the deeper point
      }
      if (m.f !== undefined) {
        if (m.hasX || m.hasY) run.feed = m.f;
        else run.plunge = m.f;
      }
    } else {
      closeRun();
      if (m.hasZ) safeZ = Math.max(safeZ, m.z);
    }
    prev = end;
  }
  closeRun();

  if (!Number.isFinite(safeZ)) safeZ = 5;
  // A feed with no plunge rate captured (or vice-versa) borrows the other.
  for (const it of items) {
    if (it.kind === "run") {
      if (it.run.feed === 0) it.run.feed = it.run.plunge || 600;
      if (it.run.plunge === 0) it.run.plunge = it.run.feed;
    }
  }
  return { items, safeZ, hasVaryingZ };
}

// ---------------------------------------------------------------------------
// Polyline ∩ rectangle (Liang–Barsky per segment, z interpolated)
// ---------------------------------------------------------------------------

const EPS = 1e-6;

/** Inside portion [t0,t1] of segment a→b within rect, or null if fully outside. */
function clipParams(a: Vec2, b: Vec2, r: Bounds): [number, number] | null {
  let t0 = 0,
    t1 = 1;
  const p = [-(b.x - a.x), b.x - a.x, -(b.y - a.y), b.y - a.y];
  const q = [a.x - r.min.x, r.max.x - a.x, a.y - r.min.y, r.max.y - a.y];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < EPS) {
      if (q[i] < 0) return null;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  return [t0, t1];
}

const lerp = (a: P3, b: P3, t: number): P3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});

/** Split a cut polyline into the connected sub-paths that lie inside the rect. */
function clipPolyline(pts: P3[], r: Bounds): P3[][] {
  const out: P3[][] = [];
  let cur: P3[] = [];
  const flush = () => {
    if (cur.length >= 2) out.push(cur);
    cur = [];
  };

  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i],
      b = pts[i + 1];
    const c = clipParams(a, b, r);
    if (!c) {
      flush();
      continue;
    }
    const [t0, t1] = c;
    const a2 = lerp(a, b, t0),
      b2 = lerp(a, b, t1);
    if (cur.length === 0) cur.push(a2);
    else if (Math.hypot(cur[cur.length - 1].x - a2.x, cur[cur.length - 1].y - a2.y) > 1e-6) {
      flush();
      cur.push(a2);
    }
    cur.push(b2);
    if (t1 < 1 - EPS) flush(); // segment left the rect at b2
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

const rapid = (over: Partial<GMoveEvent>): GMoveEvent => ({
  kind: "move",
  motion: 0,
  x: 0,
  y: 0,
  z: 0,
  hasX: false,
  hasY: false,
  hasZ: false,
  ...over,
});
const feed = (over: Partial<GMoveEvent>): GMoveEvent => ({
  kind: "move",
  motion: 1,
  x: 0,
  y: 0,
  z: 0,
  hasX: false,
  hasY: false,
  hasZ: false,
  ...over,
});

/** Retract, rapid to the sub-path start, straight-plunge, then cut through it. */
function emitSubPath(sub: P3[], safeZ: number, run: CutRun, prevZ: { v: number }): GMoveEvent[] {
  const out: GMoveEvent[] = [];
  const s = sub[0];
  out.push(rapid({ z: safeZ, hasZ: true }));
  out.push(rapid({ x: s.x, y: s.y, hasX: true, hasY: true }));
  out.push(feed({ z: s.z, hasZ: true, f: run.plunge })); // plunge to depth at the seam
  prevZ.v = s.z;
  for (let i = 1; i < sub.length; i++) {
    const p = sub[i];
    const zChanged = Math.abs(p.z - prevZ.v) > 1e-9;
    out.push(
      feed({
        x: p.x,
        y: p.y,
        z: p.z,
        hasX: true,
        hasY: true,
        hasZ: zChanged,
        f: i === 1 ? run.feed : undefined,
      }),
    );
    prevZ.v = p.z;
  }
  return out;
}

export interface ClipResult {
  program: GProgram;
  /** True if the tile contains any cutting. */
  hasCuts: boolean;
  /** Safe retract height (program coords) recovered from the source rapids. */
  safeZ: number;
  warnings: string[];
}

/**
 * Clip a parsed program to `rect` (in the program's coordinate space). Returns a
 * new program (still in that space — translate on emit) containing only the
 * in-tile cutting, with pass-through lines preserved.
 */
export function clipProgramToTile(program: GProgram, rect: Bounds): ClipResult {
  const { items, safeZ, hasVaryingZ } = extractRuns(program);
  const events: GEvent[] = [];
  const prevZ = { v: safeZ };
  let hasCuts = false;

  // Track whether the tool is in the material so we always lift before a
  // pass-through line (M5 / tool change) and at program end — never stop or
  // finish with the tool buried in the stock.
  let penDown = false;
  const retract = () => {
    if (penDown) {
      events.push(rapid({ z: safeZ, hasZ: true }));
      penDown = false;
      prevZ.v = safeZ;
    }
  };
  const inRect = (p: P3) =>
    p.x >= rect.min.x - EPS &&
    p.x <= rect.max.x + EPS &&
    p.y >= rect.min.y - EPS &&
    p.y <= rect.max.y + EPS;

  for (const it of items) {
    if (it.kind === "raw") {
      retract();
      events.push({ kind: "raw", text: it.text });
      continue;
    }
    const run = it.run;
    if (run.pts.length === 1) {
      // A drill / peck plunge — one point, no segments for clipPolyline to keep.
      if (inRect(run.pts[0])) {
        events.push(...emitSubPath(run.pts, safeZ, run, prevZ));
        penDown = true;
        hasCuts = true;
      }
      continue;
    }
    for (const sub of clipPolyline(run.pts, rect)) {
      events.push(...emitSubPath(sub, safeZ, run, prevZ));
      penDown = true;
      hasCuts = true;
    }
  }
  retract(); // lift at program end

  const warnings: string[] = [];
  if (hasVaryingZ) {
    warnings.push(
      "a toolpath varies continuously in Z (relief / v-carve / helical) — its seam entry is approximated by a plunge",
    );
  }
  return { program: { events }, hasCuts, safeZ, warnings };
}

/** Convenience: clip raw G-code text to a tile and return the parsed result. */
export function clipGCodeToTile(gcode: string, rect: Bounds): ClipResult {
  return clipProgramToTile(parseProgram(gcode), rect);
}

/**
 * Bounding box of all *cutting* in a program (arc-linearized), or null if it
 * cuts nothing. This is the true toolpath extent — including tool-offset and
 * lead overhang — so tiling can plan from it directly, in the G-code's own
 * coordinate space.
 */
export function programCutBounds(program: GProgram): Bounds | null {
  const { items } = extractRuns(program);
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    any = false;
  for (const it of items) {
    if (it.kind !== "run") continue;
    for (const p of it.run.pts) {
      any = true;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return any ? { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } } : null;
}
