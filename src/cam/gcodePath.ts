/**
 * G-code → toolpath geometry, for the export-preview backplot.
 *
 * Walks a posted program the same way {@link ./timeEstimate} does (absolute G90,
 * modal motion mode, incremental I/J arcs) but collects the XY path instead of the
 * time: a list of polylines tagged rapid (G0 traverse) vs cut (G1/G2/G3), with arcs
 * tessellated into short chords. Purely geometric and DOM-free so it can be unit
 * tested and drawn by the preview dialog on a plain canvas. Z is ignored — the
 * backplot is a top-down 2-D view that works for mill, laser, and (unrolled) rotary
 * programs alike.
 */

import type { Vec2 } from "../core/vec2";

export interface ToolpathSegment {
  /** true = G0 traverse (drawn faint/dashed), false = a cutting move. */
  rapid: boolean;
  /** Connected world-XY polyline (mm). Consecutive same-kind moves are merged. */
  pts: Vec2[];
}

export interface ToolpathBounds {
  min: Vec2;
  max: Vec2;
}

export interface GcodeToolpath {
  segments: ToolpathSegment[];
  /** XY extent of all motion, or null when nothing moved. */
  bounds: ToolpathBounds | null;
}

const wordRe = /([A-Za-z])\s*(-?\d*\.?\d+)/g;

function parseWords(line: string): Map<string, number> {
  const clean = line.replace(/\(.*?\)/g, " ").split(";")[0];
  const words = new Map<string, number>();
  wordRe.lastIndex = 0;
  let m = wordRe.exec(clean);
  while (m !== null) {
    const v = parseFloat(m[2]);
    if (Number.isFinite(v)) words.set(m[1].toUpperCase(), v);
    m = wordRe.exec(clean);
  }
  return words;
}

/** Swept angle (0, 2π] from `a0` to `a1` in the given direction (ccw = G3). */
function sweptAngle(a0: number, a1: number, ccw: boolean): number {
  let d = ccw ? a1 - a0 : a0 - a1;
  while (d <= 1e-9) d += 2 * Math.PI;
  return d;
}

/**
 * Parse a G-code program into rapid/cut polylines. Non-motion lines (comments,
 * G21/G90, M/S/T) are skipped; unknown axes (A, etc.) don't contribute to XY.
 */
export function parseGcodePath(gcode: string): GcodeToolpath {
  let x = 0;
  let y = 0;
  let motion: 0 | 1 | 2 | 3 | null = null;

  const segments: ToolpathSegment[] = [];
  let cur: ToolpathSegment | null = null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const expand = (p: Vec2): void => {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  };
  const grow = (rapid: boolean, pts: Vec2[]): void => {
    if (cur && cur.rapid === rapid) {
      for (const p of pts) {
        cur.pts.push(p);
        expand(p);
      }
    } else {
      const start = { x, y }; // begin the new run at the current point
      cur = { rapid, pts: [start, ...pts] };
      segments.push(cur);
      expand(start);
      for (const p of pts) expand(p);
    }
  };

  for (const raw of gcode.split("\n")) {
    const w = parseWords(raw);
    if (w.size === 0) continue;
    if (w.has("G")) {
      const g = w.get("G")!;
      if (g === 0 || g === 1 || g === 2 || g === 3) motion = g;
    }
    const hasMove = w.has("X") || w.has("Y") || w.has("Z") || w.has("I") || w.has("J");
    if (motion === null || !hasMove) continue;

    const nx = w.has("X") ? w.get("X")! : x;
    const ny = w.has("Y") ? w.get("Y")! : y;

    if (motion === 2 || motion === 3) {
      const cx = x + (w.get("I") ?? 0);
      const cy = y + (w.get("J") ?? 0);
      const r = Math.hypot(x - cx, y - cy);
      const closed = Math.hypot(nx - x, ny - y) < 1e-6;
      const a0 = Math.atan2(y - cy, x - cx);
      const sweep = closed ? 2 * Math.PI : sweptAngle(a0, Math.atan2(ny - cy, nx - cx), motion === 3);
      const dir = motion === 3 ? 1 : -1;
      // Chord ≈ 0.4 mm, clamped so tiny arcs still get a couple of segments and
      // huge ones don't explode the point count.
      const steps = Math.min(240, Math.max(2, Math.ceil((r * sweep) / 0.4)));
      const pts: Vec2[] = [];
      for (let i = 1; i < steps; i++) {
        const a = a0 + dir * sweep * (i / steps);
        pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
      }
      pts.push({ x: nx, y: ny }); // exact endpoint (avoids tessellation drift)
      grow(false, pts);
    } else {
      grow(motion === 0, [{ x: nx, y: ny }]);
    }

    x = nx;
    y = ny;
  }

  const bounds =
    minX <= maxX && minY <= maxY ? { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } } : null;
  return { segments, bounds };
}
