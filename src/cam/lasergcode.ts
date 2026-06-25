/**
 * Laser / fixed-Z jet G-code generation. The mill path (gcode.ts) wraps every
 * move in spindle + Z plunge/retract; a laser has no Z — it traces XY contours
 * at a single focus height with the beam gated on (cutting) or off (travel).
 *
 * This reuses the same pure-XY geometry the mill path does (offsetPolygon for
 * kerf compensation, fitArcs for smooth curves, textToContours / chained loops
 * for shapes) and only swaps the wrapper: `M4 S<power>` per op, `G0` travels
 * (beam off), `G1/G2/G3` cuts, `M5` at the end. The head-specific bits (on/off
 * command, pierce, kerf) come from a {@link CuttingHead} so waterjet/plasma can
 * reuse this generator unchanged — see cam/cuttingHead.ts.
 */

import type { Vec2 } from "../core/vec2";
import { flattenBezier } from "../core/geom";
import { type CADDocument, resolveOrigin } from "../model/document";
import {
  LineEntity, CircleEntity, RectEntity, PolylineEntity, BezierEntity, TextEntity, ArcEntity,
} from "../model/entities";
import { textToContours } from "./textOutlines";
import type { CAMOperation } from "./types";
import { DEFAULTS } from "./types";
import { offsetPolygon, signedArea } from "./offset";
import { chainLinesIntoPolygons } from "./loops";
import { fitArcs } from "./arcfit";
import { expandOpPatternTargets } from "./patternExpand";
import { n, X, Y } from "./postprocessors/base";
import { type CuttingHead, LASER_HEAD } from "./cuttingHead";

/** Default controller max power (GRBL `$30`) that 100% maps to. */
const DEFAULT_MAX_POWER = 1000;

export interface LaserGCodeOptions {
  /** Machine-wide custom lines injected after the G21/G90/G17 setup block. */
  customStart?: string;
  /** Machine-wide custom lines injected after the final beam-off, before M30. */
  customEnd?: string;
  /** Controller maximum power that 100% maps to (GRBL `$30`). Default 1000. */
  laserMaxPower?: number;
}

/** Split a multi-line custom block into trimmed, non-empty-trailing lines. */
function customLines(block: string | undefined): string[] {
  if (!block || !block.trim()) return [];
  return block.replace(/\s+$/, "").split(/\r?\n/);
}

/** Scale an op's 0–100% power to an integer `S` word against `maxPower`. */
function powerToS(op: CAMOperation, maxPower: number): number {
  const pct = Math.max(0, Math.min(100, op.laserPower ?? DEFAULTS.laserPower));
  return Math.round((pct / 100) * maxPower);
}

function passCount(op: CAMOperation): number {
  return Math.max(1, Math.round(op.laserPasses ?? DEFAULTS.laserPasses));
}

// --- path tracing (no Z) -----------------------------------------------------

/**
 * Trace a closed contour `passes` times. Each pass travels to the start with the
 * beam off (G0), then cuts the loop with arc-fitted G1/G2/G3 so curved profiles
 * stay smooth. Straight-edged shapes fit to all lines → identical to raw G1.
 */
function traceClosed(
  path: Vec2[], passes: number, feed: number, ox: number, oy: number,
): string[] {
  if (path.length < 2) return [];
  const s = path[0];
  const lines: string[] = [];
  for (let p = 0; p < passes; p++) {
    lines.push(`G0 X${X(s.x, ox)} Y${Y(s.y, oy)}`);
    let cur = s, first = true;
    for (const mv of fitArcs([...path, s])) {
      const f = first ? ` F${n(feed)}` : "";
      if (mv.kind === "line") {
        lines.push(`G1 X${X(mv.to.x, ox)} Y${Y(mv.to.y, oy)}${f}`);
      } else {
        const cmd = mv.cw ? "G2" : "G3";
        lines.push(`${cmd} X${X(mv.to.x, ox)} Y${Y(mv.to.y, oy)} I${n(mv.cx - cur.x)} J${n(mv.cy - cur.y)}${f}`);
      }
      cur = mv.to;
      first = false;
    }
  }
  return lines;
}

/** Trace an open polyline `passes` times on its centreline (engrave). */
function traceOpen(
  pts: Vec2[], passes: number, feed: number, ox: number, oy: number,
): string[] {
  if (pts.length < 2) return [];
  const s = pts[0];
  const lines: string[] = [];
  for (let p = 0; p < passes; p++) {
    lines.push(`G0 X${X(s.x, ox)} Y${Y(s.y, oy)}`);
    for (let i = 1; i < pts.length; i++) {
      const f = i === 1 ? ` F${n(feed)}` : "";
      lines.push(`G1 X${X(pts[i].x, ox)} Y${Y(pts[i].y, oy)}${f}`);
    }
  }
  return lines;
}

/** Trace a full circle `passes` times (one G2 per pass). */
function traceCircle(
  cx: number, cy: number, r: number, passes: number, feed: number, ox: number, oy: number,
): string[] {
  if (r <= 0) return [];
  const sx = cx + r;
  const lines: string[] = [];
  for (let p = 0; p < passes; p++) {
    lines.push(`G0 X${X(sx, ox)} Y${Y(cy, oy)}`);
    lines.push(`G2 X${X(sx, ox)} Y${Y(cy, oy)} I${n(-r)} J0 F${n(feed)}`);
  }
  return lines;
}

/** Trace a circular arc `passes` times (G3, CCW like the mill engrave). */
function traceArc(
  arc: ArcEntity, passes: number, feed: number, ox: number, oy: number,
): string[] {
  const span = ((arc.endAngle - arc.startAngle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  if (span < 1e-6) return [`; NOTE: arc (${arc.id}) has zero sweep — skipped`];
  const s = arc.startPoint, e = arc.endPoint;
  const iOff = arc.center.x - s.x, jOff = arc.center.y - s.y;
  const lines: string[] = [];
  for (let p = 0; p < passes; p++) {
    lines.push(`G0 X${X(s.x, ox)} Y${Y(s.y, oy)}`);
    lines.push(`G3 X${X(e.x, ox)} Y${Y(e.y, oy)} I${n(iOff)} J${n(jOff)} F${n(feed)}`);
  }
  return lines;
}

/**
 * Kerf-compensate a closed contour for a profile cut: offset outward ("outside")
 * or inward ("inside") by half the op's kerf width. 0 kerf = cut on the line.
 */
function kerfPaths(verts: Vec2[], op: CAMOperation, head: CuttingHead): Vec2[][] {
  const kerf = op.kerfWidth ?? 0;
  if (!head.kerfCompensated || kerf <= 0) return [verts];
  const ccw = signedArea(verts) >= 0 ? verts : [...verts].reverse();
  const d = (op.side === "outside" ? 1 : -1) * (kerf / 2);
  const offs = offsetPolygon(ccw, d);
  return offs.length ? offs : [];
}

// --- per-operation body ------------------------------------------------------

function laserOpBody(
  op: CAMOperation, doc: CADDocument, ox: number, oy: number,
  head: CuttingHead, maxPower: number,
): string[] {
  // Laser only does flat XY cutting: profile (closed, optional kerf) and engrave
  // (centreline). Volumetric ops have no fixed-Z meaning and are skipped loudly.
  if (op.type !== "profile" && op.type !== "engrave") {
    return [`; NOTE: ${op.type} has no laser equivalent — use Profile or Engrave; skipped`];
  }

  const entityMap = new Map(doc.entities.map((e) => [e.id, e]));
  const passes = passCount(op);
  const feed = op.feedrate;
  const lines: string[] = [];

  lines.push(head.beamOn(powerToS(op, maxPower)));
  if (head.pierce) lines.push(...head.pierce());

  const profile = op.type === "profile";

  // Chain selected line segments into closed polygons (profile only).
  const lineSegIds = new Set<string>();
  if (profile) {
    const lineEnts = op.entityIds
      .map((id) => entityMap.get(id))
      .filter((e): e is LineEntity => e instanceof LineEntity && !e.isConstruction);
    if (lineEnts.length > 0) {
      const { polygons, leftover } = chainLinesIntoPolygons(lineEnts);
      for (const { verts } of polygons)
        for (const path of kerfPaths(verts, op, head))
          lines.push(...traceClosed(path, passes, feed, ox, oy));
      if (leftover.length > 0)
        lines.push(`; NOTE: ${leftover.length} selected line(s) do not form a closed polygon — skipped`);
      for (const e of lineEnts) lineSegIds.add(e.id);
    }
  }

  for (const id of op.entityIds) {
    if (lineSegIds.has(id)) continue;
    const ent = entityMap.get(id);
    if (!ent || ent.isConstruction) continue;

    // Text → glyph contours (closed for profile; each contour for engrave).
    if (ent instanceof TextEntity) {
      const contours = textToContours(ent);
      if (contours.length === 0) {
        lines.push(`; NOTE: text "${ent.text}" — font not loaded or no glyphs`);
        continue;
      }
      for (const c of contours) {
        if (profile && c.closed)
          for (const path of kerfPaths(c.points, op, head))
            lines.push(...traceClosed(path, passes, feed, ox, oy));
        else
          lines.push(...(c.closed
            ? traceClosed(c.points, passes, feed, ox, oy)
            : traceOpen(c.points, passes, feed, ox, oy)));
      }
      continue;
    }

    if (ent instanceof CircleEntity) {
      const r = profile
        ? ent.radius + (op.kerfWidth ?? 0) / 2 * (op.side === "outside" ? 1 : -1)
        : ent.radius;
      lines.push(...traceCircle(ent.center.x, ent.center.y, r, passes, feed, ox, oy));
      continue;
    }
    if (ent instanceof RectEntity) {
      for (const path of profile ? kerfPaths([...ent.corners()], op, head) : [[...ent.corners()]])
        lines.push(...traceClosed(path, passes, feed, ox, oy));
      continue;
    }
    if (ent instanceof PolylineEntity) {
      if (ent.closed) {
        for (const path of profile ? kerfPaths(ent.points, op, head) : [ent.points])
          lines.push(...traceClosed(path, passes, feed, ox, oy));
      } else if (profile) {
        lines.push(`; NOTE: open polyline (${ent.id}) skipped — profile requires closed geometry`);
      } else {
        lines.push(...traceOpen(ent.points, passes, feed, ox, oy));
      }
      continue;
    }
    if (ent instanceof LineEntity) {
      // Profile-chained lines already handled above; a leftover single line can
      // only be engraved (it's an open path).
      if (!profile) lines.push(...traceOpen([ent.a, ent.b], passes, feed, ox, oy));
      continue;
    }
    if (ent instanceof ArcEntity) {
      if (profile) lines.push(`; NOTE: arc (${ent.id}) skipped — profile requires closed geometry (use Engrave for an open arc)`);
      else lines.push(...traceArc(ent, passes, feed, ox, oy));
      continue;
    }
    if (ent instanceof BezierEntity) {
      if (profile) lines.push(`; NOTE: bezier (${ent.id}) skipped in profile — beziers are open paths`);
      else lines.push(...traceOpen(flattenBezier(ent.p0, ent.p1, ent.p2, ent.p3, 0.05), passes, feed, ox, oy));
      continue;
    }
  }

  lines.push(head.beamOff());
  return lines;
}

// --- main entry --------------------------------------------------------------

export function generateLaserGCode(
  rawOps: CAMOperation[], doc: CADDocument, opts: LaserGCodeOptions = {},
): string {
  if (rawOps.length === 0) return "; No toolpaths\nM30\n";

  // Expand pattern targets so a toolpath follows its pattern's count. (No tool
  // resolution — laser ops carry their own power/feed, not a tool library entry.)
  const ops = rawOps.map((op) => expandOpPatternTargets(op, doc));
  const { ox, oy } = resolveOrigin(doc); // Z origin is irrelevant for a laser
  const head = LASER_HEAD;
  const maxPower = opts.laserMaxPower ?? DEFAULT_MAX_POWER;

  const xLabel = { left: "Left", center: "Center", right: "Right" }[doc.origin.x];
  const yLabel = { front: "Front", center: "Center", back: "Back" }[doc.origin.y];

  const lines: string[] = [
    "; RapidCAM generated G-code",
    `; Machine: ${head.name}  (max power S${maxPower})`,
    `; ${ops.length} toolpath${ops.length !== 1 ? "s" : ""}`,
    `; WCS origin X: ${xLabel}  Y: ${yLabel}`,
    `; Stock: ${doc.canvas.width} × ${doc.canvas.height}mm`,
    "G21 ; metric",
    "G90 ; absolute",
    "G17 ; XY plane",
    ...head.programStart(),
    "",
  ];

  const startLines = customLines(opts.customStart);
  if (startLines.length > 0) lines.push("; --- custom start ---", ...startLines, "");

  for (const op of ops) {
    const typeLabel = op.type === "profile" ? `Profile (${op.side})` : "Engrave";
    const pct = Math.max(0, Math.min(100, op.laserPower ?? DEFAULTS.laserPower));
    lines.push(
      `; --- ${typeLabel} "${op.name}"  power:${pct}% (S${powerToS(op, maxPower)})  ` +
      `passes:${passCount(op)}  feed:${op.feedrate}mm/min ---`,
    );
    lines.push(...laserOpBody(op, doc, ox, oy, head, maxPower));
    lines.push("");
  }

  // Optional end-of-program park (work coords; already in the G-code frame).
  const ep = doc.endPosition;
  if (ep) lines.push(`G0 X${n(ep.x)} Y${n(ep.y)} ; return to end position`);

  lines.push(head.beamOff());

  const endLines = customLines(opts.customEnd);
  if (endLines.length > 0) lines.push("; --- custom end ---", ...endLines);

  lines.push("M30 ; end program");
  return lines.join("\n");
}
