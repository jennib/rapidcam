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
import { resolveOrigin, stockFootprint, isLaser } from "../model/document";
import { fixturePolygons, type Fixture } from "./fixtures";
import { lexWords } from "./gcodeWords";
import { hiddenOpEntityIds, isMachinable } from "./machinable";
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
  /** G93 (inverse-time) active for this move — see {@link checkFastPlunge}: F is
   *  1/minutes-for-the-whole-move under G93, not mm/min, so it is NOT comparable
   *  across moves of different lengths the way a G94 feed rate is. */
  invTime: boolean;
  /**
   * G53 was on this line, so its coordinates are raw MACHINE position rather than
   * work position. Nothing in the program records where the work origin sits on
   * the table (the same limit {@link checkBedTravel} documents), so these
   * coordinates cannot be compared against the stock envelope, the stock top, or
   * the fixtures — all of which are expressed in work/emitted coordinates. Every
   * work-frame check therefore skips these moves.
   *
   * Unlike G93/G94 this is NOT modal: G53 applies to its own line only, so the
   * flag is per-line and never carried forward.
   */
  machineFrame: boolean;
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
  // G94 (feed-per-minute) is the controller's power-up default; G93 (inverse-time,
  // rotary combined moves — see cam/klein.ts) is modal once emitted and stays
  // active across every line until an explicit G94, same as motion/feed.
  let invTime = false;
  let lineNo = 0;

  for (const raw of gcode.split(/\r?\n/)) {
    lineNo++;
    // Scan words rather than whitespace-separated tokens. Splitting on spaces
    // read `G0X10Y20` — legal on GRBL, and typed by hand into the custom program
    // start/end blocks — as ONE token whose coordinates were then dropped
    // entirely, so that move was invisible to every check below. See cam/gcodeWords.
    const words = lexWords(raw);
    if (words.length === 0) continue;

    let hasX = false,
      hasY = false,
      hasZ = false,
      sawCoord = false;
    // Per-line, never carried forward: G53 is non-modal.
    let machineFrame = false;
    // Work-frame position before this line, so a G53 line can be recorded without
    // its machine coordinates leaking into the position later lines are judged
    // against. See the restore below.
    const wasX = x,
      wasY = y,
      wasZ = z;
    let nextMotion: 0 | 1 | 2 | 3 | null = motion;

    for (const { letter, value: val } of words) {
      if (letter === "G") {
        const g = Math.round(val);
        if (g === 0 || g === 1 || g === 2 || g === 3) nextMotion = g;
        else if (g === 53) machineFrame = true;
        else if (g === 93) invTime = true;
        else if (g === 94) invTime = false;
        // Other non-motion G-words (G17/G20/G21/G90/…) leave modal state untouched.
        continue;
      }
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
      moves.push({
        line: lineNo,
        motion,
        px: 0,
        py: 0,
        pz: 0,
        x,
        y,
        z,
        hasX,
        hasY,
        hasZ,
        f,
        invTime,
        machineFrame,
      });
    }

    // Where the tool sits in WORK coordinates after a G53 move is unknowable —
    // nothing in the program records the offset between the two frames. Carrying
    // the machine numbers forward is worse than admitting that: a `G53 G0 Z-5`
    // retract left the NEXT move with a "before" Z of −5, so an innocent `G0 Z5`
    // read as engaged in material at whatever XY was current, and on a stock that
    // does not straddle the origin that produced a confident out-of-bounds error
    // — on the machine-coordinate retract this app's own Machine Settings
    // recommends. Leaving the work-frame position untouched is the honest
    // approximation: the tool has moved, but not to anywhere we can name.
    if (machineFrame) {
      x = wasX;
      y = wasY;
      z = wasZ;
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
    // A machine-frame move stores coordinates in the OTHER frame, so propagating
    // them as the next move's "before" position is what actually produced the
    // false out-of-bounds error — the parse loop's restore alone cannot fix it,
    // because this pass reads the stored move, not the running position.
    if (m.machineFrame) continue;
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
    if (m.machineFrame) continue; // machine-frame Z says nothing about the stock top
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
  const engaged = (m: Move) => isLaser(ctx.machineKind) || Math.min(m.pz, m.z) < ctx.zTop - EPS;
  let first: Move | null = null,
    count = 0;
  for (const m of moves) {
    // No hasX/hasY guard: a pure-Z plunge still leaves the tool at (x,y), and
    // that's exactly where an off-stock plunge engages. Aggregation dedupes the
    // noise of repeated moves at one out-of-bounds spot.
    if (m.machineFrame) continue; // machine coordinates, not comparable to the stock
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
    if (m.machineFrame) continue; // machine-frame Z is not a depth into the stock
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
    // Under G93 (inverse-time — a rotary combined-move job, cam/klein.ts) F is
    // 1/minutes-for-this-move, not mm/min: a short pure-Z plunge naturally gets a
    // LARGER F than a long lateral move at the same true feed, which read as
    // "at or above the cutting feed" every time and warned on ordinary rotary
    // plunges. Not comparable across moves at all, so skip them outright.
    if (m.invTime) continue;
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
 * enters the footprint is a collision.
 *
 * The tool is modelled as a zero-width point at the TIP, and nothing above the tip
 * exists — no shank, no collet, no spindle nose. That under-reports in two
 * directions, and both are ordinary setups rather than exotic ones:
 *
 *  - LATERALLY, a holder is far wider than the cutter, so a pass close beside a
 *    clamp can strike it while the tip's path misses the footprint entirely.
 *  - VERTICALLY, a clamp standing taller than the tool's stickout is at collet
 *    height while the tip is still down in the cut.
 *
 * Modelling either needs a tool stickout and holder diameter the tool library
 * does not carry, so the check stays tip-only — but the MESSAGE has to say so.
 * A bare "clearing them needs Z ≥ 12mm" reads as a guarantee, and this is the
 * one check whose whole job is stopping an expensive collision.
 */
function checkFixtures(moves: Move[], ctx: LintContext): LintFinding | null {
  const fixtures = ctx.fixtures;
  if (!fixtures || fixtures.length === 0) return null;
  let rapids = 0;
  let cuts = 0;
  let first: number | undefined;
  // Highest clamp top actually struck, in emitted Z. Reporting the number the
  // operator would have to clear is the useful half of this check — "raise safe
  // Z above the clamp" does not say how far, and guessing is how you find out
  // the expensive way.
  let needZ = Number.NEGATIVE_INFINITY;
  let unknownHeight = false;
  for (const m of moves) {
    if (m.machineFrame) continue; // fixture polygons are in work/emitted coordinates
    const lowZ = Math.min(m.pz, m.z);
    for (const f of fixtures) {
      const clearAt = ctx.zTop + f.height;
      if (lowZ >= clearAt - EPS) continue; // clears the clamp top
      if (segHitsPoly(m.px, m.py, m.x, m.y, f.poly)) {
        // A G0 is travel and could be lifted over the clamp; a cutting move
        // cannot be, because lifting it would simply not cut the part. The two
        // have completely different remedies, so they are counted separately.
        if (m.motion === 0) rapids++;
        else cuts++;
        if (first === undefined) first = m.line;
        if (Number.isFinite(f.height)) needZ = Math.max(needZ, clearAt);
        else unknownHeight = true;
        break;
      }
    }
  }
  const count = rapids + cuts;
  if (count === 0) return null;

  const what =
    cuts > 0 && rapids > 0
      ? `${cuts} cutting move${cuts > 1 ? "s" : ""} and ${rapids} rapid${rapids > 1 ? "s" : ""}`
      : cuts > 0
        ? `${cuts} cutting move${cuts > 1 ? "s" : ""}`
        : `${rapids} rapid${rapids > 1 ? "s" : ""}`;

  // Cutting into workholding is not a clearance problem and no amount of Z will
  // fix it — say so plainly rather than offering a height that would only make
  // the tool miss the part.
  const advice =
    cuts > 0
      ? "A cutting move cannot be lifted clear — it has to cut there. Move the clamp off the toolpath, or cut that region in a second setup."
      : unknownHeight
        ? "One of these clamps has no height set, so there is no way to know what would clear it. Set a height on the fixture layer."
        : `Clearing them needs Z ≥ ${r(needZ)}mm. Raise safe Z to at least that, or move the clamp off the travel path. ` +
          `That figure is for the tool TIP — the holder is not modelled, so a wide collet, or a clamp taller than the tool's stickout, can still touch.`;

  return {
    code: "fixture-collision",
    severity: "error",
    line: first,
    message:
      `The toolpath crosses the workholding: ${what} pass over a fixture/clamp below its top ` +
      `(first at line ${first}). ${advice}`,
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
    // Mixing machine-frame coordinates into a work-frame span measures neither.
    if (m.machineFrame) continue;
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
 * WARNING: an operation bound to geometry that is hidden, and which CAM
 * therefore did not cut (see machinable.ts).
 *
 * This is the safety net for that policy. Excluding hidden geometry is the
 * behaviour users expect — if it isn't on screen it isn't in the program — but
 * a toolpath that quietly got shorter because a layer was switched off while
 * drafting is exactly how a part gets scrapped. So the exclusion is allowed to
 * happen, and then it is named, with the ids attached so the pre-flight dialog
 * highlights the missing geometry on the canvas.
 */
function checkHiddenGeometry(doc: CADDocument): LintFinding | null {
  const affected = new Map<string, string[]>();
  for (const op of doc.operations) {
    const hidden = hiddenOpEntityIds(doc, op.entityIds);
    if (hidden.length > 0) affected.set(op.name, hidden);
  }
  if (affected.size === 0) return null;

  const ids = [...new Set([...affected.values()].flat())];
  const names = [...affected.keys()].map((n) => `"${n}"`).join(", ");
  return {
    code: "hidden-geometry",
    severity: "warning",
    message:
      `${ids.length} hidden object${ids.length > 1 ? "s are" : " is"} assigned to ` +
      `toolpath${affected.size > 1 ? "s" : ""} ${names} and ${ids.length > 1 ? "were" : "was"} ` +
      `NOT cut — hidden geometry is left out of the program. Show ${ids.length > 1 ? "them" : "it"} ` +
      `in the Design Tree to cut ${ids.length > 1 ? "them" : "it"}, or remove ` +
      `${ids.length > 1 ? "them" : "it"} from the toolpath to silence this.`,
    entityIds: ids,
  };
}

/**
 * WARNING: an operation is bound to workholding geometry — it will machine a
 * clamp.
 *
 * Unlike hidden geometry, this is NOT excluded from the program: operations are
 * explicit, and cutting a sacrificial fixture is a real (if rare) thing to want,
 * so silently dropping the cut would be its own kind of wrong. But nothing else
 * in the app would tell you either, and the documented promise elsewhere is that
 * workholding is not cut — building a job FROM LAYERS does skip fixture layers
 * (see laserJob.ts), so an explicit op is the one path that gets through.
 *
 * A warning rather than an error for the same reason: the tool really will go
 * there, and the operator is the one who knows whether that was the intent.
 */
function checkMachinedFixture(doc: CADDocument): LintFinding | null {
  const fixtureLayers = new Set(doc.layers.filter((l) => l.fixture).map((l) => l.id));
  if (fixtureLayers.size === 0) return null;

  const byId = new Map(doc.entities.map((e) => [e.id, e]));
  const affected = new Map<string, string[]>();
  for (const op of doc.operations) {
    const onFixture = op.entityIds.filter((id) => {
      const e = byId.get(id);
      // A hidden one is already excluded from output and reported by
      // checkHiddenGeometry; warning about it twice would just be noise.
      return !!e && !e.isConstruction && isMachinable(doc, e) && fixtureLayers.has(e.layerId);
    });
    if (onFixture.length > 0) affected.set(op.name, onFixture);
  }
  if (affected.size === 0) return null;

  const ids = [...new Set([...affected.values()].flat())];
  const names = [...affected.keys()].map((n) => `"${n}"`).join(", ");
  return {
    code: "machined-fixture",
    severity: "warning",
    message:
      `Toolpath${affected.size > 1 ? "s" : ""} ${names} will cut ${ids.length} ` +
      `workholding shape${ids.length > 1 ? "s" : ""} — the tool is being sent into a clamp. ` +
      `Remove ${ids.length > 1 ? "them" : "it"} from the toolpath, or move ${ids.length > 1 ? "them" : "it"} ` +
      `off the workholding layer if ${ids.length > 1 ? "they are" : "it is"} really part of the job.`,
    entityIds: ids,
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
  // Also machine-agnostic, and paired with machinable.ts — see that module.
  if (ctx.doc) findings.push(checkHiddenGeometry(ctx.doc));
  // Machine-agnostic too: a laser will happily burn a clamp.
  if (ctx.doc) findings.push(checkMachinedFixture(ctx.doc));
  if (!isLaser(ctx.machineKind)) {
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
  // The stock's corner in CANVAS coordinates — (0,0) only for the legacy
  // "stock fills the work area" case. Since positioned StockRect shipped (the
  // workholding work), the blank can sit anywhere on a larger sheet (room for
  // clamps to overhang), so the bounds must be anchored at the stock's actual
  // corner, not canvas (0,0) — the same sx/sy resolveOrigin already folds into
  // ox/oy. Getting this wrong doesn't just shift the box: on the New Project
  // default (blank centred on a margin-padded sheet) it produced a false
  // "outside the stock" error on geometry that was safely inside on one edge,
  // while silently passing real off-stock moves on the opposite edge.
  const sx = doc.stockRect?.x ?? 0;
  const sy = doc.stockRect?.y ?? 0;
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
      xMin: sx - ox,
      xMax: sx + width - ox,
      yMin: sy - oy,
      yMax: sy + height - oy,
    },
    zTop: zOffset,
    zBottom: zOffset - doc.stockThickness - (opts.extraDepthBelowBottom ?? 0),
    fixtures,
    // A ROTARY job's wrapped axis is not bed travel, so the fit check must not
    // see it. On a laser rotary the wrap is emitted on an ordinary LINEAR word in
    // surface millimetres (cam/klein.ts "linear-substitute" — the rotary is wired
    // in place of that motor with steps/mm rescaled), so a large cylinder looks
    // like metres of travel while the axis just spins in place. On a mill rotary
    // the wrap becomes A/B degrees, which this parser doesn't read at all. Either
    // way the number would be meaningless, so skip the check rather than warn
    // about travel the machine never makes.
    bed: doc.isRotary ? null : (opts.bed ?? null),
    machineKind: doc.isLaser ? "laser" : "mill",
    doc,
  };
}
