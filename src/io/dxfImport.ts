/**
 * DXF import — parses an ASCII DXF string and returns entities for the document.
 *
 * Hand-rolled group-code/value parser (DXF ASCII is alternating lines of
 * integer group code and value) — no external dependency.
 *
 * Coordinate system: DXF is Y-up like the document, so no axis flip — only a
 * unit scale derived from the HEADER's $INSUNITS (unitless files assume mm and
 * warn). Z coordinates are ignored (2D import).
 *
 * Entity coverage:
 *   LINE, CIRCLE, ARC, POINT           → direct 1:1 mapping
 *   LWPOLYLINE / POLYLINE+VERTEX       → straight runs become PolylineEntity;
 *                                        bulged segments become true ArcEntity
 *                                        (bulge = tan(θ/4), negative = CW) so
 *                                        arc-fitting posts keep real arcs
 *   SPLINE                             → NURBS tessellated to a polyline (warn)
 *   ELLIPSE                            → tessellated to a polyline (warn)
 *   INSERT                             → block expanded with translation,
 *                                        rotation, and uniform scale (warn +
 *                                        skip on non-uniform scale)
 *   TEXT/MTEXT/DIMENSION/HATCH/…       → skipped, reported in warnings
 */

import type { Vec2 } from "../core/vec2";
import {
  type Entity, LineEntity, CircleEntity, ArcEntity, PolylineEntity, PointEntity,
} from "../model/entities";

export interface DxfImportResult {
  entities: Entity[];
  /** Human-readable notes about anything skipped or approximated. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Tag stream
// ---------------------------------------------------------------------------

interface Tag { code: number; value: string }

function tokenize(text: string): Tag[] {
  const lines = text.split(/\r\n|\n|\r/);
  const tags: Tag[] = [];
  // Trailing lone line (odd count) is tolerated — usually a blank after EOF.
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) {
      throw new Error(`not a valid DXF file (bad group code at line ${i + 1})`);
    }
    tags.push({ code, value: lines[i + 1] });
  }
  return tags;
}

/** Index of the next code-0 tag at or after `i` (tags.length if none). */
function nextEntityStart(tags: Tag[], i: number): number {
  while (i < tags.length && tags[i].code !== 0) i++;
  return i;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;

interface Xform { s: number; rot: number; tx: number; ty: number }

function xformPoint(p: Vec2, t: Xform): Vec2 {
  const x = p.x * t.s, y = p.y * t.s;
  const c = Math.cos(t.rot), sn = Math.sin(t.rot);
  return { x: t.tx + x * c - y * sn, y: t.ty + x * sn + y * c };
}

/**
 * Apply translate/rotate/uniform-scale to an imported entity in place.
 * A negative uniform scale is a point reflection — handled as rotation+π on
 * arc angles — so the CCW sweep convention is preserved (det > 0 always).
 */
function xformEntity(e: Entity, t: Xform): void {
  const angleShift = t.rot + (t.s < 0 ? Math.PI : 0);
  if (e instanceof LineEntity) {
    e.a = xformPoint(e.a, t);
    e.b = xformPoint(e.b, t);
  } else if (e instanceof CircleEntity) {
    e.center = xformPoint(e.center, t);
    e.radius *= Math.abs(t.s);
  } else if (e instanceof ArcEntity) {
    e.center = xformPoint(e.center, t);
    e.radius *= Math.abs(t.s);
    e.startAngle += angleShift;
    e.endAngle += angleShift;
  } else if (e instanceof PolylineEntity) {
    e.points = e.points.map((p) => xformPoint(p, t));
  } else if (e instanceof PointEntity) {
    e.pos = xformPoint(e.pos, t);
  }
}

/**
 * Convert one bulged polyline segment to an arc. Bulge = tan(θ/4) where θ is
 * the included angle, negative when the arc runs clockwise from p1 to p2. The
 * document's ArcEntity sweeps CCW from startAngle to endAngle, so a CW bulge
 * simply swaps the endpoints' roles.
 */
function bulgeToArc(p1: Vec2, p2: Vec2, bulge: number): ArcEntity | LineEntity {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-12 || Math.abs(bulge) < 1e-12) return new LineEntity(p1, p2);
  const theta = 4 * Math.atan(bulge); // signed included angle
  const radius = chord / (2 * Math.abs(Math.sin(theta / 2)));
  // Center sits on the chord's perpendicular bisector at signed height h.
  const h = (chord / 2) / Math.tan(theta / 2);
  const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
  const cx = mx + (-dy / chord) * h, cy = my + (dx / chord) * h;
  const a1 = Math.atan2(p1.y - cy, p1.x - cx);
  const a2 = Math.atan2(p2.y - cy, p2.x - cx);
  return bulge > 0
    ? new ArcEntity({ x: cx, y: cy }, radius, a1, a2)
    : new ArcEntity({ x: cx, y: cy }, radius, a2, a1);
}

// ---------------------------------------------------------------------------
// Polyline assembly (shared by LWPOLYLINE and POLYLINE)
// ---------------------------------------------------------------------------

interface DxfVertex { p: Vec2; bulge: number }

/**
 * Emit entities for a (possibly bulged) polyline. All-straight polylines stay
 * a single PolylineEntity (keeping the closed flag); mixed ones become runs of
 * straight segments plus true arcs — geometrically closed, and the CAM loop
 * detection re-chains them.
 */
function emitPolyline(verts: DxfVertex[], closed: boolean, out: Entity[]): void {
  if (verts.length < 2) return;
  const hasBulge = verts.some((v, i) =>
    Math.abs(v.bulge) > 1e-12 && (closed || i < verts.length - 1));
  if (!hasBulge) {
    const pts = verts.map((v) => v.p);
    if (pts.length === 2 && !closed) out.push(new LineEntity(pts[0], pts[1]));
    else out.push(new PolylineEntity(pts, closed));
    return;
  }
  const segCount = closed ? verts.length : verts.length - 1;
  let run: Vec2[] = [];
  const flushRun = () => {
    if (run.length === 2) out.push(new LineEntity(run[0], run[1]));
    else if (run.length > 2) out.push(new PolylineEntity(run, false));
    run = [];
  };
  for (let i = 0; i < segCount; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    if (Math.abs(a.bulge) > 1e-12) {
      flushRun();
      out.push(bulgeToArc(a.p, b.p, a.bulge));
    } else {
      if (run.length === 0) run.push(a.p);
      run.push(b.p);
    }
  }
  flushRun();
}

// ---------------------------------------------------------------------------
// NURBS (SPLINE) evaluation
// ---------------------------------------------------------------------------

function findSpan(t: number, degree: number, knots: number[], nCtrl: number): number {
  if (t >= knots[nCtrl]) return nCtrl - 1;
  let k = degree;
  while (k < nCtrl - 1 && t >= knots[k + 1]) k++;
  return k;
}

/** Rational de Boor evaluation at parameter t (homogeneous coordinates). */
function evalNurbs(ctrl: Vec2[], weights: number[], knots: number[], degree: number, t: number): Vec2 {
  const k = findSpan(t, degree, knots, ctrl.length);
  const d: { x: number; y: number; w: number }[] = [];
  for (let j = 0; j <= degree; j++) {
    const c = ctrl[k - degree + j], w = weights[k - degree + j];
    d.push({ x: c.x * w, y: c.y * w, w });
  }
  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const i = k - degree + j;
      const denom = knots[i + degree - r + 1] - knots[i];
      const alpha = denom === 0 ? 0 : (t - knots[i]) / denom;
      d[j] = {
        x: (1 - alpha) * d[j - 1].x + alpha * d[j].x,
        y: (1 - alpha) * d[j - 1].y + alpha * d[j].y,
        w: (1 - alpha) * d[j - 1].w + alpha * d[j].w,
      };
    }
  }
  const e = d[degree];
  return { x: e.x / e.w, y: e.y / e.w };
}

// ---------------------------------------------------------------------------
// Per-entity parsers — each consumes tags[start..end) for one entity
// ---------------------------------------------------------------------------

/** Last value per group code (fine for entities where repetition is meaningless). */
function collect(tags: Tag[], start: number, end: number): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = start; i < end; i++) m.set(tags[i].code, parseFloat(tags[i].value));
  return m;
}

function num(m: Map<number, number>, code: number, dflt = 0): number {
  const v = m.get(code);
  return v === undefined || Number.isNaN(v) ? dflt : v;
}

function parseLwPolyline(tags: Tag[], start: number, end: number, out: Entity[]): void {
  const verts: DxfVertex[] = [];
  let flags = 0;
  for (let i = start; i < end; i++) {
    const { code, value } = tags[i];
    const v = parseFloat(value);
    if (code === 10) verts.push({ p: { x: v, y: 0 }, bulge: 0 });
    else if (code === 20 && verts.length) verts[verts.length - 1].p.y = v;
    else if (code === 42 && verts.length) verts[verts.length - 1].bulge = v;
    else if (code === 70) flags = v;
  }
  emitPolyline(verts, (flags & 1) !== 0, out);
}

function parseSpline(
  tags: Tag[], start: number, end: number, out: Entity[], warnings: string[],
): void {
  const knots: number[] = [];
  const ctrl: Vec2[] = [];
  const weights: number[] = [];
  const fit: Vec2[] = [];
  let degree = 3, flags = 0;
  for (let i = start; i < end; i++) {
    const { code, value } = tags[i];
    const v = parseFloat(value);
    if (code === 71) degree = v;
    else if (code === 70) flags = v;
    else if (code === 40) knots.push(v);
    else if (code === 10) ctrl.push({ x: v, y: 0 });
    else if (code === 20 && ctrl.length) ctrl[ctrl.length - 1].y = v;
    else if (code === 41) weights.push(v);
    else if (code === 11) fit.push({ x: v, y: 0 });
    else if (code === 21 && fit.length) fit[fit.length - 1].y = v;
  }
  const closed = (flags & 1) !== 0;

  const validNurbs =
    ctrl.length > degree && degree >= 1 && knots.length === ctrl.length + degree + 1;
  if (!validNurbs) {
    // Fit-points-only splines (or malformed knot vectors): a polyline through
    // the fit points is on-curve but coarse; through control points it's a hull.
    const pts = fit.length >= 2 ? fit : ctrl;
    if (pts.length >= 2) {
      out.push(new PolylineEntity(pts, closed));
      warnings.push("spline imported as a straight-segment approximation");
    }
    return;
  }
  while (weights.length < ctrl.length) weights.push(1);

  const t0 = knots[degree], t1 = knots[knots.length - 1 - degree];
  const nSeg = Math.min(128, Math.max(16, ctrl.length * 4));
  const pts: Vec2[] = [];
  for (let i = 0; i <= nSeg; i++) {
    pts.push(evalNurbs(ctrl, weights, knots, degree, t0 + ((t1 - t0) * i) / nSeg));
  }
  // A periodic/closed spline returns to its start — store as a closed polyline.
  const isLoop = Math.hypot(pts[0].x - pts[nSeg].x, pts[0].y - pts[nSeg].y) < 1e-6;
  if (isLoop) pts.pop();
  out.push(new PolylineEntity(pts, closed || isLoop));
  warnings.push("spline tessellated to a polyline");
}

function parseEllipse(m: Map<number, number>, out: Entity[], warnings: string[]): void {
  const c = { x: num(m, 10), y: num(m, 20) };
  const major = { x: num(m, 11), y: num(m, 21) }; // endpoint relative to center
  const ratio = num(m, 40, 1);
  const u0 = num(m, 41, 0);
  let u1 = num(m, 42, Math.PI * 2);
  if (u1 <= u0) u1 += Math.PI * 2;
  // A valid ellipse sweeps at most one full turn. Clamp the span to 2π so a
  // malformed or hostile end-parameter (code 42, e.g. 1e12) can't blow nSeg —
  // and the tessellation loop below — up to billions of iterations (a hang/OOM
  // DoS on import).
  const span = Math.min(u1 - u0, Math.PI * 2);
  const full = Math.abs(span - Math.PI * 2) < 1e-9;
  // point(u) = c + major·cos u + minor·sin u, minor ⟂ major scaled by ratio
  const minor = { x: -major.y * ratio, y: major.x * ratio };
  const nSeg = Math.max(8, Math.ceil(64 * (span / (Math.PI * 2))));
  const pts: Vec2[] = [];
  const last = full ? nSeg - 1 : nSeg; // closed loop: skip duplicate end point
  for (let i = 0; i <= last; i++) {
    const u = u0 + (span * i) / nSeg;
    pts.push({
      x: c.x + major.x * Math.cos(u) + minor.x * Math.sin(u),
      y: c.y + major.y * Math.cos(u) + minor.y * Math.sin(u),
    });
  }
  out.push(new PolylineEntity(pts, full));
  warnings.push("ellipse tessellated to a polyline");
}

// ---------------------------------------------------------------------------
// Section / entity walking
// ---------------------------------------------------------------------------

interface BlockDef { base: Vec2; start: number; end: number }

interface ParseCtx {
  tags: Tag[];
  blocks: Map<string, BlockDef>;
  warnings: string[];
  /** Skipped entity type → count (summarized into one warning at the end). */
  skipped: Map<string, number>;
  extrusionWarned: boolean;
}

const SKIP_SILENTLY = new Set(["SEQEND", "VIEWPORT", "ATTDEF", "ATTRIB"]);

/**
 * Parse the entities in tags[start..end) into `out`. Used for both the
 * ENTITIES section and (recursively, via INSERT) block bodies.
 */
function parseEntityRange(
  ctx: ParseCtx, start: number, end: number, out: Entity[], depth: number,
): void {
  let i = nextEntityStart(ctx.tags, start);
  while (i < end) {
    const type = ctx.tags[i].value.trim().toUpperCase();
    let next = nextEntityStart(ctx.tags, i + 1);

    // Legacy POLYLINE owns the VERTEX entities that follow, up to SEQEND.
    if (type === "POLYLINE") {
      const flags = num(collect(ctx.tags, i + 1, next), 70, 0);
      const verts: DxfVertex[] = [];
      while (next < end && ctx.tags[next].value.trim().toUpperCase() === "VERTEX") {
        const vEnd = nextEntityStart(ctx.tags, next + 1);
        const vm = collect(ctx.tags, next + 1, vEnd);
        verts.push({ p: { x: num(vm, 10), y: num(vm, 20) }, bulge: num(vm, 42) });
        next = vEnd;
      }
      if (next < end && ctx.tags[next].value.trim().toUpperCase() === "SEQEND") {
        next = nextEntityStart(ctx.tags, next + 1);
      }
      emitPolyline(verts, (flags & 1) !== 0, out);
      i = next;
      continue;
    }

    const m = collect(ctx.tags, i + 1, next);

    // Paper-space entities are layout furniture, not part geometry.
    if (num(m, 67, 0) === 1) {
      bumpSkip(ctx, `paper-space ${type}`);
      i = next;
      continue;
    }
    // A flipped extrusion direction (group 230 < 0) mirrors the entity in the
    // full OCS treatment; we import as-authored and tell the user once.
    if (m.has(230) && num(m, 230, 1) < 0 && !ctx.extrusionWarned) {
      ctx.warnings.push("entities with a mirrored extrusion direction were imported without reorientation — verify their placement");
      ctx.extrusionWarned = true;
    }

    switch (type) {
      case "LINE":
        out.push(new LineEntity(
          { x: num(m, 10), y: num(m, 20) },
          { x: num(m, 11), y: num(m, 21) },
        ));
        break;
      case "CIRCLE":
        out.push(new CircleEntity({ x: num(m, 10), y: num(m, 20) }, num(m, 40)));
        break;
      case "ARC":
        // DXF arcs are CCW from start to end angle, in degrees — same sweep
        // convention as ArcEntity, just converted to radians.
        out.push(new ArcEntity(
          { x: num(m, 10), y: num(m, 20) }, num(m, 40),
          num(m, 50) * DEG, num(m, 51) * DEG,
        ));
        break;
      case "POINT":
        out.push(new PointEntity({ x: num(m, 10), y: num(m, 20) }));
        break;
      case "LWPOLYLINE":
        parseLwPolyline(ctx.tags, i + 1, next, out);
        break;
      case "SPLINE":
        parseSpline(ctx.tags, i + 1, next, out, ctx.warnings);
        break;
      case "ELLIPSE":
        parseEllipse(m, out, ctx.warnings);
        break;
      case "INSERT":
        parseInsert(ctx, i + 1, next, out, depth);
        break;
      default:
        if (!SKIP_SILENTLY.has(type)) bumpSkip(ctx, type);
        break;
    }
    i = next;
  }
}

function bumpSkip(ctx: ParseCtx, type: string): void {
  ctx.skipped.set(type, (ctx.skipped.get(type) ?? 0) + 1);
}

function parseInsert(
  ctx: ParseCtx, start: number, end: number, out: Entity[], depth: number,
): void {
  if (depth > 8) {
    ctx.warnings.push("block nesting deeper than 8 levels — inner blocks skipped");
    return;
  }
  let name = "";
  for (let i = start; i < end; i++) {
    if (ctx.tags[i].code === 2) { name = ctx.tags[i].value.trim(); break; }
  }
  const m = collect(ctx.tags, start, end);
  const block = ctx.blocks.get(name);
  if (!block) {
    ctx.warnings.push(`block "${name}" referenced but not defined — skipped`);
    return;
  }
  const sx = num(m, 41, 1), sy = num(m, 42, 1);
  if (Math.abs(Math.abs(sx) - Math.abs(sy)) > 1e-9 * Math.max(1, Math.abs(sx))) {
    ctx.warnings.push(`block "${name}" uses non-uniform scale (${sx}×${sy}) — skipped`);
    return;
  }
  if (num(m, 70, 1) > 1 || num(m, 71, 1) > 1) {
    ctx.warnings.push(`block "${name}" is an array insert — only the first copy imported`);
  }
  // Mirrored inserts (sx·sy < 0) flip handedness — a 2D transform we don't
  // model. Import the unmirrored shape and warn. (sx = sy = -1 is fine: a
  // point reflection is just a 180° rotation, handled by xformEntity.)
  let s = sx;
  if (sx * sy < 0) {
    ctx.warnings.push(`block "${name}" is mirrored — imported without the mirror`);
    s = Math.abs(sx);
  }
  const rot = num(m, 50, 0) * DEG;
  const ins = { x: num(m, 10), y: num(m, 20) };
  // p' = ins + R(rot)·(s·(p − base))  →  fold base into the translation term.
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const bx = block.base.x * s, by = block.base.y * s;
  const t: Xform = {
    s, rot,
    tx: ins.x - (bx * cos - by * sin),
    ty: ins.y - (bx * sin + by * cos),
  };
  const inner: Entity[] = [];
  parseEntityRange(ctx, block.start, block.end, inner, depth + 1);
  for (const e of inner) xformEntity(e, t);
  out.push(...inner);
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/** $INSUNITS code → mm per drawing unit. */
const INSUNITS_TO_MM: Record<number, number> = {
  1: 25.4,       // inches
  2: 304.8,      // feet
  4: 1,          // millimeters
  5: 10,         // centimeters
  6: 1000,       // meters
  8: 0.0000254,  // microinches
  9: 0.0254,     // mils
  10: 914.4,     // yards
  13: 0.001,     // microns
  14: 100,       // decimeters
};

function readUnits(tags: Tag[], warnings: string[]): number {
  for (let i = 0; i + 1 < tags.length; i++) {
    if (tags[i].code === 9 && tags[i].value.trim() === "$INSUNITS") {
      // The variable's value is the next code-70 tag.
      for (let j = i + 1; j < tags.length && tags[j].code !== 9 && tags[j].code !== 0; j++) {
        if (tags[j].code === 70) {
          const code = parseInt(tags[j].value.trim(), 10);
          const k = INSUNITS_TO_MM[code];
          if (k !== undefined) return k;
          warnings.push(
            code === 0
              ? "file specifies no units — coordinates treated as millimeters"
              : `unsupported $INSUNITS value ${code} — coordinates treated as millimeters`,
          );
          return 1;
        }
      }
    }
  }
  warnings.push("file specifies no units — coordinates treated as millimeters");
  return 1;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function importDxf(text: string): DxfImportResult {
  if (text.startsWith("AutoCAD Binary DXF")) {
    throw new Error("binary DXF is not supported — re-export as ASCII DXF");
  }
  const tags = tokenize(text);
  const warnings: string[] = [];

  // Locate sections. A section spans SECTION..ENDSEC; its name is the code-2
  // tag right after SECTION.
  const blocks = new Map<string, BlockDef>();
  let entStart = -1, entEnd = -1;
  let i = nextEntityStart(tags, 0);
  while (i < tags.length) {
    const v = tags[i].value.trim().toUpperCase();
    const next = nextEntityStart(tags, i + 1);
    if (v === "SECTION" && next < tags.length) {
      // find section name
      let name = "";
      for (let j = i + 1; j < next; j++) {
        if (tags[j].code === 2) { name = tags[j].value.trim().toUpperCase(); break; }
      }
      // find matching ENDSEC
      let k = next;
      while (k < tags.length && tags[k].value.trim().toUpperCase() !== "ENDSEC") {
        k = nextEntityStart(tags, k + 1);
      }
      if (name === "ENTITIES") { entStart = next; entEnd = k; }
      if (name === "BLOCKS") collectBlocks(tags, next, k, blocks);
      i = nextEntityStart(tags, k + 1);
    } else {
      i = next;
    }
  }
  if (entStart < 0) throw new Error("no ENTITIES section found — not a valid DXF file");

  const unitScale = readUnits(tags, warnings);

  const ctx: ParseCtx = { tags, blocks, warnings, skipped: new Map(), extrusionWarned: false };
  const entities: Entity[] = [];
  parseEntityRange(ctx, entStart, entEnd, entities, 0);

  if (unitScale !== 1) {
    const t: Xform = { s: unitScale, rot: 0, tx: 0, ty: 0 };
    for (const e of entities) xformEntity(e, t);
  }

  if (ctx.skipped.size > 0) {
    const parts = [...ctx.skipped.entries()].map(([t, n]) => (n > 1 ? `${n}× ${t}` : t));
    warnings.push(`unsupported entities skipped: ${parts.join(", ")}`);
  }
  return { entities, warnings };
}

function collectBlocks(tags: Tag[], start: number, end: number, blocks: Map<string, BlockDef>): void {
  let i = nextEntityStart(tags, start);
  while (i < end) {
    if (tags[i].value.trim().toUpperCase() === "BLOCK") {
      const bodyStart = nextEntityStart(tags, i + 1);
      let name = "";
      const base = { x: 0, y: 0 };
      for (let j = i + 1; j < bodyStart; j++) {
        const { code, value } = tags[j];
        if (code === 2 && !name) name = value.trim();
        else if (code === 10) base.x = parseFloat(value);
        else if (code === 20) base.y = parseFloat(value);
      }
      // Block body runs to its ENDBLK.
      let k = bodyStart;
      while (k < end && tags[k].value.trim().toUpperCase() !== "ENDBLK") {
        k = nextEntityStart(tags, k + 1);
      }
      if (name) blocks.set(name, { base, start: bodyStart, end: k });
      i = nextEntityStart(tags, k + 1);
    } else {
      i = nextEntityStart(tags, i + 1);
    }
  }
}
