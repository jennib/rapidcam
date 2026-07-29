/**
 * Apollo — a pre-flight linter for generated G-code.
 *
 * The generator is trusted, but the *settings* that feed it aren't: a stray
 * plunge rate, a cut that wanders off the stock, a multi-tool job with the
 * manual-change pause left commented out. These are cheap predicates over the
 * motion the program actually commands, and catching them before the file
 * reaches the machine is the difference between a scrapped part (or a snapped
 * cutter) and a caught mistake.
 *
 * The linter parses the emitted text back into position-resolved moves — its own
 * modal-aware pass, NOT {@link ../cam/gcodeMotion}'s tiling parser, because that
 * one treats every commented line as opaque (for byte-preservation) and the
 * generator attaches comments to real moves (`G0 X.. Y.. ; park for tool
 * change`). We must track position *through* those, or a park/return move that
 * wanders off the stock would slip past the bounds check.
 *
 * Everything the checks need is expressed in the SAME emitted coordinates the
 * G-code uses (post origin/offset), assembled by {@link buildLintContext} from
 * the document, so the checks themselves are pure geometry over the move stream
 * and unit-testable with hand-built contexts.
 */

import type { CADDocument } from "../model/document";
import { resolveOrigin, stockFootprint } from "../model/document";
import { fixturePolygons, type Fixture } from "./fixtures";
import { checkMachinability } from "./machinability";

export type LintSeverity = "error" | "warning";

export interface LintFinding {
  /** Stable machine-readable slug (for analytics / tests). */
  code: string;
  severity: LintSeverity;
  /** Complete, human-readable sentence — shown as-is in the pre-flight dialog. */
  message: string;
  /** 1-based source line of the first offending move, when applicable. */
  line?: number;
  /** Geometry involved in the finding, for canvas highlight while the
   *  pre-flight dialog is up; absent when not applicable (move-stream checks). */
  entityIds?: string[];
}

export interface LintContext {
  /** Stock/work envelope in emitted (post-origin) XY coordinates. */
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number };
  /** Emitted Z of the stock top (Z the tool reaches the surface at). */
  zTop: number;
  /** Emitted Z of the stock bottom (below this cuts into the spoilboard). */
  zBottom: number;
  /** Workholding keep-outs in emitted (post-origin) coords; empty when none. */
  fixtures?: Fixture[];
  /**
   * Machine travel envelope (mm), or absent when the user hasn't configured one
   * — absent is the default and simply skips the fit check.
   */
  bed?: { width: number; height: number } | null;
  machineKind: "mill" | "laser";
  /**
   * Source document, for document-level checks that reason about geometry and
   * operations rather than the move stream (machinability). Optional so
   * hand-built test contexts simply skip those checks. On multi-program jobs
   * (flip sides) the doc-level findings repeat per program — accepted for now
   * (aiCheck dedupes); the once-only home would be postPrograms.
   */
  doc?: CADDocument;
}

/** 10µm — comfortably above the generator's 3-decimal rounding, well below any real hazard. */
const EPS = 0.01;

/** How far past the stock bottom a cut may reach before it's worth a warning. A
 *  deliberate through-cut kisses the spoilboard by a fraction of a mm; only a
 *  gross overshoot (wrong depth / units) clears this. */
const OVERCUT_TOLERANCE = 1.0;

interface Move {
  line: number; // 1-based source line
  motion: 0 | 1 | 2 | 3; // G0 rapid / G1 feed / G2 CW arc / G3 CCW arc
  px: number;
  py: number;
  pz: number; // absolute position before this move
  x: number;
  y: number;
  z: number; // absolute position after
  hasX: boolean;
  hasY: boolean;
  hasZ: boolean;
  f: number; // active (modal) feed rate for this move
}

/**
 * Parse a program into absolute moves, tracking modal motion / feed / position
 * across ALL lines — including move lines that carry a trailing comment. The
 * starting Z is assumed to be the stock top (we can't know the true machine
 * position; the surface is the neutral assumption that neither invents a gouge
 * nor hides a genuine missing first retract).
 */
function parseMoves(gcode: string, zTop: number): Move[] {
  const moves: Move[] = [];
  let x = 0,
    y = 0,
    z = zTop,
    f = 0;
  let motion: 0 | 1 | 2 | 3 | null = null;
  let lineNo = 0;

  for (const raw of gcode.split(/\r?\n/)) {
    lineNo++;
    const code = raw.split(";")[0].trim(); // strip any trailing comment
    if (!code) continue;
    const tokens = code.split(/\s+/);

    let hasX = false,
      hasY = false,
      hasZ = false,
      sawCoord = false;
    let nextMotion: 0 | 1 | 2 | 3 | null = motion;

    for (const t of tokens) {
      const letter = t[0]?.toUpperCase();
      const val = parseFloat(t.slice(1));
      if (letter === "G" && !Number.isNaN(val)) {
        const g = Math.round(val);
        if (g === 0 || g === 1 || g === 2 || g === 3) nextMotion = g;
        // Non-motion G-words (G17/G20/G21/G90/…) leave the modal motion untouched.
        continue;
      }
      if (Number.isNaN(val)) continue;
      switch (letter) {
        case "X":
          x = val;
          hasX = true;
          sawCoord = true;
          break;
        case "Y":
          y = val;
          hasY = true;
          sawCoord = true;
          break;
        case "Z":
          z = val;
          hasZ = true;
          sawCoord = true;
          break;
        case "F":
          f = val;
          break;
      }
    }

    motion = nextMotion;
    // A move is emitted only when this line carried coordinates under an active
    // motion mode (a bare `F1000` or a `G90` line moves nothing). The "before"
    // position (px/py/pz) is threaded in afterwards from the prior move.
    if (sawCoord && motion !== null) {
      moves.push({ line: lineNo, motion, px: 0, py: 0, pz: 0, x, y, z, hasX, hasY, hasZ, f });
    }
  }

  // Thread each move's "before" position from the previous move's "after"
  // (simpler and less error-prone than tracking it inline through the modal words).
  let prevX = 0,
    prevY = 0,
    prevZ = zTop;
  for (const m of moves) {
    m.px = prevX;
    m.py = prevY;
    m.pz = prevZ;
    prevX = m.x;
    prevY = m.y;
    prevZ = m.z;
  }
  return moves;
}

/** Round for display without trailing-zero noise. */
function r(v: number): string {
  return parseFloat(v.toFixed(2)).toString();
}

// --- individual checks -------------------------------------------------------

/** ERROR: a rapid (G0) that travels in X or Y while the tool is below the stock
 *  top — the tool ploughs sideways through material (also the tell-tale of a
 *  missing retract / unsafe safe-Z between moves). */
function checkRapidThroughStock(moves: Move[], ctx: LintContext): LintFinding | null {
  let first: Move | null = null,
    count = 0;
  for (const m of moves) {
    if (m.motion !== 0) continue;
    if (!m.hasX && !m.hasY) continue; // a pure Z retract is fine
    if (Math.min(m.pz, m.z) < ctx.zTop - EPS) {
      // below the surface during a rapid
      count++;
      if (!first) first = m;
    }
  }
  if (!first) return null;
  return {
    code: "rapid-through-stock",
    severity: "error",
    line: first.line,
    message:
      `${count} rapid move${count > 1 ? "s" : ""} travel sideways below the stock top ` +
      `(first at line ${first.line}, Z${r(Math.min(first.pz, first.z))}). The tool would ` +
      `plough through material at rapid speed — a retract to safe Z is missing.`,
  };
}

/**
 * ERROR: a move whose XY leaves the stock envelope *while the tool engages the
 * material*. On a mill that means at/below the surface — a safe-Z rapid to a
 * park or end position deliberately off the work is fine and shouldn't nag. A
 * laser has no Z, so every move is in-plane and counts.
 */
function checkOutOfBounds(moves: Move[], ctx: LintContext): LintFinding | null {
  const { xMin, xMax, yMin, yMax } = ctx.bounds;
  const engaged = (m: Move) => ctx.machineKind === "laser" || Math.min(m.pz, m.z) < ctx.zTop - EPS;
  let first: Move | null = null,
    count = 0;
  for (const m of moves) {
    // No hasX/hasY guard: a pure-Z plunge still leaves the tool at (x,y), and
    // that's exactly where an off-stock plunge engages. Aggregation dedupes the
    // noise of repeated moves at one out-of-bounds spot.
    if (!engaged(m)) continue;
    const out = m.x < xMin - EPS || m.x > xMax + EPS || m.y < yMin - EPS || m.y > yMax + EPS;
    if (out) {
      count++;
      if (!first) first = m;
    }
  }
  if (!first) return null;
  return {
    code: "out-of-bounds",
    severity: "error",
    line: first.line,
    message:
      `${count} move${count > 1 ? "s" : ""} travel outside the stock ` +
      `(${r(xMin)}…${r(xMax)} × ${r(yMin)}…${r(yMax)} mm; first at line ${first.line}, ` +
      `X${r(first.x)} Y${r(first.y)}). Check the toolpath fits the material.`,
  };
}

/** WARNING: a cut move dips below the stock bottom — through-cut into the spoilboard. */
function checkOverDeep(moves: Move[], ctx: LintContext): LintFinding | null {
  let first: Move | null = null,
    deepest = Infinity;
  for (const m of moves) {
    if (m.motion === 0) continue; // rapids handled elsewhere
    if (m.z < ctx.zBottom - OVERCUT_TOLERANCE) {
      if (!first) first = m;
      deepest = Math.min(deepest, m.z);
    }
  }
  if (!first) return null;
  const below = ctx.zBottom - deepest;
  return {
    code: "over-deep",
    severity: "warning",
    line: first.line,
    message:
      `Cuts reach ${r(below)}mm below the stock bottom (into the spoilboard) — ` +
      `first at line ${first.line}. Fine for a through-cut on a sacrificial board; ` +
      `otherwise reduce the depth.`,
  };
}

/** WARNING: a pure vertical plunge fed as fast as (or faster than) the cutting
 *  feed. Ramped entries move laterally and are intentionally left alone. */
function checkFastPlunge(moves: Move[]): LintFinding | null {
  let lastHorizFeed = 0;
  let first: Move | null = null,
    count = 0;
  for (const m of moves) {
    const lateral = m.hasX || m.hasY;
    if (m.motion === 1 && lateral) lastHorizFeed = m.f || lastHorizFeed;
    // Pure downward Z feed (no lateral component) = a straight plunge.
    if (m.motion === 1 && m.hasZ && !lateral && m.z < m.pz - EPS) {
      if (lastHorizFeed > 0 && m.f >= lastHorizFeed - EPS) {
        count++;
        if (!first) first = m;
      }
    }
  }
  if (!first) return null;
  return {
    code: "fast-plunge",
    severity: "warning",
    line: first.line,
    message:
      `${count} plunge${count > 1 ? "s" : ""} descend at F${r(first.f)} — at or above the ` +
      `cutting feed (first at line ${first.line}). Plunging straight down this fast loads ` +
      `the tool tip; lower the plunge rate or add a ramp/helix entry.`,
  };
}

/** WARNING: a manual tool change is required but nothing pauses the machine for it. */
function checkMissingToolChange(gcode: string): LintFinding | null {
  const lines = gcode.split(/\r?\n/);
  let manualMarker: number | null = null;
  let activePause = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/Manual tool change to T/i.test(raw) && manualMarker === null) manualMarker = i + 1;
    const code = raw.split(";")[0].trim(); // active = not commented out
    if (/^M0{1,2}\b/.test(code) || /\bM6\b/.test(code)) activePause = true;
  }
  if (manualMarker === null || activePause) return null;
  return {
    code: "missing-tool-change",
    severity: "warning",
    line: manualMarker,
    message:
      `The job needs a manual tool change (line ${manualMarker}) but has no active pause — ` +
      `the machine won't stop for the swap. Uncomment the M0, or your sender must pause on it.`,
  };
}

/** Ray-cast point-in-polygon (footprint edges, work/emitted mm). */
function pointInPoly(x: number, y: number, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x,
      yi = poly[i].y,
      xj = poly[j].x,
      yj = poly[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Whether segments AB and CD properly intersect (shared parametric solve). */
function segCross(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const den = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (Math.abs(den) < 1e-12) return false;
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / den;
  const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/** Whether the segment A→B touches a polygon (endpoint inside, or crosses an edge). */
function segHitsPoly(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  poly: { x: number; y: number }[],
): boolean {
  if (pointInPoly(ax, ay, poly) || pointInPoly(bx, by, poly)) return true;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (segCross(ax, ay, bx, by, poly[j].x, poly[j].y, poly[i].x, poly[i].y)) return true;
  }
  return false;
}

/**
 * ERROR: the toolpath crosses a fixture/clamp footprint at a height that would hit
 * it. A clamp's top is `zTop + height` above the stock; a move whose lowest Z sits
 * below that (a cut, or a rapid at a safe-Z shorter than the clamp) and whose path
 * enters the footprint is a collision. This tests the tool's *path* only — the
 * holder/collet is intentionally not modelled.
 */
function checkFixtures(moves: Move[], ctx: LintContext): LintFinding | null {
  const fixtures = ctx.fixtures;
  if (!fixtures || fixtures.length === 0) return null;
  let count = 0;
  let first: number | undefined;
  for (const m of moves) {
    const lowZ = Math.min(m.pz, m.z);
    for (const f of fixtures) {
      if (lowZ >= ctx.zTop + f.height - EPS) continue; // clears the clamp top
      if (segHitsPoly(m.px, m.py, m.x, m.y, f.poly)) {
        count++;
        if (first === undefined) first = m.line;
        break;
      }
    }
  }
  if (count === 0) return null;
  return {
    code: "fixture-collision",
    severity: "error",
    line: first,
    message:
      `The toolpath crosses the workholding: ${count} move${count > 1 ? "s" : ""} take the tool over a fixture/clamp ` +
      `(first at line ${first}) below the clamp height. Move the clamp clear of the toolpaths, raise safe Z above the clamp, or keep cuts off it.`,
  };
}

/**
 * ERROR: the job needs more travel than the machine has.
 *
 * What is measured is how far the program travels FROM THE WORK ORIGIN, because
 * the move stream is anchored there (X0 Y0 = wherever the operator touched off,
 * see the parser's initial position). So a program reaching X900 genuinely needs
 * 900mm of X travel, and no choice of zero changes that.
 *
 * What is NOT knowable here is where the work origin sits on the table — nothing
 * in the file records it. So this cannot say "you will hit the left rail"; it can
 * only say "this needs more travel than the machine has". Necessary, not
 * sufficient: passing means the job *could* fit, not that it is placed safely.
 *
 * Skipped entirely when no bed is configured, which is the default.
 */
function checkBedTravel(moves: Move[], ctx: LintContext): LintFinding | null {
  const bed = ctx.bed;
  if (!bed || moves.length === 0) return null;
  let xMin = Number.POSITIVE_INFINITY,
    xMax = Number.NEGATIVE_INFINITY,
    yMin = Number.POSITIVE_INFINITY,
    yMax = Number.NEGATIVE_INFINITY;
  for (const m of moves) {
    // Both ends of every move: a span is defined by where the tool actually goes.
    xMin = Math.min(xMin, m.px, m.x);
    xMax = Math.max(xMax, m.px, m.x);
    yMin = Math.min(yMin, m.py, m.y);
    yMax = Math.max(yMax, m.py, m.y);
  }
  const spanX = xMax - xMin;
  const spanY = yMax - yMin;
  const overX = spanX > bed.width + EPS;
  const overY = spanY > bed.height + EPS;
  if (!overX && !overY) return null;
  const parts: string[] = [];
  if (overX) parts.push(`${r(spanX)}mm of X travel (machine has ${r(bed.width)}mm)`);
  if (overY) parts.push(`${r(spanY)}mm of Y travel (machine has ${r(bed.height)}mm)`);
  return {
    code: "exceeds-machine-travel",
    severity: "error",
    message:
      `This job needs ${parts.join(" and ")}. It cannot run on this machine wherever you zero it. ` +
      `Shrink the part, split the job (Tile), or correct the bed size in Machine Settings.`,
  };
}

/**
 * WARNING: an operation bound to no geometry. It emits no motion, so the
 * move-stream checks can't see it — but it silently cuts nothing (typically the
 * shape it was bound to was deleted later). Doc-level, so it needs `ctx.doc`.
 */
function checkEmptyOps(doc: CADDocument): LintFinding | null {
  const empty = doc.operations.filter(
    (op) => op.entityIds.length === 0 && (op.regions?.length ?? 0) === 0,
  );
  if (empty.length === 0) return null;
  const names = empty.map((o) => `"${o.name}"`).join(", ");
  return {
    code: "empty-toolpath",
    severity: "warning",
    message:
      `${empty.length} toolpath${empty.length > 1 ? "s" : ""} (${names}) ` +
      `${empty.length > 1 ? "have" : "has"} no geometry and will cut nothing — the shape ` +
      `it was bound to may have been deleted. Reassign geometry or remove the toolpath.`,
  };
}

/**
 * Lint a generated G-code program against its document-derived context. Returns
 * findings ordered errors-first; an empty array means the program passed.
 */
export function lintGCode(gcode: string, ctx: LintContext): LintFinding[] {
  const moves = parseMoves(gcode, ctx.zTop);
  const findings: (LintFinding | null)[] = [];

  // XY bounds apply to every machine; the Z-based checks are milling-only (a
  // laser has no Z axis — no plunge, no depth, no through-cut).
  findings.push(checkOutOfBounds(moves, ctx));
  // Empty-toolpath is doc-level and machine-agnostic (an empty cut/engrave on a
  // laser cuts nothing too); the move stream can't see it since it emits none.
  if (ctx.doc) findings.push(checkEmptyOps(ctx.doc));
  if (ctx.machineKind !== "laser") {
    findings.push(checkRapidThroughStock(moves, ctx));
    findings.push(checkOverDeep(moves, ctx));
    findings.push(checkFastPlunge(moves));
    findings.push(checkFixtures(moves, ctx));
    findings.push(checkBedTravel(moves, ctx));
    findings.push(checkMissingToolChange(gcode));
    // Document-level: geometry the ops' tools can't reach (silent at toolpath
    // time — the offset just swallows narrow features). Needs the doc, so
    // hand-built contexts without one skip it.
    if (ctx.doc) findings.push(...checkMachinability(ctx.doc));
  }

  const order: Record<LintSeverity, number> = { error: 0, warning: 1 };
  return findings
    .filter((f): f is LintFinding => f !== null)
    .sort((a, b) => order[a.severity] - order[b.severity]);
}

/** Assemble a {@link LintContext} in emitted coordinates from the document. */
export function buildLintContext(
  doc: CADDocument,
  opts: {
    /**
     * Extra depth (mm) a program is *allowed* to cut below the stock bottom
     * before the over-deep check fires — for a program that intentionally bores
     * past the stock (e.g. double-sided registration pin holes into the
     * spoilboard). Lowers the effective `zBottom` by this much.
     */
    extraDepthBelowBottom?: number;
    /** Machine travel envelope; omit/null to skip the fit check. */
    bed?: { width: number; height: number } | null;
  } = {},
): LintContext {
  const { ox, oy, zOffset } = resolveOrigin(doc);
  const { width, height } = stockFootprint(doc);
  // Fixture footprints shifted into emitted (post-origin) coords to match the moves.
  const fixtures: Fixture[] =
    doc.isLaser
      ? []
      : fixturePolygons(doc).map((f) => ({
          poly: f.poly.map((p) => ({ x: p.x - ox, y: p.y - oy })),
          height: f.height,
        }));
  return {
    bounds: {
      xMin: 0 - ox,
      xMax: width - ox,
      yMin: 0 - oy,
      yMax: height - oy,
    },
    zTop: zOffset,
    zBottom: zOffset - doc.stockThickness - (opts.extraDepthBelowBottom ?? 0),
    fixtures,
    bed: opts.bed ?? null,
    machineKind: doc.isLaser ? "laser" : "mill",
    doc,
  };
}
