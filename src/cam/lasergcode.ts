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
  type Entity,
  LineEntity, CircleEntity, RectEntity, PolylineEntity, BezierEntity, TextEntity, ArcEntity,
} from "../model/entities";
import { textToContours } from "./textOutlines";
import type { CAMOperation } from "./types";
import { DEFAULTS } from "./types";
import { offsetPolygon, signedArea } from "./offset";
import { chainLinesIntoPolygons } from "./loops";
import { rasterRows, rasterRowsWithIslands } from "./pocket";
import { groupContoursIntoRegions } from "./vcarve";
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

// --- per-operation geometry --------------------------------------------------

/** A drawable/cuttable primitive produced by an op's geometry dispatch. */
type LaserPrim =
  | { kind: "poly"; pts: Vec2[]; closed: boolean }
  | { kind: "circle"; cx: number; cy: number; r: number }
  | { kind: "arc"; arc: ArcEntity };

/** One dispatch result: a cut primitive or a skip note, kept in entity order. */
type LaserItem = LaserPrim | { kind: "note"; text: string };

/** Circle radius after profile kerf compensation (engrave = on the centreline). */
function profileCircleRadius(r: number, op: CAMOperation, head: CuttingHead): number {
  const kerf = head.kerfCompensated ? (op.kerfWidth ?? 0) : 0;
  return r + (op.side === "outside" ? 1 : -1) * (kerf / 2);
}

/** Closed contour rings of an entity for area fill, or null if it isn't closed. */
function fillableContours(ent: Entity): Vec2[][] | null {
  if (ent instanceof CircleEntity) return [circlePolyline(ent.center.x, ent.center.y, ent.radius)];
  if (ent instanceof RectEntity) return [[...ent.corners()]];
  if (ent instanceof PolylineEntity) return ent.closed ? [ent.points] : null;
  if (ent instanceof TextEntity) {
    const cs = textToContours(ent).filter((c) => c.closed).map((c) => c.points);
    return cs.length ? cs : null;
  }
  return null; // line / arc / bezier are open — nothing to fill
}

/** Scan-line fill of a region as a list of beam-on segments (each [a, b]). */
function fillSegments(outer: Vec2[], holes: Vec2[][], spacing: number): Vec2[][] {
  const rows = holes.length > 0
    ? rasterRowsWithIslands(outer, holes, spacing)
    : rasterRows(outer, spacing);
  const segs: Vec2[][] = [];
  for (const row of rows)
    for (let i = 0; i + 1 < row.length; i += 2)
      segs.push([row[i], row[i + 1]]);
  return segs;
}

/**
 * Push the kerf-compensated ring(s) of a closed profile contour. If an inside
 * kerf is wider than the feature, the offset collapses to nothing — emit a note
 * instead of silently dropping the cut (mirrors the mill path's warnings).
 */
function pushClosedProfile(items: LaserItem[], verts: Vec2[], op: CAMOperation, head: CuttingHead): void {
  const paths = kerfPaths(verts, op, head);
  if (paths.length === 0) {
    items.push({ kind: "note", text: `a closed profile vanished under inside kerf ${op.kerfWidth}mm (wider than the feature) — skipped` });
    return;
  }
  for (const p of paths) items.push({ kind: "poly", pts: p, closed: true });
}

/**
 * Expand an operation's entities into ordered cut primitives (kerf applied for
 * closed profiles) plus any skip notes. Shared by the G-code emitter and the
 * flat preview so the two can never drift — see {@link laserOpBody} and
 * {@link laserPreviewPaths}. Volumetric op types yield a single note.
 */
function laserOpItems(op: CAMOperation, doc: CADDocument, head: CuttingHead): LaserItem[] {
  if (op.type !== "profile" && op.type !== "engrave")
    return [{ kind: "note", text: `${op.type} has no laser equivalent — use Profile or Engrave; skipped` }];

  const entityMap = new Map(doc.entities.map((e) => [e.id, e]));
  const profile = op.type === "profile";
  const items: LaserItem[] = [];

  // Area-fill engrave: gather every closed contour, group even–odd into solids
  // with holes (so letter counters stay clear), outline each, then flood the
  // interior with scan-line segments. Replaces the centreline dispatch below.
  if (op.type === "engrave" && op.laserFill) {
    const contours: Vec2[][] = [];
    for (const id of op.entityIds) {
      const ent = entityMap.get(id);
      if (!ent || ent.isConstruction) continue;
      const cs = fillableContours(ent);
      if (cs) contours.push(...cs);
      else items.push({ kind: "note", text: `${ent.id} skipped — fill needs a closed shape` });
    }
    const spacing = Math.max(0.01, op.laserFillSpacing ?? DEFAULTS.laserFillSpacing);
    for (const region of groupContoursIntoRegions(contours)) {
      items.push({ kind: "poly", pts: region.outer, closed: true });        // crisp edge
      for (const h of region.holes) items.push({ kind: "poly", pts: h, closed: true });
      for (const seg of fillSegments(region.outer, region.holes, spacing))
        items.push({ kind: "poly", pts: seg, closed: false });
    }
    return items;
  }

  // Chain selected line segments into closed polygons (profile only).
  const lineSegIds = new Set<string>();
  if (profile) {
    const lineEnts = op.entityIds
      .map((id) => entityMap.get(id))
      .filter((e): e is LineEntity => e instanceof LineEntity && !e.isConstruction);
    if (lineEnts.length > 0) {
      const { polygons, leftover } = chainLinesIntoPolygons(lineEnts);
      for (const { verts } of polygons) pushClosedProfile(items, verts, op, head);
      if (leftover.length > 0)
        items.push({ kind: "note", text: `${leftover.length} selected line(s) do not form a closed polygon — skipped` });
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
        items.push({ kind: "note", text: `text "${ent.text}" — font not loaded or no glyphs` });
        continue;
      }
      for (const c of contours) {
        if (profile && c.closed)
          pushClosedProfile(items, c.points, op, head);
        else
          items.push({ kind: "poly", pts: c.points, closed: c.closed });
      }
      continue;
    }
    if (ent instanceof CircleEntity) {
      const r = profile ? profileCircleRadius(ent.radius, op, head) : ent.radius;
      if (r > 0) items.push({ kind: "circle", cx: ent.center.x, cy: ent.center.y, r });
      else items.push({ kind: "note", text: `circle (${ent.id}) vanished under inside kerf ${op.kerfWidth}mm (radius ≤ 0) — skipped` });
      continue;
    }
    if (ent instanceof RectEntity) {
      const base = [...ent.corners()];
      if (profile) pushClosedProfile(items, base, op, head);
      else items.push({ kind: "poly", pts: base, closed: true });
      continue;
    }
    if (ent instanceof PolylineEntity) {
      if (ent.closed) {
        if (profile) pushClosedProfile(items, ent.points, op, head);
        else items.push({ kind: "poly", pts: ent.points, closed: true });
      } else if (profile) {
        items.push({ kind: "note", text: `open polyline (${ent.id}) skipped — profile requires closed geometry` });
      } else {
        items.push({ kind: "poly", pts: ent.points, closed: false });
      }
      continue;
    }
    if (ent instanceof LineEntity) {
      // Profile-chained lines were handled above; a leftover single line can only
      // be engraved (it's an open path).
      if (!profile) items.push({ kind: "poly", pts: [ent.a, ent.b], closed: false });
      continue;
    }
    if (ent instanceof ArcEntity) {
      if (profile) items.push({ kind: "note", text: `arc (${ent.id}) skipped — profile requires closed geometry (use Engrave for an open arc)` });
      else items.push({ kind: "arc", arc: ent });
      continue;
    }
    if (ent instanceof BezierEntity) {
      if (profile) items.push({ kind: "note", text: `bezier (${ent.id}) skipped in profile — beziers are open paths` });
      else items.push({ kind: "poly", pts: flattenBezier(ent.p0, ent.p1, ent.p2, ent.p3, 0.05), closed: false });
      continue;
    }
  }
  return items;
}

/** Emit the G-code trace for one cut primitive. */
function emitPrim(prim: LaserPrim, passes: number, feed: number, ox: number, oy: number): string[] {
  switch (prim.kind) {
    case "poly":   return prim.closed
      ? traceClosed(prim.pts, passes, feed, ox, oy)
      : traceOpen(prim.pts, passes, feed, ox, oy);
    case "circle": return traceCircle(prim.cx, prim.cy, prim.r, passes, feed, ox, oy);
    case "arc":    return traceArc(prim.arc, passes, feed, ox, oy);
  }
}

// --- per-operation body ------------------------------------------------------

function laserOpBody(
  op: CAMOperation, doc: CADDocument, ox: number, oy: number,
  head: CuttingHead, maxPower: number,
): string[] {
  const items = laserOpItems(op, doc, head);
  // Nothing cuttable (only notes, e.g. a volumetric op type): surface the notes
  // without firing the beam.
  if (!items.some((it) => it.kind !== "note"))
    return items.map((it) => `; NOTE: ${(it as { text: string }).text}`);

  const passes = passCount(op);
  const feed = op.feedrate;
  const lines: string[] = [];
  lines.push(head.beamOn(powerToS(op, maxPower)));
  if (head.pierce) lines.push(...head.pierce());
  for (const it of items) {
    if (it.kind === "note") lines.push(`; NOTE: ${it.text}`);
    else lines.push(...emitPrim(it, passes, feed, ox, oy));
  }
  lines.push(head.beamOff());
  return lines;
}

// --- flat preview ------------------------------------------------------------

/** Sample a circle into a closed polyline for the on-canvas preview. */
function circlePolyline(cx: number, cy: number, r: number): Vec2[] {
  const segs = Math.max(48, Math.ceil((2 * Math.PI * r) / 0.5));
  return Array.from({ length: segs }, (_, i) => {
    const a = (i / segs) * 2 * Math.PI;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
}

/** Sample an arc into an open polyline for the on-canvas preview. */
function arcPolyline(arc: ArcEntity): Vec2[] {
  const span = ((arc.endAngle - arc.startAngle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  const segs = Math.max(2, Math.ceil((arc.radius * span) / 0.5));
  return Array.from({ length: segs + 1 }, (_, i) => {
    const a = arc.startAngle + span * (i / segs);
    return { x: arc.center.x + arc.radius * Math.cos(a), y: arc.center.y + arc.radius * Math.sin(a) };
  });
}

/** A cut path for the flat preview, in model/world coordinates. */
export interface LaserPreviewPath { pts: Vec2[]; closed: boolean; }

/**
 * Flatten the given laser ops into world-space cut polylines for an on-canvas
 * preview (cut paths only — travel rapids aren't drawn). Reuses the same
 * geometry dispatch as the G-code, so the preview shows exactly what the beam
 * will trace. Coordinates are in model space (no WCS offset); the renderer maps
 * them to screen.
 */
export function laserPreviewPaths(rawOps: CAMOperation[], doc: CADDocument): LaserPreviewPath[] {
  const head = LASER_HEAD;
  const paths: LaserPreviewPath[] = [];
  for (const raw of rawOps) {
    const op = expandOpPatternTargets(raw, doc);
    for (const it of laserOpItems(op, doc, head)) {
      if (it.kind === "note") continue;
      if (it.kind === "circle") paths.push({ pts: circlePolyline(it.cx, it.cy, it.r), closed: true });
      else if (it.kind === "arc") paths.push({ pts: arcPolyline(it.arc), closed: false });
      else if (it.pts.length >= 2) paths.push({ pts: it.pts, closed: it.closed });
    }
  }
  return paths;
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
    const typeLabel = op.type === "profile" ? `Profile (${op.side})`
      : op.laserFill ? "Engrave (fill)" : "Engrave";
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
